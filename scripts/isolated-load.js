import { createServer } from 'node:http';
import { connect as connectTCP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PreviewCore } from '../src/core.js';
import { GuardedEgressProxy } from '../src/egress.js';

// Explicit CI performance gate: real Core.create through the network namespace,
// guarded proxy, fixture server, DOM rendering, interactions and screenshots.
const hardDeadline = setTimeout(() => {
  console.error('FAIL: stress test global deadline exceeded; terminating isolated worker');
  process.exit(124);
}, 180_000);
hardDeadline.unref();
const tiers = (process.env.PFX_LOAD_TIERS || '10,25,50').split(',').map(Number);
if (tiers.some(n => !Number.isInteger(n) || n < 1 || n > 50)) throw new Error('Invalid tier');
const getNumber=async file=>{try {const n=Number((await readFile(file,'utf8')).trim());return Number.isFinite(n)?n:0;}catch{return 0;}};
async function memorySnapshot() {
  for (const [usage, max] of [
    ['/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes','/sys/fs/cgroup/memory/memory.limit_in_bytes']
  ]) {
    const bytes=await getNumber(usage);
    if(bytes>0) return {bytes, capacity:await getNumber(max), source:usage};
  }
  // GitHub-hosted runners may not expose memory.current. Never report zero as
  // a successful measurement; fall back to host MemAvailable information.
  const info=await readFile('/proc/meminfo','utf8');
  const find=k=>Number(info.match(new RegExp(`^${k}:\\s+(\\d+) kB$`,'m'))?.[1] ?? 0)*1024;
  const capacity=find('MemTotal'),available=find('MemAvailable');
  if(!capacity || !available) throw new Error('Memory monitoring unavailable');
  return {bytes:capacity-available, capacity, source:'/proc/meminfo'};
}
const baseline=await memorySnapshot();
const threshold=Math.min(baseline.capacity>0?baseline.capacity*.80:3_000_000_000,5_500_000_000);
const pageHTML='<!doctype html><title>PFx isolated load</title><style>body{font:16px sans-serif;margin:20px}button{padding:12px}</style><button onclick="document.title=\'active\'">Click</button><main>Isolated fixture</main>';
const target=createServer((_req,res)=>res.end(pageHTML));
await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
const targetPort=target.address().port;
const core=new PreviewCore({
  validate:async url=>url,
  config:{maxSessions:50,maxTotalPixels:48_000_000},
  egressFactory:()=>new GuardedEgressProxy({
    resolver:async()=>[{address:'8.8.8.8',family:4}],
    dial:()=>connectTCP({host:'127.0.0.1',port:targetPort})
  })
});
let thresholdExceeded=false;
let peakMemory=0;
const monitor=setInterval(async()=>{
  try {
    const {bytes}=await memorySnapshot();
    peakMemory=Math.max(bytes,peakMemory);
    if(bytes>threshold) thresholdExceeded=true;
  } catch {thresholdExceeded=true;}
},150);
let failed=false;
try {
  await core.start();
  for(const tier of tiers){
    const opened=[];
    let screenshots=0,clicks=0,frames=0;
    const start=performance.now();
    peakMemory=(await memorySnapshot()).bytes;
    try {
      for(let index=0;index<tier;index+=5){
        if(thresholdExceeded) throw new Error('Memory safety threshold reached');
        const batch=await Promise.all(Array.from({length:Math.min(5,tier-index)},()=>core.create({url:'http://preview.example/',width:390,height:640})));
        opened.push(...batch);
        console.log(JSON.stringify({tier,phase:'opening',opened:opened.length,elapsedMs:Math.round(performance.now()-start)}));
      }
      // Validate real interactive content on every session rather than just opening tabs.
      for(const session of opened){
        const page=core.get(session.id).page;
        await page.locator('button').click();
        if(await page.title()!=='active') throw new Error('DOM interaction did not reach expected state');
        clicks++;
      }
      for(const session of opened.slice(0,5)){
        const png=await core.screenshot(session.id);
        if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('Invalid screenshot');
        screenshots++;
      }
      for(const session of opened.slice(0,4)){
        const page=core.get(session.id).page;
        const stop=await core.stream(session.id,()=>{frames++;});
        await page.locator('main').evaluate(el=>{el.textContent='changed';el.style.background='orange';});
        await new Promise(resolve=>setTimeout(resolve,160));
        await stop();
      }
      if(frames<4) throw new Error(`Insufficient real screencast frames: ${frames}`);
      console.log(JSON.stringify({tier,status:'PASS',created:opened.length,clicks,screenshots,frames,elapsedMs:Math.round(performance.now()-start),peakMemoryMiB:Math.round(peakMemory/1048576),memorySource:baseline.source}));
    } catch(error){failed=true;console.error(JSON.stringify({tier,status:'FAIL',created:opened.length,error:error.message,peakMemoryMiB:Math.round(peakMemory/1048576),memorySource:baseline.source}));}
    finally {await Promise.allSettled(opened.map(s=>core.close(s.id)));}
    if(core.sessions.size!==0){failed=true;console.error('Session cleanup incomplete');}
    if(failed || thresholdExceeded)break;
  }
} catch(error){failed=true;console.error(error);}
finally {
  clearInterval(monitor);
  await core.stop().catch(error=>{failed=true;console.error(error);});
  target.closeAllConnections();
  await new Promise(resolve=>target.close(resolve));
}
if(failed || thresholdExceeded)process.exitCode=1;
