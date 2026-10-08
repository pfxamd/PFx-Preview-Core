import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// A production operator must launch the *entire service* inside a delegated,
// kernel-enforced cgroup v2. Pixel quotas alone are NOT memory/CPU/process caps.
export function parseQuotaFiles({memory, pids, cpu}, policy = {}) {
  const maxMemoryBytes = policy.maxMemoryBytes ?? 8 * 1024 ** 3;
  const maxProcesses = policy.maxProcesses ?? 1024;
  const maxCpuCores = policy.maxCpuCores ?? 8;
  const positiveInt = text => /^\d+$/.test(text?.trim() ?? '') ? Number(text.trim()) : NaN;
  const mem = positiveInt(memory);
  const processes = positiveInt(pids);
  const [quota, period, ...extra] = (cpu || '').trim().split(/\s+/);
  const cores = positiveInt(quota) / positiveInt(period);
  if (!Number.isSafeInteger(mem) || mem < 256 * 1024 ** 2 || mem > maxMemoryBytes)
    throw new Error('A finite cgroup v2 memory.max is required');
  if (!Number.isSafeInteger(processes) || processes < 16 || processes > maxProcesses)
    throw new Error('A finite cgroup v2 pids.max is required');
  if (extra.length || !Number.isFinite(cores) || cores <= 0 || cores > maxCpuCores)
    throw new Error('A finite cgroup v2 cpu.max is required');
  return { memoryBytes: mem, processes, cpuCores: cores };
}

export async function verifyOSResourceLimits({read = readFile, path = '/proc/self/cgroup', root = '/sys/fs/cgroup', policy} = {}) {
  const cgroup = await read(path, 'utf8');
  const match = cgroup.split('\n').find(line => line.startsWith('0::'));
  if (!match) throw new Error('cgroup v2 is required for production');
  const relative = match.slice(3).replace(/^\/+/, '');
  if (relative.split('/').some(x => x === '.' || x === '..')) throw new Error('Invalid cgroup path');
  const base = join(root, relative);
  const [memory, pids, cpu] = await Promise.all(['memory.max', 'pids.max', 'cpu.max']
    .map(file => read(join(base, file), 'utf8')));
  return parseQuotaFiles({memory, pids, cpu}, policy);
}
