import { PreviewCore } from '../src/core.js';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Explicit opt-in performance diagnostic, not a deployment capacity promise.
const tiers = (process.env.PFX_LOAD_TIERS || '10,25,50').split(',').map(Number);
if (tiers.some(n => !Number.isInteger(n) || n < 1 || n > 50)) throw new Error('Invalid tier; max 50');
const readNumber = async path => { try { const n=Number((await readFile(path,'utf8')).trim()); return Number.isFinite(n) ? n : 0; } catch { return 0; } };
const memPath='/sys/fs/cgroup/memory.current';
const memMax=await readNumber('/sys/fs/cgroup/memory.max');
const limit=memMax>0 ? Math.min(3_300_000_000, memMax*.80) : 2_500_000_000;
const core=new PreviewCore({ config:{maxSessions:50} });
const results=[];
let memoryPeak=0;
let abort=false;
const monitor=setInterval(async()=>{
  const used=await readNumber(memPath);
  memoryPeak=Math.max(memoryPeak,used);
  if(used>limit) abort=true;
},150);
const fixture='<!doctype html><title>PFx load fixture</title><style>body{font:16px system-ui;background:linear-gradient(135deg,#345,#789);padding:16px}button{padding:12px}</style><button onclick="document.title=\'clicked\'">Tap</button><main>PFx Browser Runtime</main>';
try {
  await core.start();
  for(const tier of tiers) {
    const contexts=[];
    let opened=0, failures=0;
    memoryPeak=await readNumber(memPath);
    const start=performance.now();
    try {
      for (let index=0; index<tier; index+=5) {
        if(abort) throw new Error('Memory safety threshold reached');
        const group=await Promise.all(Array.from({length:Math.min(5,tier-index)},async()=>{
          const context=await core.browser.newContext({viewport:{width:390,height:640},serviceWorkers:'block'});
          contexts.push(context);
          const page=await context.newPage();
          await page.setContent(fixture);
          await page.locator('button').click();
          if(await page.title()!=='clicked') throw new Error('Real DOM interaction failed');
          opened++;
          return page;
        }));
        if(group.length && !(await group[0].screenshot()).length) throw new Error('Empty screenshot');
      }
    } catch(error) { failures++; results.push({tier,opened,pass:false,reason:error.message}); }
    finally {
      await Promise.allSettled(contexts.map(c=>c.close()));
      const elapsedMs=Math.round(performance.now()-start);
      if(!failures) results.push({tier,opened,pass:opened===tier,elapsedMs,peakCgroupMiB:Math.round(memoryPeak/1048576)});
      console.log(JSON.stringify({tier,opened,failures,elapsedMs,peakCgroupMiB:Math.round(memoryPeak/1048576),memoryThresholdMiB:Math.round(limit/1048576)}));
    }
    if(failures || abort) break;
  }
} finally {clearInterval(monitor);await core.stop();}
console.log('RESULTS',JSON.stringify(results));
if(results.some(r=>!r.pass) || results.length!==tiers.length) process.exitCode=1;
