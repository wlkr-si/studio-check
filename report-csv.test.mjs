import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, reportCsv } from './web/report-csv.mjs';

const state = (status, source = null) => ({ status, source, url: null });
function fixture() {
  return { organization: 'wlkr-si', complete: false, includeArchived: true, excludedArchived: 0,
    errors: ['GitHub HTTP 429'], repositories: [{
      name: 'wlkr-si/tool', url: 'https://github.com/wlkr-si/tool', archived: true, fork: false,
      description: 'A real tool', homepage: null, license: { declared: null, status: 'unknown' },
      readme: state('present', 'repository'), community: {
        contributing: state('present', 'organization-default'), code_of_conduct: state('unknown'),
        issue_template: state('not-reported'), pull_request_template: state('present', 'repository'),
      },
    }],
  };
}

test('CSV quotes delimiters, quotes, CRLF and accents without losing text', () => {
  assert.equal(csvCell('Café, "tool"\r\nsecond line'), '"Café, ""tool""\r\nsecond line"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(false), '"false"');
});

test('formula-like public metadata is prefixed even behind whitespace and format controls', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', '  =1+1', '\t=1+1', '\r=1+1', '\n=1+1', '\u200b=1+1', '\ufeff=1+1', '＝1+1', '\tordinary']) {
    assert.ok(csvCell(value).startsWith('"\''), JSON.stringify(value));
  }
  assert.equal(csvCell('https://example.com/?q=1+1'), '"https://example.com/?q=1+1"');
  assert.equal(csvCell('a=b'), '"a=b"');
});

test('report CSV retains incomplete mode, errors and honest file/default states', () => {
  const csv = reportCsv(fixture());
  assert.ok(csv.startsWith('\ufeff"Organization"'));
  assert.ok(csv.includes('"wlkr-si","false","true","0","GitHub HTTP 429"'));
  assert.ok(csv.includes('"unknown","present","present (organization-default)","unknown","not-reported","present"'));
  assert.equal(csv.split('\r\n').length, 3);
});

test('empty complete and incomplete reports retain context without inventing a repository', () => {
  for (const complete of [true, false]) {
    const report = { ...fixture(), complete, repositories: [] };
    const csv = reportCsv(report);
    assert.ok(csv.includes(`"wlkr-si","${complete}","true","0","GitHub HTTP 429","",""`));
    assert.equal(csv.split('\r\n').length, 3);
  }
});

test('every repository is exported and source metadata is never mutated', () => {
  const report = fixture();
  report.repositories[0].description = '=HYPERLINK("https://example.com")';
  report.repositories.push({ ...report.repositories[0], name: 'wlkr-si/second' });
  const before = structuredClone(report);
  const csv = reportCsv(report);
  assert.ok(csv.includes('"wlkr-si/tool"'));
  assert.ok(csv.includes('"wlkr-si/second"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.deepEqual(report, before);
});
