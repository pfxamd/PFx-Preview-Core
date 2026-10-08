import { createServer } from 'node:http';
import { connect as connectTCP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PreviewCore } from '../src/core.js';
import { GuardedEgressProxy } from '../src/egress.js';

// Explicit CI performance gate: real Core.create through the network namespace,
// guarded proxy, fixture server, DOM rendering, interactions and screenshots.
const tiers = (process.env.PFX_LOAD_TIERS || '10,25,50').split(',').map(Number);
if (tiers.some(n => !Number.isInteger(n) || n < 1 || n > 50)) throw new Error('Invalid tier');
const getNumber=async file=>{try {const n=Number((await readFile(file,'utf8')).trim());return Number.isFinite(n)?n:0;}catch{return 0;}};
const maxMemory=await getNumber('/sys/fs/cgroup/memory.max');
const threshold=maxMemory>0?Math.min(maxMemory*.8,5_500_000_000):3_000_000_000;
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
const monitor=setInterval(async()=>{const n=await getNumber('/sys/fs/cgroup/memory.current');peakMemory=Math.max(n,peakMemory);if(n>threshold) thresholdExceeded=true;},150);
let failed=false;
try {
  await core.start();
  for(const tier of tiers){
    const opened=[];
    let screenshots=0,clicks=0,frames=0;
    const start=performance.now();
    peakMemory=await getNumber('/sys/fs/cgroup/memory.current');
    try {
      for(let index=0;index<tier;index+=5){
        if(thresholdExceeded) throw new Error('Memory safety threshold reached');
        const batch=await Promise.all(Array.from({length:Math.min(5,tier-index)},()=>core.create({url:'http://preview.example/',width:390,height:640})));
        opened.push(...batch);
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
      console.log(JSON.stringify({tier,status:'PASS',created:opened.length,clicks,screenshots,frames,elapsedMs:Math.round(performance.now()-start),peakCgroupMiB:Math.round(peakMemory/1048576)}));
    } catch(error){failed=true;console.error(JSON.stringify({tier,status:'FAIL',created:opened.length,error:error.message,peakCgroupMiB:Math.round(peakMemory/1048576)}));}
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
