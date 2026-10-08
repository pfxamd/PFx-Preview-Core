import { inspectOSResourceLimits } from '../src/resource-policy.js';

// Run inside the deployed service's cgroup, not in a developer shell. This
// checks actual kernel controls but does not create a cgroup or certify tenancy.
try {
  const result = await inspectOSResourceLimits();
  console.log(JSON.stringify({ status: 'PASS', ...result }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', reason: error.message, productionCertified: false }));
  process.exitCode = 1;
}
