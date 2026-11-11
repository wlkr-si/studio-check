import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, parseArgs, main, formatReport } from './studio-check.mjs';

const repo = (name, more = {}) => ({ name, full_name: `demo/${name}`, private: false, visibility: 'public', archived: false, fork: false, ...more });
const file = name => ({ html_url: `https://github.com/demo/tool/blob/main/${name}` });
const profile = (files = {}) => ({ files });
function fixture(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['User-Agent'], undefined);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const route = routes[path];
    assert.ok(route, `Unexpected request ${path}`);
    if (route instanceof Error) throw route;
    return new Response(JSON.stringify(route.body), { status: route.status || 200, headers: route.headers });
  };
  return { fetchImpl, calls };
}
const list = page => `/orgs/demo/repos?type=public&per_page=100&sort=full_name&direction=asc&page=${page}`;
const community = name => `/repos/demo/${name}/community/profile`;

test('reports metadata and files without fetching user supplied URLs', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool', { description: ' A tool ', homepage: 'https://example.org', license: { spdx_id: 'MIT' } })] },
    [community('tool')]: { body: profile({ readme: file('README.md'), contributing: file('CONTRIBUTING.md') }) } });
  const report = await audit('demo', f);
  assert.equal(report.complete, true);
  assert.equal(report.repositories[0].description, 'A tool');
  assert.equal(report.repositories[0].readme.status, 'present');
  assert.equal(report.repositories[0].license.declared, 'MIT');
  assert.equal(report.repositories[0].community.contributing.source, 'repository');
  assert.equal(f.calls.length, 2);
  assert.match(formatReport(report), /Homepage \(optional\): https:\/\/example.org/);
});

test('paginates; excludes private and archived repositories by default', async () => {
  const f = fixture({ [list(1)]: { body: [repo('one'), repo('secret', { private: true }), repo('old', { archived: true })], headers: { link: '<https://api.github.com/arbitrary>; rel="next"' } },
    [list(2)]: { body: [repo('two'), repo('one')] },
    [community('one')]: { body: profile() }, [community('two')]: { body: profile() } });
  const report = await audit('demo', f);
  assert.deepEqual(report.repositories.map(r => r.name), ['demo/one', 'demo/two']);
  assert.equal(report.excludedArchived, 1);
  assert.equal(f.calls.length, 4);
});

test('includes archived only when requested', async () => {
  const f = fixture({ [list(1)]: { body: [repo('old', { archived: true })] }, [community('old')]: { body: profile() } });
  const report = await audit('demo', { ...f, includeArchived: true });
  assert.equal(report.repositories[0].archived, true);
  assert.equal(report.excludedArchived, 0);
});

test('reports organization defaults without inheriting README or license', async () => {
  const defaults = profile({ contributing: file('CONTRIBUTING.md'), code_of_conduct_file: file('CODE_OF_CONDUCT.md'), issue_template: file('ISSUE_TEMPLATE.md'), pull_request_template: file('PULL_REQUEST_TEMPLATE.md'), readme: file('README.md'), license: { spdx_id: 'MIT' } });
  const f = fixture({ [list(1)]: { body: [repo('.github'), repo('tool')] },
    [community('.github')]: { body: defaults }, [community('tool')]: { body: profile() } });
  const tool = (await audit('demo', f)).repositories.find(r => r.name === 'demo/tool');
  for (const state of Object.values(tool.community)) assert.equal(state.source, 'organization-default');
  assert.equal(tool.readme.status, 'not-reported');
  assert.deepEqual(tool.license, { declared: null, status: 'unknown' });
});

test('absent metadata and unrecognized license stay unknown or not reported', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool', { license: { name: 'Other', spdx_id: 'NOASSERTION' } })] }, [community('tool')]: { body: profile() } });
  const tool = (await audit('demo', f)).repositories[0];
  assert.equal(tool.description, null);
  assert.equal(tool.homepage, null);
  assert.equal(tool.license.status, 'unknown');
  assert.equal(tool.community.contributing.status, 'not-reported');
});

test('an inherited file returned directly by GitHub is labeled as a default', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool')] }, [community('tool')]: { body: profile({
    contributing: { html_url: 'https://github.com/demo/.github/blob/main/CONTRIBUTING.md' },
  }) } });
  const report = await audit('demo', f);
  assert.equal(report.repositories[0].community.contributing.source, 'organization-default');
});

test('rate limits are explicit and produce an incomplete JSON report and exit 2', async () => {
  const f = fixture({ [list(1)]: { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } } });
  const output = [];
  const code = await main(['demo', '--json'], { ...f, stdout: x => output.push(x) });
  const report = JSON.parse(output[0]);
  assert.equal(code, 2);
  assert.equal(report.complete, false);
  assert.match(report.errors[0], /rate limited.*2000000000/);
});

test('profile network failure leaves file states unknown', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool')] }, [community('tool')]: new Error('offline') });
  const report = await audit('demo', f);
  assert.equal(report.complete, false);
  assert.equal(report.repositories[0].readme.status, 'unknown');
  assert.match(report.errors[0], /offline/);
});

test('timeout aborts a stalled request and marks the report incomplete', async () => {
  // Keep the event loop alive: AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const report = await audit('demo', { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    assert.equal(report.complete, false);
    assert.match(report.errors[0], /timeout/i);
  } finally { clearTimeout(keepAlive); }
});

test('later pagination failure retains collected repositories and marks partial', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool')], headers: { link: '<unused>; rel="next"' } },
    [list(2)]: { status: 500, body: {} }, [community('tool')]: { body: profile() } });
  const report = await audit('demo', f);
  assert.equal(report.complete, false);
  assert.equal(report.repositories.length, 1);
  assert.match(report.errors[0], /HTTP 500/);
});

test('fork README is checked but unsupported community files are unknown', async () => {
  const f = fixture({ [list(1)]: { body: [repo('fork', { fork: true })] }, '/repos/demo/fork/readme': { status: 404, body: {} } });
  const report = await audit('demo', f);
  assert.equal(report.complete, true);
  assert.equal(report.repositories[0].readme.status, 'not-reported');
  assert.equal(report.repositories[0].community.contributing.status, 'unknown');
});

test('unavailable profile does not claim files are missing', async () => {
  const f = fixture({ [list(1)]: { body: [repo('tool')] }, [community('tool')]: { status: 404, body: {} } });
  const report = await audit('demo', f);
  assert.equal(report.complete, false);
  assert.equal(report.repositories[0].community.contributing.status, 'unknown');
});

test('arguments are validated before any request; help and findings exit successfully', async () => {
  for (const args of [[], ['https://github.com/demo'], ['../demo'], ['-demo'], ['demo-'], ['de--mo'], ['a'.repeat(40)], ['demo', 'other'], ['demo', '--token']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['x']).org, 'x');
  assert.equal(parseArgs(['demo-org', '--json', '--include-archived']).includeArchived, true);
  const output = [];
  assert.equal(await main(['--help'], { stdout: x => output.push(x), fetchImpl: () => assert.fail('network') }), 0);
  assert.match(output[0], /Usage/);
  assert.equal(await main(['bad/url'], { stderr: () => {}, fetchImpl: () => assert.fail('network') }), 1);
  const f = fixture({ [list(1)]: { body: [] } });
  assert.equal(await main(['demo'], { ...f, stdout: () => {} }), 0);
});

test('at most four profile requests run concurrently', async () => {
  let active = 0, peak = 0;
  const report = await audit('demo', { fetchImpl: async url => {
    if (url.includes('/orgs/')) return new Response(JSON.stringify(Array.from({ length: 9 }, (_, i) => repo(`r${i}`))));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return new Response(JSON.stringify(profile()));
  } });
  assert.equal(report.repositories.length, 9);
  assert.equal(peak, 4);
});

test('terminal output removes control characters from public metadata', () => {
  const report = { organization: 'demo', repositories: [{ name: 'demo/tool', description: '\u001b[2Jhello\nworld', homepage: null, readme: { status: 'unknown' }, license: {}, community: {} }], excludedArchived: 0, complete: true, errors: [] };
  assert.doesNotMatch(formatReport(report), /\u001b/);
});

test('browser-compatible entry exports the same audit and validates before fetch', async () => {
  const core = await import('./web/audit.mjs');
  assert.equal(core.audit, audit);
  for (const value of [null, undefined, 42, {}, 'https://github.com/demo']) {
    await assert.rejects(core.audit(value, { fetchImpl: () => assert.fail('must not request invalid org') }));
  }
  const f = fixture({ [list(1)]: { body: [] } });
  assert.deepEqual((await core.audit('demo', f)).repositories, []);
});
