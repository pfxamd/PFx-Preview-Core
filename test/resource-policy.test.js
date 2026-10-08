import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaFiles, verifyOSResourceLimits } from '../src/resource-policy.js';

const valid = { memory: String(4 * 1024 ** 3), pids: '256', cpu: '200000 100000' };
test('accepts finite kernel memory, PID and CPU limits', () => {
  assert.deepEqual(parseQuotaFiles(valid), {memoryBytes: 4 * 1024 ** 3, processes: 256, cpuCores: 2});
});
test('rejects unlimited and oversized quotas; never reports them as secured', () => {
  for (const key of ['memory', 'pids', 'cpu']) {
    assert.throws(() => parseQuotaFiles({...valid, [key]: key === 'cpu' ? 'max 100000' : 'max'}), /finite cgroup/);
  }
  assert.throws(() => parseQuotaFiles({...valid, memory: String(32 * 1024 ** 3)}), /memory.max/);
  assert.throws(() => parseQuotaFiles({...valid, pids:'9999'}), /pids.max/);
  assert.throws(() => parseQuotaFiles({...valid, cpu:'1200000 100000'}), /cpu.max/);
});
test('reads resource caps from the current cgroup, fails if kernel is unsupported', async () => {
  const data = new Map([
    ['/proc/self/cgroup', '0::/isolated/pfx\n'],
    ['/sys/fs/cgroup/isolated/pfx/memory.max', valid.memory],
    ['/sys/fs/cgroup/isolated/pfx/pids.max', valid.pids],
    ['/sys/fs/cgroup/isolated/pfx/cpu.max', valid.cpu]
  ]);
  const read = async name => { if (!data.has(name)) throw new Error('Missing cgroup limit'); return data.get(name); };
  assert.equal((await verifyOSResourceLimits({read})).processes, 256);
  await assert.rejects(verifyOSResourceLimits({read: async () => '7:memory:/legacy'}), /cgroup v2/);
});
