import test from 'node:test';
import assert from 'node:assert/strict';
import { audit } from './web/audit.mjs';
import { parseSavedReport, validateReport, compareReports, MAX_REPORT_BYTES, MAX_REPOSITORIES, readReportFile, createReportSession } from './web/report-compare.mjs';
const state = (status = 'unknown', source = null, url = null) => ({ status, source, url });
export function fixture() {
  return { organization: 'demo', complete: true, includeArchived: false, excludedArchived: 0, errors: [], repositories: [{ name: 'demo/tool', url: 'https://github.com/demo/tool', archived: false, fork: false, description: 'A tool', homepage: null, readme: state(), license: { declared: null, status: 'unknown' }, community: Object.fromEntries(['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'].map(key => [key, state()])) }] };
}
const copy = value => structuredClone(value);
function rejected(change) { const value = fixture(); change(value); assert.throws(() => parseSavedReport(JSON.stringify(value)), /Invalid saved report/); }
test('validates the actual audit output and does not mutate it', async () => {
  const report = await audit('demo', { fetchImpl: async url => new Response(JSON.stringify(url.includes('/orgs/') ? [{ name: 'tool', full_name: 'demo/tool', private: false }] : { files: {} })) });
  assert.deepEqual(parseSavedReport(JSON.stringify(report)), report);
  assert.equal(validateReport(report), report);
});
test('rejects malformed, non-object, prototype-key and unexpectedly nested JSON', () => {
  for (const value of ['{', 'null', '[]', '"text"', '{"__proto__":{"polluted":true}}', '['.repeat(10000) + '0' + ']'.repeat(10000)]) assert.throws(() => parseSavedReport(value));
  assert.equal({}.polluted, undefined);
  rejected(r => { r.constructor = 'unexpected'; });
  rejected(r => { delete r.errors; });
  rejected(r => { r.repositories[0].private = true; });
});
test('bounds bytes, Unicode bytes, repository count and metadata before comparison', () => {
  assert.throws(() => parseSavedReport(' '.repeat(MAX_REPORT_BYTES + 1)), /5 MiB/);
  assert.throws(() => parseSavedReport('é'.repeat(MAX_REPORT_BYTES / 2 + 1)), /5 MiB/);
  rejected(r => { r.repositories = Array(MAX_REPOSITORIES + 1).fill(r.repositories[0]); });
  rejected(r => { r.repositories[0].description = 'x'.repeat(20001); });
  rejected(r => { r.errors = Array(10001).fill('failure'); r.complete = false; });
});
test('validates identity, flags, exact keys and nonnegative archive context', () => {
  rejected(r => { r.organization = 'https://github.com/demo'; });
  rejected(r => { r.repositories[0].name = 'other/tool'; });
  rejected(r => { r.repositories[0].url = 'javascript:alert(1)'; });
  rejected(r => { r.repositories[0].url += '?redirect=https://evil.invalid'; });
  rejected(r => { r.repositories.push({ ...r.repositories[0], name: 'DEMO/TOOL' }); });
  rejected(r => { r.excludedArchived = -1; });
  rejected(r => { r.complete = 'true'; });
  rejected(r => { r.repositories[0].archived = true; });
  rejected(r => { r.includeArchived = true; r.excludedArchived = 1; });
  rejected(r => { r.errors.push('failure'); });
});
test('validates honest unknown/default/license states without prescribing a license', () => {
  rejected(r => { r.repositories[0].readme.source = 'repository'; });
  rejected(r => { r.repositories[0].readme = state('present', 'organization-default'); });
  rejected(r => { r.repositories[0].community.contributing = state('missing'); });
  rejected(r => { r.repositories[0].license.declared = 'MIT'; });
  rejected(r => { r.repositories[0].license = { status: 'declared', declared: null }; });
  rejected(r => { r.repositories[0].license = { status: 'declared', declared: 'NOASSERTION' }; });
  const r = fixture(); r.repositories[0].community.contributing = state('present', 'organization-default', 'https://github.com/demo/.github/CONTRIBUTING.md');
  assert.deepEqual(parseSavedReport(JSON.stringify(r)), r);
});
test('complete reports confirm added and removed repositories; input is unchanged', () => {
  const before = fixture(), current = fixture(); current.repositories[0].name = 'demo/new'; current.repositories[0].url = 'https://github.com/demo/new';
  const original = copy(before);
  const result = compareReports(before, current);
  assert.equal(result.membershipConfirmed, true);
  assert.deepEqual(result.changes.map(c => [c.name, c.membership]), [['demo/new', 'Added'], ['demo/tool', 'Removed']]);
  assert.deepEqual(before, original);
});
test('partial baseline, partial current and both partial never assert added or removed', () => {
  for (const flags of [[false, true], [true, false], [false, false]]) {
    const before = fixture(), current = fixture(); before.complete = flags[0]; current.complete = flags[1];
    current.repositories[0].name = 'demo/new'; current.repositories[0].url = 'https://github.com/demo/new';
    const result = compareReports(before, current);
    assert.equal(result.membershipConfirmed, false);
    assert.ok(result.changes.every(c => c.membership.includes('(unconfirmed)')));
    assert.ok(result.changes.every(c => !['Added', 'Removed'].includes(c.membership)));
  }
});
test('partial empty reports cannot establish missing membership or unchanged membership', () => {
  const before = fixture(), current = fixture(); current.repositories = []; current.complete = false; current.errors = ['Pagination failed'];
  assert.match(compareReports(before, current).changes[0].membership, /unconfirmed/);
  before.repositories = [];
  const result = compareReports(before, current); assert.deepEqual(result.changes, []); assert.equal(result.membershipConfirmed, false);
});
test('compares metadata and exact file/default/unknown transitions in shared repositories', () => {
  const before = fixture(), current = fixture();
  before.repositories[0].community.contributing = state('present', 'organization-default');
  current.repositories[0].community.contributing = state('present', 'repository');
  current.repositories[0].readme = state('not-reported');
  current.repositories[0].description = null;
  current.repositories[0].homepage = 'https://example.org';
  current.repositories[0].license = { status: 'declared', declared: 'MIT' };
  const result = compareReports(before, current);
  assert.deepEqual(result.changes[0].fields.find(f => f.field === 'Contributing'), { field: 'Contributing', before: 'Present (organization default)', after: 'Present (repository)' });
  assert.deepEqual(result.changes[0].fields.find(f => f.field === 'README'), { field: 'README', before: 'Unknown', after: 'Not reported' });
  assert.equal(result.changes[0].fields.length, 5);
});
test('null metadata differs from literal display labels and HTML remains plain comparison data', () => {
  const before = fixture(), current = fixture(); before.repositories[0].description = null; current.repositories[0].description = 'Not set';
  assert.equal(compareReports(before, current).changes[0].fields[0].after, '"Not set"');
  current.repositories[0].description = '<img src=x onerror=alert(1)>';
  assert.match(compareReports(before, current).changes[0].fields[0].after, /<img/);
});
test('requires same organization and archive mode; identity is case-insensitive', () => {
  const before = fixture(), current = fixture(); current.organization = 'DEMO';
  assert.deepEqual(compareReports(before, current).changes, []);
  current.includeArchived = true; assert.throws(() => compareReports(before, current), /Include archived/);
  current.includeArchived = false; current.organization = 'other'; current.repositories = [];
  assert.throws(() => compareReports(before, current), /different organizations/);
});
test('compares inventory states rather than file contents, URLs or JSON key order', () => {
  const before = fixture(), current = fixture();
  before.repositories[0].readme = state('present', 'repository', 'https://github.com/demo/tool/README.md');
  current.repositories[0].readme = state('present', 'repository', 'https://github.com/demo/tool/readme.md');
  assert.deepEqual(compareReports(before, current).changes, []);
});

test('identifies current-report bounds separately from imported-file errors', () => {
  const current = fixture(); current.repositories = Array(MAX_REPOSITORIES + 1).fill(current.repositories[0]);
  assert.throws(() => compareReports(fixture(), current), /Current audit cannot be compared/);
});


const savedFile = (report = fixture(), name = 'report.json') => new File([JSON.stringify(report)], name, { type: 'application/json' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const delayedFile = (wait, report = fixture()) => ({ name: 'delayed.json', size: 100, arrayBuffer: async () => { await wait.promise; return savedFile(report).arrayBuffer(); } });

test('selected files are bounded before reading and strictly decode UTF-8 and exact schema', async () => {
  const report = fixture();
  assert.deepEqual(await readReportFile(savedFile(report)), report);
  let reads = 0;
  for (const size of [MAX_REPORT_BYTES + 1, -1, Infinity, NaN]) {
    await assert.rejects(readReportFile({ size, arrayBuffer() { reads++; } }), /5 MiB/);
  }
  assert.equal(reads, 0);
  await assert.rejects(readReportFile({ size: 0, async arrayBuffer() { return new ArrayBuffer(MAX_REPORT_BYTES + 1); } }), /5 MiB/);
  await assert.rejects(readReportFile(new File([new Uint8Array([0xff])], 'bad.json')), /UTF-8/);
  await assert.rejects(readReportFile(new File(['{'], 'bad.json')), /not valid JSON/);
  await assert.rejects(readReportFile({ size: 1, async arrayBuffer() { throw new Error('secret path'); } }), /^Error: Saved report could not be read\.$/);
});

test('offline current and baseline imports retain exact report data and separate saved origin', async () => {
  const session = createReportSession(), current = fixture(), before = fixture();
  before.repositories[0].description = 'Before';
  current.repositories[0].community.contributing = state('present', 'organization-default', 'https://github.com/demo/.github/CONTRIBUTING.md');
  assert.equal(await session.openCurrent(savedFile(current, '<img>.json')), true);
  assert.deepEqual(session.state.current, { report: current, origin: { kind: 'saved', name: '<img>.json' } });
  await session.openBaseline(savedFile(before));
  assert.equal(compareReports(session.state.baseline.report, session.state.current.report).changes.length, 1);
  assert.deepEqual(current, session.state.current.report);
  session.clearBaseline();
  assert.equal(session.state.baseline, null);
  assert.deepEqual(session.state.current.report, current);
  await session.openCurrent(savedFile(current, 'x'.repeat(1000)));
  assert.equal(session.state.current.origin.name.length, 200);
});

test('malformed or incompatible imports leave both committed reports intact', async () => {
  const session = createReportSession();
  await assert.rejects(session.openBaseline(savedFile()), /before choosing a baseline/);
  await session.openCurrent(savedFile());
  await session.openBaseline(savedFile());
  const { current, baseline } = session.state;
  const otherOrg = fixture(); otherOrg.organization = 'other'; otherOrg.repositories = [];
  const otherMode = fixture(); otherMode.includeArchived = true;
  for (const file of [new File(['{'], 'bad'), savedFile(otherOrg), savedFile(otherMode)]) {
    for (const open of [() => session.openCurrent(file), () => session.openBaseline(file)]) {
      await assert.rejects(open());
      assert.equal(session.state.current, current);
      assert.equal(session.state.baseline, baseline);
      assert.equal(session.state.busy, null);
    }
  }
});

test('partial offline reports preserve unconfirmed membership and failed audits preserve both reports', async () => {
  const session = createReportSession(), partial = fixture();
  partial.complete = false; partial.repositories = []; partial.errors = ['Network failure'];
  await session.openCurrent(savedFile(partial));
  await session.openBaseline(savedFile());
  const { current, baseline } = session.state;
  const diff = compareReports(baseline.report, current.report);
  assert.equal(diff.membershipConfirmed, false);
  assert.equal(diff.changes[0].membership, 'Only in saved report (unconfirmed)');
  await assert.rejects(session.runAudit(async () => { throw new Error('offline'); }), /offline/);
  assert.equal(session.state.current, current);
  assert.equal(session.state.baseline, baseline);
  const live = fixture(); live.organization = 'new'; live.repositories = [];
  await session.runAudit(async () => live);
  assert.deepEqual(session.state.current.origin, { kind: 'audit' });
  assert.equal(session.state.baseline, baseline);
  assert.throws(() => compareReports(baseline.report, session.state.current.report), /different organizations/);
});

test('late current import cannot overwrite a newer audit or release its busy state', async () => {
  const session = createReportSession(), read = deferred(), auditResult = deferred();
  const old = session.openCurrent(delayedFile(read));
  const fresh = session.runAudit(() => auditResult.promise);
  read.resolve();
  assert.equal(await old, false);
  assert.equal(session.state.busy, 'audit');
  auditResult.resolve(fixture());
  assert.equal(await fresh, true);
  assert.equal(session.state.current.origin.kind, 'audit');
});

test('late audit success or failure cannot overwrite an opened saved report', async () => {
  for (const fail of [false, true]) {
    const session = createReportSession(), wait = deferred();
    const old = session.runAudit(() => wait.promise);
    await session.openCurrent(savedFile());
    if (fail) wait.reject(new Error('late network failure')); else wait.resolve(fixture());
    assert.equal(await old, false);
    assert.equal(session.state.current.origin.kind, 'saved');
    assert.equal(session.state.busy, null);
  }
});

test('clearing or replacing reports invalidates pending baseline imports', async () => {
  for (const clear of [false, true]) {
    const session = createReportSession(), wait = deferred();
    await session.openCurrent(savedFile());
    const old = session.openBaseline(delayedFile(wait));
    if (clear) session.clearBaseline(); else await session.openCurrent(savedFile());
    wait.resolve();
    assert.equal(await old, false);
    assert.equal(session.state.baseline, null);
  }
});

test('a rejected newer import still invalidates earlier valid reads and retains last committed pair', async () => {
  const session = createReportSession(), wait = deferred();
  await session.openCurrent(savedFile()); await session.openBaseline(savedFile());
  const { current, baseline } = session.state;
  const old = session.openCurrent(delayedFile(wait));
  await assert.rejects(session.openCurrent(new File(['null'], 'bad')));
  wait.resolve();
  assert.equal(await old, false);
  assert.equal(session.state.current, current); assert.equal(session.state.baseline, baseline);
  assert.equal(session.state.busy, null);
});


test('comparison export is absent without a valid pair and unavailable during every pending operation', async () => {
  const session = createReportSession();
  assert.equal(session.comparison(), null);
  await session.openCurrent(savedFile());
  assert.equal(session.comparison(), null);
  await session.openBaseline(savedFile());
  const expected = session.comparison();
  assert.equal(expected.membershipConfirmed, true);
  for (const kind of ['current', 'baseline', 'audit']) {
    const wait = deferred();
    const pending = kind === 'current' ? session.openCurrent(delayedFile(wait)) : kind === 'baseline' ? session.openBaseline(delayedFile(wait)) : session.runAudit(() => wait.promise);
    assert.equal(session.comparison(), null);
    wait.resolve(fixture()); await pending;
    assert.deepEqual(session.comparison(), expected);
  }
  await assert.rejects(session.openBaseline(new File(['null'], 'invalid')));
  assert.deepEqual(session.comparison(), expected);
  session.clearBaseline();
  assert.equal(session.comparison(), null);
});

test('comparison export cannot retain cleared or incompatible pairs after delayed and cancelled work', async () => {
  const session = createReportSession();
  await session.openCurrent(savedFile()); await session.openBaseline(savedFile());
  const wait = deferred(), pending = session.openBaseline(delayedFile(wait));
  session.clearBaseline(); wait.resolve();
  assert.equal(await pending, false); assert.equal(session.comparison(), null);
  await session.openBaseline(savedFile());
  for (const change of [r => { r.organization = 'other'; r.repositories = []; }, r => { r.includeArchived = true; }]) {
    const incompatible = fixture(); change(incompatible);
    await session.runAudit(async () => incompatible);
    assert.equal(session.comparison(), null);
    await session.openCurrent(savedFile());
    assert.equal(session.comparison().membershipConfirmed, true);
  }
  const old = deferred(), newer = deferred();
  const oldAudit = session.runAudit(() => old.promise);
  const newCurrent = session.openCurrent(delayedFile(newer));
  old.resolve(fixture()); assert.equal(await oldAudit, false);
  assert.equal(session.comparison(), null);
  newer.resolve(); await newCurrent;
  assert.equal(session.comparison().membershipConfirmed, true);
});
