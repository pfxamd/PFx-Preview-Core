import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// This is a verifier, not a cgroup allocator: operators must place the whole
// service in an OS-enforced cgroup v2 before accepting untrusted workloads.
const readNonnegativeInt = text => /^\d+$/.test(text?.trim() ?? '') ? Number(text.trim()) : NaN;

export function parseQuotaFiles({ memory, pids, cpu }, policy = {}) {
  const maxMemoryBytes = policy.maxMemoryBytes ?? 8 * 1024 ** 3;
  const maxProcesses = policy.maxProcesses ?? 1024;
  const maxCpuCores = policy.maxCpuCores ?? 8;
  const mem = readNonnegativeInt(memory);
  const processes = readNonnegativeInt(pids);
  const [quota, period, ...extra] = (cpu || '').trim().split(/\s+/);
  const cores = readNonnegativeInt(quota) / readNonnegativeInt(period);
  if (!Number.isSafeInteger(mem) || mem < 256 * 1024 ** 2 || mem > maxMemoryBytes)
    throw new Error('A finite cgroup v2 memory.max is required');
  if (!Number.isSafeInteger(processes) || processes < 16 || processes > maxProcesses)
    throw new Error('A finite cgroup v2 pids.max is required');
  if (extra.length || !Number.isFinite(cores) || cores <= 0 || cores > maxCpuCores)
    throw new Error('A finite cgroup v2 cpu.max is required');
  return { memoryBytes: mem, processes, cpuCores: cores };
}

async function cgroupDirectory({ read, path, root }) {
  const cgroup = await read(path, 'utf8');
  const match = cgroup.split('\n').find(line => line.startsWith('0::'));
  if (!match) throw new Error('cgroup v2 is required for production');
  const relative = match.slice(3).replace(/^\/+/, '');
  if (relative.split('/').some(x => x === '.' || x === '..')) throw new Error('Invalid cgroup path');
  return { path: `/${relative}`, dir: join(root, relative) };
}

export async function verifyOSResourceLimits({ read = readFile, path = '/proc/self/cgroup', root = '/sys/fs/cgroup', policy } = {}) {
  const { dir } = await cgroupDirectory({ read, path, root });
  const [memory, pids, cpu] = await Promise.all(['memory.max', 'pids.max', 'cpu.max']
    .map(file => read(join(dir, file), 'utf8')));
  return parseQuotaFiles({ memory, pids, cpu }, policy);
}

function parseCounters(raw, keys, context) {
  const data = Object.fromEntries(String(raw).trim().split('\n').map(line => {
    const [name, value, ...rest] = line.trim().split(/\s+/);
    if (!name || rest.length || !Number.isSafeInteger(readNonnegativeInt(value))) {
      throw new Error(`Invalid cgroup v2 ${context}`);
    }
    return [name, readNonnegativeInt(value)];
  }));
  for (const key of keys) if (!Object.hasOwn(data, key)) throw new Error(`Missing cgroup v2 ${context}.${key}`);
  return Object.fromEntries(keys.map(key => [key, data[key]]));
}

/** Read real kernel usage, *after* validating all three finite limits. */
export async function inspectOSResourceLimits({ read = readFile, path = '/proc/self/cgroup', root = '/sys/fs/cgroup', policy } = {}) {
  const { path: cgroup, dir } = await cgroupDirectory({ read, path, root });
  const limits = await verifyOSResourceLimits({ read, path, root, policy });
  const [memoryText, pidsText, eventsText, cpuText] = await Promise.all([
    'memory.current', 'pids.current', 'memory.events', 'cpu.stat'
  ].map(file => read(join(dir, file), 'utf8')));
  const memoryBytes = readNonnegativeInt(memoryText);
  const pids = readNonnegativeInt(pidsText);
  if (!Number.isSafeInteger(memoryBytes) || !Number.isSafeInteger(pids)) {
    throw new Error('Invalid cgroup v2 resource usage');
  }
  const memoryEvents = parseCounters(eventsText, ['oom', 'oom_kill'], 'memory.events');
  const cpu = parseCounters(cpuText, ['usage_usec'], 'cpu.stat');
  return {
    cgroup,
    limits,
    usage: { memoryBytes, processes: pids, cpuUsageUsec: cpu.usage_usec, memoryEvents },
    // A cgroup being finite does not prove absence of other tenants in it.
    productionCertified: false
  };
}
