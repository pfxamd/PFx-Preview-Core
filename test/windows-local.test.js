import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWindowsLocalRuntime } from '../src/core.js';

test('native Windows runtime requires explicit operator opt-in', () => {
  assert.throws(() => assertWindowsLocalRuntime({platform:'win32'}), /PFX_LOCAL_WINDOWS/);
  assert.throws(() => assertWindowsLocalRuntime({platform:'win32',enabled:'0'}), /PFX_LOCAL_WINDOWS/);
  assert.equal(assertWindowsLocalRuntime({platform:'win32', enabled:'1'}), true);
});
test('Windows runtime rejects all multi-tenant configurations', () => {
  assert.throws(() => assertWindowsLocalRuntime({platform:'win32', enabled:'1', tenants:'{}'}), /untrusted tenants/);
});
test('Linux secure sandbox path is unaffected', () => {
  assert.equal(assertWindowsLocalRuntime({platform:'linux'}), false);
  assert.equal(assertWindowsLocalRuntime({platform:'linux',tenants:'{}'}), false);
});
