import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PreviewCore } from '../src/core.js';

function mockRuntime({ navigateWait } = {}) {
  const counters = { launched: 0, browsersClosed: 0, contextsClosed: 0 };
  const factory = async () => {
    counters.launched++;
    const browser = new EventEmitter();
    browser.newContext = async () => ({
      route: async () => {},
      newPage: async () => ({ goto: async () => { if (navigateWait) await navigateWait; }, url: () => 'https://example.com/', viewportSize: () => ({width:390,height:640}) }),
      close: async () => { counters.contextsClosed++; }
    });
    browser.close = async () => { counters.browsersClosed++; browser.emit('disconnected'); };
    counters.browser = browser;
    return browser;
  };
  return { factory, counters };
}

test('shutting down waits for in-flight navigation and closes its context', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { factory, counters } = mockRuntime({ navigateWait: gate });
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  const creating = core.create({ url: 'https://example.com/' });
  const shuttingDown = core.stop();
  await assert.rejects(core.create({url:'https://example.com/', width:390,height:640}), /not accepting/);
  release();
  await assert.rejects(creating, /shutting down/);
  await shuttingDown;
  assert.equal(core.sessions.size, 0);
  assert.equal(core.pendingCreates, 0);
  assert.equal(counters.contextsClosed, 1);
  assert.equal(counters.browsersClosed, 1);
});

test('concurrent start calls share one browser; stopped core can restart', async () => {
  const { factory, counters } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await Promise.all([core.start(),core.start(),core.start()]);
  assert.equal(counters.launched, 1);
  await Promise.all([core.stop(),core.stop()]);
  assert.equal(counters.browsersClosed, 1);
  await core.start();
  assert.equal(counters.launched, 2);
  await core.stop();
});

test('unexpected browser disconnect clears sessions, then core can recover', async () => {
  const { factory, counters } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  await core.create({ url:'https://example.com/' });
  counters.browser.emit('disconnected');
  // stop is asynchronous and blocks new sessions immediately
  await assert.rejects(core.create({ url:'https://example.com/' }),/not accepting/);
  while (core.stopPromise) await core.stopPromise;
  assert.equal(core.sessions.size,0);
  await core.start();
  assert.equal(counters.launched,2);
  await core.stop();
});

test('idle pruning preserves live streams but removes inactive sessions', async () => {
  const { factory } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u, config: {idleMs:1} });
  await core.start();
  const a=await core.create({url:'https://example.com'});
  const b=await core.create({url:'https://example.com'});
  core.get(a.id).stream=async()=>{};
  assert.equal(await core.prune(Date.now()+1000),1);
  assert.equal(core.sessions.has(a.id),true);
  assert.equal(core.sessions.has(b.id),false);
  await core.stop();
});

for (const tier of [10,25,50]) {
  test(`capacity and resource cleanup: ${tier} concurrent mock sessions`, async () => {
    const { factory, counters } = mockRuntime();
    const core = new PreviewCore({ browserFactory: factory, validate: async u => u, config: { maxSessions: tier } });
    await core.start();
    try {
      const sessions = await Promise.all(Array.from({length:tier},()=>core.create({url:'https://example.com/', width:390,height:640})));
      assert.equal(core.sessions.size,tier);
      await assert.rejects(core.create({url:'https://example.com/', width:390,height:640}),/capacity/);
      await Promise.all(sessions.map(x=>core.close(x.id)));
      assert.equal(core.sessions.size,0);
      assert.equal(counters.contextsClosed,tier);
    } finally { await core.stop(); }
  });
}

test('pixel quotas reject excessive render surfaces before allocating browser contexts', async () => {
  const { factory } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  try {
    await assert.rejects(core.create({url:'https://example.com',width:3840,height:3840,deviceScaleFactor:3}),/pixel budget/);
    assert.equal(core.pendingCreates,0);
    assert.equal(core.allocatedPixels(),0);
  } finally { await core.stop(); }
});

test('pending creations reserve total pixel capacity atomically and release reservations on failure', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const { factory } = mockRuntime({navigateWait:gate});
  const core = new PreviewCore({browserFactory:factory,validate:async u=>u,config:{maxSessions:3,maxTotalPixels:650000}});
  await core.start();
  try {
    const first=core.create({url:'https://example.com',width:600,height:600});
    await assert.rejects(core.create({url:'https://example.com',width:600,height:600}),/pixel budget/);
    assert.equal(core.allocatedPixels(),360000);
    release();
    const session=await first;
    assert.equal(core.allocatedPixels(),360000);
    await core.close(session.id);
    assert.equal(core.allocatedPixels(),0);
  } finally {release();await core.stop();}
});

test('resize enforces total quotas and keeps previous viewport allocation after refusal', async () => {
  const {factory}=mockRuntime();
  const core=new PreviewCore({browserFactory:factory,validate:async u=>u,config:{maxSessionPixels:1_000_000,maxTotalPixels:1_000_000}});
  await core.start();
  try {
    const a=await core.create({url:'https://example.com',width:390,height:640});
    await assert.rejects(core.resize(a.id,{width:1000,height:1500}),/pixel budget/);
    assert.equal(core.allocatedPixels(),390*640);
  } finally {await core.stop();}
});

test('hard maximum age expires active streams even when idle timer is refreshed', async () => {
  const {factory}=mockRuntime();
  const core=new PreviewCore({browserFactory:factory,validate:async u=>u,config:{maxAgeMs:1,idleMs:100000}});
  await core.start();
  try {
    const a=await core.create({url:'https://example.com',width:390,height:640});
    let ended=0;
    core.get(a.id).stream=async()=>{ended++};
    await core.prune(Date.now()+100);
    assert.equal(core.sessions.size,0);
    assert.equal(ended,1);
  } finally {await core.stop();}
});


test('closing sessions remain within capacity and pixel accounting until context teardown finishes', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { factory, counters } = mockRuntime();
  const core = new PreviewCore({
    browserFactory: async () => {
      const browser = await factory();
      const original = browser.newContext;
      browser.newContext = async (...args) => {
        const context = await original(...args);
        const close = context.close;
        context.close = async () => { await gate; await close(); };
        return context;
      };
      return browser;
    },
    validate: async url => url,
    config: { maxSessions: 1, maxTotalPixels: 300_000 }
  });
  await core.start();
  try {
    const session = await core.create({ url: 'https://example.com', width: 390, height: 640 });
    const closing = core.close(session.id);
    assert.equal(core.inFlightCloses.size, 1);
    assert.equal(core.allocatedPixels(), 390 * 640);
    await assert.rejects(core.create({ url: 'https://example.com', width: 390, height: 640 }), /capacity/);
    const stopping = core.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    finish();
    assert.equal(await closing, true);
    await stopping;
    assert.equal(core.allocatedPixels(), 0);
    assert.equal(core.inFlightCloses.size, 0);
    assert.equal(counters.contextsClosed, 1);
  } finally { finish(); await core.stop(); }
});

test('concurrent close calls share one cleanup and keep the slot reserved', async () => {
  const { factory, counters } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  const session = await core.create({ url: 'https://example.com' });
  const first = core.close(session.id);
  const second = core.close(session.id);
  assert.strictEqual(first, second);
  assert.equal(await first, true);
  assert.equal(counters.contextsClosed, 1);
  await core.stop();
});

test('queued resize cannot operate after its session was closed', async () => {
  const { factory } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  try {
    const { id } = await core.create({ url: 'https://example.com', width: 390, height: 640 });
    let calls = 0;
    core.get(id).page.setViewportSize = async () => { calls++; };
    const resizing = core.resize(id, { width: 600, height: 600 });
    const closing = core.close(id);
    await assert.rejects(resizing, /Session not found/);
    await closing;
    assert.equal(calls, 0);
    assert.equal(core.allocatedPixels(), 0);
    assert.equal(core.closingPixels, 0);
  } finally { await core.stop(); }
});

test('close reserves a fixed pixel amount when an in-flight resize fails', async () => {
  const { factory } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u,
    config: { maxSessions: 2, maxTotalPixels: 650_000 } });
  await core.start();
  let resolveResize;
  const resizeGate = new Promise(resolve => { resolveResize = resolve; });
  let started;
  const didStart = new Promise(resolve => { started = resolve; });
  let resolveClose;
  const closeGate = new Promise(resolve => { resolveClose = resolve; });
  try {
    const { id } = await core.create({ url: 'https://example.com', width: 390, height: 640 });
    const session = core.get(id);
    const originalClose = session.context.close;
    session.context.close = async () => { await closeGate; await originalClose(); };
    session.page.setViewportSize = async () => {
      started();
      await resizeGate;
      throw new Error('closed while resizing');
    };
    const resizing = core.resize(id, { width: 600, height: 600 });
    await didStart;
    assert.equal(core.allocatedPixels(), 360_000);
    const closing = core.close(id);
    resolveResize();
    await assert.rejects(resizing, /closed while resizing/);
    resolveClose();
    await closing;
    assert.equal(core.allocatedPixels(), 0);
    assert.equal(core.closingPixels, 0);
    assert.equal(core.inFlightCloses.size, 0);
    const next = await core.create({ url: 'https://example.com', width: 600, height: 600 });
    await core.close(next.id);
    assert.equal(core.allocatedPixels(), 0);
  } finally { resolveResize(); resolveClose(); await core.stop(); }
});

test('an in-flight resize cannot report success after the session closes', async () => {
  const { factory } = mockRuntime();
  const core = new PreviewCore({ browserFactory: factory, validate: async u => u });
  await core.start();
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const { id } = await core.create({ url: 'https://example.com', width: 390, height: 640 });
    core.get(id).page.setViewportSize = async () => { start(); await gate; };
    const resizing = core.resize(id, { width: 600, height: 600 });
    await started;
    const closing = core.close(id);
    release();
    await assert.rejects(resizing, /Session not found/);
    await closing;
    assert.equal(core.allocatedPixels(), 0);
  } finally { release(); await core.stop(); }
});
