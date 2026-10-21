import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = resolve(root, '.pfx-release-tools');
const installed = resolve(toolsRoot, 'node_modules/@pfxamd/release-core');
const pinnedVersion = '0.1.0-alpha.2';
const pinnedArchive = 'https://github.com/pfxamd/pfx-release-core/releases/download/v0.1.0-alpha.2/pfxamd-release-core-0.1.0-alpha.2.tgz';
const git = (...args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();

function installCore() {
  const current = (() => {
    try { return JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8')).version; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })();
  if (current === pinnedVersion && existsSync(resolve(installed, 'src/index.mjs'))) return;
  mkdirSync(toolsRoot, { recursive: true });
  const manifest = resolve(toolsRoot, 'package.json');
  if (!existsSync(manifest)) writeFileSync(manifest,
    '{"name":"pfx-release-tools","version":"0.0.0","private":true,"type":"module"}\n');
  execFileSync('npm', ['install', '--prefix', toolsRoot, '--ignore-scripts', '--no-save',
    '--package-lock=false', '--no-audit', '--no-fund', pinnedArchive],
    { cwd: toolsRoot, stdio: 'inherit' });
  const actual = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8')).version;
  if (actual !== pinnedVersion) throw new Error('Unexpected Release Core version: ' + actual);
}
installCore();
const { getRelease, resolveFiles, syncFiles, SYNC_MESSAGE } =
  await import(pathToFileURL(resolve(installed, 'src/index.mjs')).href);

function publish() {
  const expected = git('rev-parse', 'HEAD');
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'origin/main') !== expected) {
    console.log('Main advanced; its new build owns the metadata update.');
    return;
  }
  const { config, history, release } = getRelease(root);
  const files = resolveFiles(root, config, release, history.commits);
  syncFiles(root, files);
  git('add', '--', ...files.keys());
  if (!git('diff', '--cached', '--name-only')) {
    console.log('Release metadata already synchronized:', release.version);
    return;
  }
  git('-c', 'user.name=github-actions[bot]', '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', SYNC_MESSAGE);
  try { git('push', 'origin', 'HEAD:main'); }
  catch (error) {
    git('fetch', 'origin', 'main');
    if (git('rev-parse', 'origin/main') !== expected) {
      console.log('Newer main commit now owns the metadata update.');
      return;
    }
    throw error;
  }
}
const command = process.argv[2] || '--resolve';
if (command === '--publish') publish();
else {
  const { config, history, release } = getRelease(root);
  const files = resolveFiles(root, config, release, history.commits);
  if (command === '--sync') console.log(JSON.stringify({
    ...release, changed: syncFiles(root, files)
  }, null, 2));
  else if (command === '--check') {
    const changes = syncFiles(root, files, true);
    if (changes.length) { console.error('Outdated release outputs: ' + changes.join(', ')); process.exitCode = 1; }
    else console.log(JSON.stringify(release, null, 2));
  } else if (command === '--resolve') console.log(JSON.stringify(release, null, 2));
  else { console.error('Unknown release command: ' + command); process.exitCode = 2; }
}
