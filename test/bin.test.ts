// bin/jev-categorize and install.sh: finding node under launchd's PATH, following
// symlinks, and installing without clobbering. Each test runs them from a scratch
// copy with a fake node that prints what it was asked to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '..');
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-bin-'));
  const pkg = path.join(root, 'jev-utilities');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'dist'));
  fs.mkdirSync(path.join(pkg, 'node_modules'));
  fs.copyFileSync(path.join(REPO, 'bin/jev-categorize'), path.join(pkg, 'bin/jev-categorize'));
  fs.copyFileSync(path.join(REPO, 'install.sh'), path.join(pkg, 'install.sh'));
  fs.writeFileSync(path.join(pkg, 'dist/cli.js'), '');
  return { root, pkg, bin: path.join(pkg, 'bin/jev-categorize'), cli: fs.realpathSync(path.join(pkg, 'dist/cli.js')) };
}

/** An executable that prints its own name and arguments, standing in for node or npm. */
function fake(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho "${file} $*"\n`, { mode: 0o755 });
  return file;
}

function nvm(root: string, versions: string[], alias?: string, name = 'nvm') {
  const dir = path.join(root, name);
  for (const v of versions) fake(path.join(dir, 'versions/node', v, 'bin/node'));
  if (alias !== undefined) {
    fs.mkdirSync(path.join(dir, 'alias'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'alias/default'), alias + '\n');
  }
  return dir;
}

function run(cmd: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { HOME: os.tmpdir(), PATH: LAUNCHD_PATH, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('JEV_NODE wins over node on PATH and nvm', () => {
  const s = scratch();
  const mine = fake(path.join(s.root, 'mine/node'));
  fake(path.join(s.root, 'onpath/node'));
  const r = run(s.bin, ['--help'], {
    JEV_NODE: mine, PATH: `${s.root}/onpath:${LAUNCHD_PATH}`, NVM_DIR: nvm(s.root, ['v22.1.0'], '22'),
  });
  assert.deepEqual(r, { code: 0, out: `${mine} ${s.cli} --help`, err: '' });
});

test('node on PATH wins over nvm', () => {
  const s = scratch();
  const onPath = fake(path.join(s.root, 'onpath/node'));
  const r = run(s.bin, ['a', 'b c'], { PATH: `${s.root}/onpath:${LAUNCHD_PATH}`, NVM_DIR: nvm(s.root, ['v22.1.0'], '22') });
  assert.equal(r.out, `${onPath} ${s.cli} a b c`);
});

for (const [alias, versions, want] of [
  ['22', ['v20.18.2', 'v22.9.1', 'v22.10.0', 'v23.0.0'], 'v22.10.0'], // numeric sort, not lexical
  ['v22.9', ['v22.9.1', 'v22.90.0', 'v22.10.0'], 'v22.9.1'], // "22.9" isn't a prefix of 22.90
  ['22.23.5', ['v22.23.1', 'v22.23.5'], 'v22.23.5'],
  ['lts/*', ['v18.20.8', 'v22.23.5', 'v20.18.2'], 'v22.23.5'], // not a version: newest installed
] as const) {
  test(`under launchd's PATH, nvm alias ${alias} picks ${want}`, () => {
    const s = scratch();
    const dir = nvm(s.root, [...versions], alias);
    const r = run(s.bin, [], { NVM_DIR: dir });
    assert.equal(r.out, `${dir}/versions/node/${want}/bin/node ${s.cli}`);
  });
}

test('passes every argument through intact, spaces and empties included', () => {
  const s = scratch();
  const node = path.join(s.root, 'argcount');
  fs.writeFileSync(node, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
  assert.equal(run(s.bin, ['a', 'b c', ''], { JEV_NODE: node }).out, `${s.cli}|a|b c||`);
});

test('nvm under HOME is the default NVM_DIR', () => {
  const s = scratch();
  const dir = nvm(s.root, ['v22.1.0'], '22', '.nvm');
  assert.equal(run(s.bin, [], { HOME: s.root }).out, `${dir}/versions/node/v22.1.0/bin/node ${s.cli}`);
});

test('no node anywhere is exit 127 with a hint', () => {
  const s = scratch();
  for (const env of [{ NVM_DIR: path.join(s.root, 'none') }, { NVM_DIR: nvm(s.root, ['v20.1.0'], '22') }]) {
    const r = run(s.bin, [], env);
    assert.equal(r.code, 127);
    assert.match(r.err, /no node found/);
  }
  assert.equal(run(s.bin, [], { JEV_NODE: path.join(s.root, 'missing') }).code, 127);
});

test('an unbuilt CLI is exit 127 naming the build step', () => {
  const s = scratch();
  fs.rmSync(s.cli);
  const r = run(s.bin, [], { JEV_NODE: fake(path.join(s.root, 'node')) });
  assert.equal(r.code, 127);
  assert.match(r.err, /dist\/cli\.js is missing -- run install\.sh/);
});

test('runs the CLI next to the real file through absolute and relative symlink chains', () => {
  const s = scratch();
  const node = fake(path.join(s.root, 'node'));
  const links = path.join(s.root, 'links');
  fs.mkdirSync(links);
  fs.symlinkSync(s.bin, path.join(links, 'abs'));
  fs.symlinkSync('abs', path.join(links, 'rel'));
  for (const name of ['abs', 'rel']) {
    assert.equal(run(path.join(links, name), ['x'], { JEV_NODE: node }).out, `${node} ${s.cli} x`);
  }
});

function install(s: ReturnType<typeof scratch>, args: string[] = []) {
  const npmDir = path.join(s.root, 'npmbin');
  fake(path.join(npmDir, 'npm'));
  return run(path.join(s.pkg, 'install.sh'), args, { PREFIX: path.join(s.root, 'prefix'), PATH: `${npmDir}:${LAUNCHD_PATH}` });
}

test('install.sh builds, links, is idempotent, and uninstalls only its own link', () => {
  const s = scratch();
  const dest = path.join(s.root, 'prefix/bin/jev-categorize');
  const first = install(s);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /npm --prefix .* run build --silent/);
  assert.doesNotMatch(first.out, / ci$/m, 'node_modules exists, so no npm ci');
  assert.equal(fs.readlinkSync(dest), fs.realpathSync(s.bin));
  assert.match(install(s).out, /already installed/);
  assert.match(install(s, ['--uninstall']).out, /removed/);
  assert.equal(fs.existsSync(dest), false);
  assert.match(install(s, ['--uninstall']).out, /left alone/);
});

test('install.sh runs npm ci when dependencies are missing', () => {
  const s = scratch();
  fs.rmdirSync(path.join(s.pkg, 'node_modules'));
  assert.match(install(s).out, /npm --prefix \S+ ci/);
});

test('install.sh never replaces a foreign symlink, even a dangling one', () => {
  const s = scratch();
  const dest = path.join(s.root, 'prefix/bin/jev-categorize');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(path.join(s.root, 'gone'), dest);
  const r = install(s);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to replace/);
  assert.equal(fs.readlinkSync(dest), path.join(s.root, 'gone'));
});

test('install.sh never replaces a foreign file and rejects unknown flags', () => {
  const s = scratch();
  const dest = path.join(s.root, 'prefix/bin/jev-categorize');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'theirs');
  const r = install(s);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to replace/);
  assert.match(install(s, ['--uninstall']).out, /left alone/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'theirs');
  assert.equal(install(s, ['--bogus']).code, 2);
});
