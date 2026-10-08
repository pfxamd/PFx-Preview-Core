import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PreviewCore } from '../src/core.js';
import { GuardedEgressProxy } from '../src/egress.js';

// A repeatable stability gate for real isolated Chromium. Not a production
// benchmark: fixtures are lightweight and the CI host is shared.
const durationSeconds = Number(process.env.PFX_SOAK_SECONDS || 90);
if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 3600)
  throw new Error('PFX_SOAK_SECONDS must be between 5 and 3600');
const recoveryInterval = Number(process.env.PFX_SOAK_RECOVERY_INTERVAL || 0);
if (!Number.isInteger(recoveryInterval) || recoveryInterval < 0 || recoveryInterval > 100000)
  throw new Error('PFX_SOAK_RECOVERY_INTERVAL must be a nonnegative integer');
const target = createServer((_req,res)=>res.end('<!doctype html><title>PFx soak</title><button onclick="document.title=\'clicked\'">click</button><div>isolated</div>'));
await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
const port=target.address().port;
const core=new PreviewCore({
  validate: async url=>url,
  config: {maxSessions:4, maxAgeMs:90_000},
  egressFactory:()=>new GuardedEgressProxy({resolver:async()=>[{address:'8.8.8.8',family:4}],dial:()=>connect({host:'127.0.0.1',port})})
});
let cycles=0, screenshots=0, frames=0, clicks=0, restarts=0, failed=false;
const began=performance.now();
const until=began+durationSeconds*1000;
try {
  await core.start();
  while (performance.now()<until) {
    const created=[];
    try {
      for (let n=0;n<4;n++) created.push(await core.create({url:'http://soak.example/',width:390,height:640}));
      for (const {id} of created) {
        await core.get(id).page.locator('button').click();
        if (await core.get(id).page.title()!=='clicked') throw new Error('Interaction mismatch');
        clicks++;
      }
      const png=await core.screenshot(created[0].id);
      if (png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('Bad PNG');
      screenshots++;
      const stop=await core.stream(created[0].id,()=>frames++);
      await core.get(created[0].id).page.locator('div').evaluate(el=>el.style.background='orange');
      await new Promise(resolve=>setTimeout(resolve,100));
      await stop();
      cycles++;
    } finally {
      await Promise.allSettled(created.map(s=>core.close(s.id)));
      if(core.sessions.size || core.allocatedPixels() !== 0 || core.pendingCreates || core.inFlightCloses.size)
        throw new Error('Session/pixel resource leak after lifecycle');
    }
    if (recoveryInterval && cycles % recoveryInterval === 0) {
      // Simulate browser-process loss: closing the Playwright browser externally
      // must trigger the unexpected-disconnect handler and clean host resources.
      const browser = core.browser;
      await browser.close();
      const deadline = performance.now() + 10_000;
      while ((core.stopPromise || core.browser || core.egress || core.bridge) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (core.stopPromise || core.browser || core.egress || core.bridge || core.sessions.size)
        throw new Error('Browser disconnect recovery leaked core resources');
      await core.start();
      restarts++;
    }
  }
  if(cycles<2 || screenshots<2 || frames<2) throw new Error('Insufficient lifecycle or streaming coverage');
} catch(e) {failed=true;console.error('SOAK_FAILED',e);}
finally {
  await core.stop().catch(e=>{failed=true;console.error(e);});
  target.closeAllConnections();
  await new Promise(resolve=>target.close(resolve));
}
console.log(JSON.stringify({status:failed?'FAIL':'PASS',durationSeconds,cycles,clicks,screenshots,frames,restarts,elapsedSeconds:Math.round((performance.now()-began)/1000),remainingSessions:core.sessions.size}));
if(failed)process.exitCode=1;
