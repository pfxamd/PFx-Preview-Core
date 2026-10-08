import { existsSync, readFileSync, readdirSync } from 'node:fs';
const status = readFileSync('/proc/self/status', 'utf8');
console.log(JSON.stringify({
  pid: process.pid,
  rootEntries: readdirSync('/').sort(),
  hasHostCredentials: existsSync('/home/runner/.ssh') || existsSync('/root/.aws'),
  hasOutsideConfiguration: existsSync('/etc/shadow') || existsSync('/etc/hostname'),
  passwd: readFileSync('/etc/passwd', 'utf8').trim(),
  hasGuardedSocketDirectory: existsSync('/bridge'),
  hasProcessNamespace: /NSpid:\s+1(?:\s|$)/m.test(status) || process.pid === 1,
  hasWorker: existsSync('/app/relay.js')
}));
