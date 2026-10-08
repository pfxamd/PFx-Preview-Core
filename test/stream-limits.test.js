import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PreviewCore } from '../src/core.js';

async function makeStreamCore(config = {}) {
  const cdp = new EventEmitter();
  const state = { started: 0, stopped: 0, detached: 0, acknowledged: 0, contextsClosed: 0 };
  cdp.send = async method => {
    if (method === 'Page.startScreencast') state.started++;
    if (method === 'Page.stopScreencast') state.stopped++;
    if (method === 'Page.screencastFrameAck') state.acknowledged++;
  };
  cdp.detach = async () => { state.detached++; };
  const core = new PreviewCore({
    config: { maxStreamFrameBytes: 16, maxStreamBytes: 32, ...config },
    validate: async url => url,
    browserFactory: async () => ({
      on: () => {},
      newContext: async () => ({
        route: async () => {},
        newPage: async () => ({
          goto: async () => null,
          url: () => 'https://example.com/',
          viewportSize: () => ({ width: 390, height: 640 })
        }),
        newCDPSession: async () => cdp,
        close: async () => { state.contextsClosed++; }
      }),
      close: async () => {}
    })
  });
  await core.start();
  const { id } = await core.create({ url: 'https://example.com/', owner: 'alice' });
  return { core, cdp, id, state };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const frame = data => ({ data, sessionId: 123, metadata: { timestamp: 1 } });

test('rejects unsafe or unbounded streaming config and options', async () => {
  for (const config of [
    { maxStreamFrameBytes: 0 }, { maxStreamFrameBytes: 20 * 1024 ** 2 },
    { maxStreamBytes: 15 }, { maxStreamBytes: 2 ** 31 }
  ]) {
    assert.throws(() => new PreviewCore({ config }), /stream data limits/i);
  }
  const { core, id, state } = await makeStreamCore();
  try {
    for (const options of [
      { quality: 100 }, { quality: 0 }, { quality: Number.NaN },
      { everyNthFrame: 0 }, { everyNthFrame: 61 }, { everyNthFrame: 1.5 }
    ]) {
      await assert.rejects(core.stream(id, () => {}, options, 'alice'), /Invalid streaming options/);
    }
    assert.equal(state.started, 0);
    assert.equal(core.get(id, 'alice').streamPending, undefined);
  } finally { await core.stop(); }
});

test('stream stops on oversized single frame without forwarding it', async () => {
  const { core, cdp, id, state } = await makeStreamCore();
  try {
    const messages = [];
    let notifications = 0;
    await core.stream(id, value => messages.push(value), { onStop: () => { notifications++; } }, 'alice');
    cdp.emit('Page.screencastFrame', frame('A'.repeat(16)));
    cdp.emit('Page.screencastFrame', frame('B'.repeat(17)));
    await settle();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].data.length, 16);
    assert.equal(state.stopped, 1);
    assert.equal(state.detached, 1);
    assert.equal(notifications, 1);
    assert.equal(core.get(id, 'alice').stream, null);
    cdp.emit('Page.screencastFrame', frame('C'));
    assert.equal(messages.length, 1);
  } finally { await core.stop(); }
});

test('stream cumulative data budget counts encoded output and permits new streams', async () => {
  const { core, cdp, id, state } = await makeStreamCore();
  try {
    const messages = [];
    await core.stream(id, value => messages.push(value), {}, 'alice');
    cdp.emit('Page.screencastFrame', frame('A'.repeat(16)));
    cdp.emit('Page.screencastFrame', frame('B'.repeat(16)));
    cdp.emit('Page.screencastFrame', frame('C'));
    await settle();
    assert.equal(messages.length, 2);
    assert.equal(state.stopped, 1);
    assert.equal(core.get(id, 'alice').stream, null);
    const stopAgain = await core.stream(id, value => messages.push(value), {}, 'alice');
    cdp.emit('Page.screencastFrame', frame('D'.repeat(4)));
    assert.equal(messages.length, 3);
    await stopAgain();
    assert.equal(state.detached, 2);
  } finally { await core.stop(); }
});

test('tenant checks precede allocation, and stream cleanup ignores callback errors', async () => {
  const { core, cdp, id, state } = await makeStreamCore();
  try {
    await assert.rejects(core.stream(id, () => {}, {}, 'bob'), /Session not found/);
    assert.equal(state.started, 0);
    await core.stream(id, () => {}, { onStop: () => { throw new Error('client gone'); } }, 'alice');
    cdp.emit('Page.screencastFrame', frame(null));
    await settle();
    assert.equal(state.detached, 1);
    assert.equal(core.get(id, 'alice').stream, null);
    assert.equal(await core.close(id, 'alice'), true);
    assert.equal(state.contextsClosed, 1);
  } finally { await core.stop(); }
});
