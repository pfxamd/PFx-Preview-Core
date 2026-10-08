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

import { inspectOSResourceLimits } from '../src/resource-policy.js';

test('kernel quota inspection reports real process/memory usage and OOM counters', async () => {
  const entries = new Map([
    ['/proc/self/cgroup', '0::/services/pfx\n'],
    ['/sys/fs/cgroup/services/pfx/memory.max', valid.memory],
    ['/sys/fs/cgroup/services/pfx/pids.max', valid.pids],
    ['/sys/fs/cgroup/services/pfx/cpu.max', valid.cpu],
    ['/sys/fs/cgroup/services/pfx/memory.current', '536870912\n'],
    ['/sys/fs/cgroup/services/pfx/pids.current', '44\n'],
    ['/sys/fs/cgroup/services/pfx/memory.events', 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'],
    ['/sys/fs/cgroup/services/pfx/cpu.stat', 'usage_usec 7803\nuser_usec 6100\nsystem_usec 1703\n']
  ]);
  const read = async key => { if (!entries.has(key)) throw new Error(`Missing ${key}`); return entries.get(key); };
  const result = await inspectOSResourceLimits({ read });
  assert.equal(result.cgroup, '/services/pfx');
  assert.deepEqual(result.limits, { memoryBytes: 4 * 1024 ** 3, processes: 256, cpuCores: 2 });
  assert.deepEqual(result.usage, { memoryBytes: 536870912, processes: 44, cpuUsageUsec: 7803, memoryEvents: { oom: 0, oom_kill: 0 } });
  assert.equal(result.productionCertified, false);
  entries.set('/sys/fs/cgroup/services/pfx/pids.max', 'max\n');
  await assert.rejects(inspectOSResourceLimits({ read }), /finite cgroup v2 pids.max/);
  entries.set('/sys/fs/cgroup/services/pfx/pids.max', valid.pids);
  entries.set('/sys/fs/cgroup/services/pfx/memory.events', 'oom 0\n');
  await assert.rejects(inspectOSResourceLimits({ read }), /Missing cgroup v2 memory.events.oom_kill/);
});

test('kernel quota inspector refuses forged usage and malformed paths', async () => {
  const files = new Map([
    ['/proc/self/cgroup', '0::/test\n'],
    ['/sys/fs/cgroup/test/memory.max', valid.memory],
    ['/sys/fs/cgroup/test/pids.max', valid.pids],
    ['/sys/fs/cgroup/test/cpu.max', valid.cpu],
    ['/sys/fs/cgroup/test/memory.current', 'unlimited'],
    ['/sys/fs/cgroup/test/pids.current', '23'],
    ['/sys/fs/cgroup/test/memory.events', 'oom 0\noom_kill 0'],
    ['/sys/fs/cgroup/test/cpu.stat', 'usage_usec 1']
  ]);
  const read = async key => files.get(key);
  await assert.rejects(inspectOSResourceLimits({ read }), /Invalid cgroup v2 resource usage/);
  files.set('/proc/self/cgroup', '0::/test/../escape\n');
  await assert.rejects(inspectOSResourceLimits({ read }), /Invalid cgroup path/);
});
