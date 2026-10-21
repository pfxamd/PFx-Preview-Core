import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, '.pfx/release.json'), 'utf8'));
const botMessage = 'chore(release): sync core version metadata [skip ci]';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = path => readFileSync(resolve(root, path), 'utf8');
const write = (path, value) => writeFileSync(resolve(root, path), value);
const json = path => JSON.parse(read(path));
const saveJson = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const xml = text => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function resolveRelease() {
  if (git('rev-parse', '--is-shallow-repository') === 'true') {
    throw new Error('Core releases require full Git history: git fetch --unshallow');
  }
  git('merge-base', '--is-ancestor', config.baseline, 'HEAD');
  const entries = git('log', '--first-parent', '--format=%H%x09%s', `${config.baseline}..HEAD`, '--', ...config.sourcePaths)
    .split('\n').filter(line => line && line.slice(line.indexOf('\t') + 1) !== botMessage);
  const count = entries.length;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(config.baseVersion);
  if (!match) throw new Error('Invalid core release baseVersion');
  let version = config.baseVersion;
  if (count > 0 && match[4]) {
    const parts = match[4].split('.');
    const last = parts.at(-1);
    if (/^\d+$/.test(last)) parts[parts.length - 1] = String(Number(last) + count);
    else parts.push(String(count));
    version = `${match[1]}.${match[2]}.${match[3]}-${parts.join('.')}`;
  } else if (count > 0) {
    version = `${match[1]}.${match[2]}.${Number(match[3]) + count}`;
  }
  const commit = git('log', '--first-parent', '-1', '--format=%H', '--invert-grep', '--fixed-strings', `--grep=${botMessage}`);
  return { schemaVersion: 1, kind: 'core', product: config.product, channel: config.channel,
    version, label: `${config.channel} ${version}`, commit,
    sourceDate: git('show', '-s', '--format=%cI', commit) };
}

export function syncRelease() {
  const release = resolveRelease();
  const packages = new Map();
  for (const path of config.jsonVersions) {
    const manifest = json(path);
    manifest.version = release.version;
    if (manifest.name) packages.set(manifest.name, release.version);
    saveJson(path, manifest);
  }
  const cargoNames = new Set();
  for (const path of config.cargoVersions) {
    const text = read(path);
    const name = text.match(/^name = "([^"]+)"/m)?.[1];
    if (name) cargoNames.add(name);
    const section = text.includes('[workspace.package]') ? 'workspace.package' : 'package';
    const pattern = new RegExp(`(\\[${section.replace('.', '\\.')}\\][\\s\\S]*?^version = ")[^"]+("$)`, 'm');
    if (!pattern.test(text)) throw new Error(`Missing version in ${path}`);
    write(path, text.replace(pattern, (_, before, after) => before + release.version + after));
  }
  for (const name of config.cargoNames) cargoNames.add(name);
  for (const path of config.npmLocks) {
    const lock = json(path);
    if (lock.version) lock.version = release.version;
    for (const [key, pkg] of Object.entries(lock.packages || {})) {
      if (key === '' || (!key.includes('node_modules') && packages.has(pkg.name))) pkg.version = release.version;
    }
    saveJson(path, lock);
  }
  for (const path of config.cargoLocks) {
    if (!existsSync(resolve(root, path))) continue;
    write(path, read(path).replace(/(\[\[package\]\]\nname = "([^"]+)"\nversion = ")[^"]+("\n)/g,
      (all, before, name, after) => cargoNames.has(name) ? before + release.version + after : all));
  }
  saveJson('version.json', release);
  const text = xml(release.label);
  const width = Math.max(140, 55 + release.label.length * 7);
  const color = release.channel === 'Stable' ? '#287d5e' : release.channel === 'Development' ? '#6a5a8a' : '#9a641e';
  write('version-badge.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" role="img" aria-label="Core: ${text}"><title>Core: ${text}</title><rect width="${width}" height="24" rx="5" fill="#30363d"/><path d="M48 0h${width - 53}a5 5 0 0 1 5 5v14a5 5 0 0 1-5 5H48Z" fill="${color}"/><g fill="#fff" font-family="Verdana,Arial,sans-serif" font-size="11" text-anchor="middle"><text x="24" y="16">core</text><text x="${48 + (width - 48) / 2}" y="16">${text}</text></g></svg>\n`);
  return release;
}

function publishMetadata() {
  const sourceHead = git('rev-parse', 'HEAD');
  git('fetch', 'origin', 'main');
  if (git('rev-parse', 'origin/main') !== sourceHead) {
    console.log('A newer main commit exists; leave metadata to its build.');
    return;
  }
  // Installers may refresh dependency resolutions; publish version-only lock edits.
  const trackedLocks = [...config.npmLocks, ...config.cargoLocks].filter(path => {
    try { git('ls-files', '--error-unmatch', path); return true; } catch { return false; }
  });
  if (trackedLocks.length) git('restore', '--', ...trackedLocks);
  syncRelease();
  const paths = ['version.json', 'version-badge.svg', ...config.jsonVersions, ...config.cargoVersions,
    ...config.npmLocks, ...config.cargoLocks.filter(path => existsSync(resolve(root, path)))];
  git('add', '--', ...paths);
  if (!git('diff', '--cached', '--name-only').length) return;
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', botMessage);
  try { git('push', 'origin', 'HEAD:main'); }
  catch (error) {
    git('fetch', 'origin', 'main');
    if (git('rev-parse', 'origin/main') !== sourceHead) {
      console.log('Main advanced during metadata publication; its build owns the next update.');
      return;
    }
    throw error;
  }
}

if (process.argv[2] === '--publish') publishMetadata();
else console.log(JSON.stringify(process.argv[2] === '--sync' ? syncRelease() : resolveRelease(), null, 2));
