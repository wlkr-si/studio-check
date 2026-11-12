import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, open, readdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseArgs, HELP } from './studio-check.mjs';
import { MAX_REPORT_BYTES, MAX_REPOSITORIES, compareReports } from './web/report-compare.mjs';

function report() {
  const unknown = () => ({ status: 'unknown', source: null, url: null });
  return { organization: 'demo', complete: true, includeArchived: false, excludedArchived: 0, errors: [], repositories: [{ name: 'demo/tool', url: 'https://github.com/demo/tool', archived: false, fork: false, description: 'Before', homepage: null, readme: unknown(), license: { declared: null, status: 'unknown' }, community: Object.fromEntries(['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'].map(key => [key, unknown()])) }] };
}
async function files(t, before = report(), after = report()) {
  await mkdir('.task', { recursive: true });
  const directory = await mkdtemp(resolve('.task/cli-compare-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [join(directory, 'before.json'), join(directory, 'after.json')];
  for (const [index, value] of [before, after].entries()) await writeFile(paths[index], JSON.stringify(value));
  return { directory, paths };
}
async function run(args) {
  let calls = 0;
  const output = [], errors = [];
  const code = await main(args, { stdout: text => output.push(text), stderr: text => errors.push(text), fetchImpl: () => { calls++; assert.fail('Offline comparison must never fetch.'); } });
  assert.equal(calls, 0);
  return { code, output: output.join('\n'), error: errors.join('\n') };
}
function processRun(args, cwd = process.cwd()) {
  // A subprocess exercises the real entry point with native temporary files.
  return spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}', resolve('studio-check.mjs'), ...args], { encoding: 'utf8', cwd, timeout: 2000, killSignal: 'SIGKILL' });
}
test('explicit offline arguments preserve every existing org form, including compare', async () => {
  assert.equal(parseArgs(['compare']).org, 'compare');
  assert.equal(parseArgs(['compare', '--json', '--include-archived']).org, 'compare');
  assert.deepEqual(parseArgs(['--compare', 'a', 'b', '--json']), { mode: 'compare', paths: ['a', 'b'], json: true });
  for (const args of [['--compare'], ['--compare', 'a'], ['--compare', 'a', 'b', 'c'], ['--compare', 'a', 'b', '--include-archived'], ['demo', '--compare', 'a', 'b'], ['--compare', '--secret-token'], ['--compare', 'a', 'b', '--help']]) {
    const result = await run(args); assert.equal(result.code, 1); assert.equal(result.output, '');
  }
  assert.match(HELP, /--compare/);
  assert.equal((await run(['--compare', '--help'])).code, 0);
  const calls = [];
  assert.equal(await main(['compare'], { stdout: () => {}, fetchImpl: async url => { calls.push(url); return new Response('[]'); } }), 0);
  assert.match(calls[0], /\/orgs\/compare\/repos/);
});
test('real saved/current files give shared comparator JSON and useful human output without writes', async t => {
  const before = report(), after = report(); after.repositories[0].description = 'After';
  after.repositories[0].community.contributing = { status: 'present', source: 'organization-default', url: null };
  const { directory, paths } = await files(t, before, after);
  const contents = await Promise.all(paths.map(path => readFile(path)));
  const json = await run(['--compare', ...paths, '--json']);
  assert.equal(json.code, 0); assert.equal(json.error, '');
  assert.deepEqual(JSON.parse(json.output), { organization: 'demo', includeArchived: false, ...compareReports(before, after) });
  const human = await run(['--compare', ...paths]);
  assert.match(human.output, /Saved: "Before"/); assert.match(human.output, /Current: "After"/);
  assert.match(human.output, /organization default/); assert.doesNotMatch(human.output, /score/i);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), contents);
  assert.deepEqual((await readdir(directory)).sort(), ['after.json', 'before.json']);
});
test('native process entry supports spaces and literal dash-leading filenames', async t => {
  const { directory } = await files(t);
  await writeFile(join(directory, '-before report.json'), JSON.stringify(report()));
  await writeFile(join(directory, '-after report.json'), JSON.stringify(report()));
  const result = processRun(['--compare', '--json', '--', '-before report.json', '-after report.json'], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changes, []);
  assert.equal(result.stderr, '');
});
test('partial files exit 2 and never turn membership gaps into additions/removals', async t => {
  const before = report(), after = report(); after.repositories = [];
  const { paths } = await files(t, before, after);
  for (const [saved, current] of [[false, true], [true, false], [false, false]]) {
    before.complete = saved; after.complete = current;
    before.errors = saved ? [] : ['Pagination failed']; after.errors = current ? [] : ['Rate limited'];
    await writeFile(paths[0], JSON.stringify(before)); await writeFile(paths[1], JSON.stringify(after));
    const result = await run(['--compare', ...paths, '--json']);
    assert.equal(result.code, 2);
    const value = JSON.parse(result.output); assert.equal(value.membershipConfirmed, false); assert.match(value.changes[0].membership, /unconfirmed/);
    assert.doesNotMatch((await run(['--compare', ...paths])).output, /\n  (Added|Removed)/);
  }
});
test('different orgs/archive modes and malformed schemas fail without stacks or contents', async t => {
  const { paths } = await files(t);
  for (const content of ['{ TOP_SECRET_VALUE', '{"__proto__":{"polluted":true}}', JSON.stringify({ ...report(), organization: 'other', repositories: [] }), JSON.stringify({ ...report(), includeArchived: true })]) {
    await writeFile(paths[1], content);
    const result = await run(['--compare', ...paths]);
    assert.equal(result.code, 1); assert.equal(result.output, '');
    assert.doesNotMatch(result.error, /TOP_SECRET_VALUE|\bat .*\.mjs|SyntaxError|Error:/);
  }
});
test('size is bounded before parse, exact 5 MiB is accepted and UTF-8 is strict', async t => {
  const { paths } = await files(t);
  const json = JSON.stringify(report());
  await writeFile(paths[0], json + ' '.repeat(MAX_REPORT_BYTES - Buffer.byteLength(json)));
  assert.equal((await run(['--compare', ...paths])).code, 0);
  const handle = await open(paths[0], 'r+'); await handle.truncate(MAX_REPORT_BYTES + 1); await handle.close();
  const oversized = await run(['--compare', ...paths]); assert.equal(oversized.code, 1); assert.match(oversized.error, /5 MiB/);
  await writeFile(paths[0], Buffer.from([0xff, 0xfe, 0x00]));
  assert.match((await run(['--compare', ...paths])).error, /UTF-8/);
});
test('actual report files enforce 5000-repository schema bounds', async t => {
  const tooMany = report(); tooMany.repositories = Array(MAX_REPOSITORIES + 1).fill(tooMany.repositories[0]);
  const { paths } = await files(t, tooMany);
  const result = await run(['--compare', ...paths]); assert.equal(result.code, 1); assert.match(result.error, /5000/);
});
test('missing and unreadable files use concise errors without echoing secret paths', async t => {
  const { directory, paths } = await files(t);
  const result = await run(['--compare', join(directory, 'TOP_SECRET_PATH'), paths[1]]);
  assert.equal(result.code, 1); assert.match(result.error, /ENOENT/); assert.doesNotMatch(result.error, /TOP_SECRET_PATH/);
  if (process.getuid?.() !== 0) {
    await chmod(paths[0], 0);
    assert.match((await run(['--compare', ...paths])).error, /EACCES|EPERM/);
  }
});
test('directories, FIFOs and devices fail promptly instead of reading or hanging', async t => {
  const { directory, paths } = await files(t);
  assert.equal((await run(['--compare', directory, paths[1]])).code, 1);
  const fifo = join(directory, 'waiting-pipe');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
  for (const path of [fifo, '/dev/null', '/dev/zero']) {
    const result = processRun(['--compare', path, paths[1]]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /regular file/); assert.equal(result.stdout, '');
  }
});
test('final symlinks are refused and symlinked parent directories are documented resolution', async t => {
  const { directory, paths } = await files(t);
  const link = join(directory, 'report-link'); await symlink(paths[0], link);
  assert.match((await run(['--compare', link, paths[1]])).error, /ELOOP|symlink/);
  const parent = join(directory, 'parent-link'); await symlink(directory, parent);
  assert.equal((await run(['--compare', join(parent, 'before.json'), paths[1]])).code, 0);
});
test('human output removes license ESC/OSC/C1 controls while JSON round-trips original data safely', async t => {
  const before = report(), after = report();
  const declared = 'MIT\u001b]0;terminal title\u0007\u001b[31m\u009b';
  after.repositories[0].license = { status: 'declared', declared };
  const { paths } = await files(t, before, after);
  const human = await run(['--compare', ...paths]); assert.equal(human.code, 0);
  assert.doesNotMatch(human.output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const json = await run(['--compare', ...paths, '--json']); assert.equal(json.code, 0);
  assert.doesNotMatch(json.output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.equal(JSON.parse(json.output).changes[0].fields.find(field => field.field === 'License declared').after, `Declared: ${declared}`);
});

test('a file growing after stat is capped before decoding or parsing', async t => {
  const { paths } = await files(t);
  const probe = await open(paths[0], 'r');
  const prototype = Object.getPrototypeOf(probe), original = prototype.stat;
  await probe.close();
  prototype.stat = async function (...args) {
    const initial = await original.apply(this, args);
    prototype.stat = original;
    await appendFile(paths[0], Buffer.alloc(MAX_REPORT_BYTES + 1));
    return initial;
  };
  try {
    const result = await run(['--compare', ...paths]);
    assert.equal(result.code, 1); assert.match(result.error, /5 MiB/);
  } finally { prototype.stat = original; }
});
