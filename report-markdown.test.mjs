import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reportMarkdown, reportCsv } from './web/report-csv.mjs';
import { audit } from './web/audit.mjs';
import { main, parseArgs, formatReport } from './studio-check.mjs';

const state = (status, source = null, url = null) => ({ status, source, url });
function report() {
  return { organization: 'demo', complete: false, includeArchived: true, excludedArchived: 0,
    errors: ['GitHub HTTP 429'], repositories: [{
      name: 'demo/tool_one', url: 'https://github.com/demo/tool_one', archived: true, fork: true,
      description: 'Café tool', homepage: 'https://example.test/tool?q=1', license: { declared: null, status: 'unknown' },
      readme: state('present', 'repository', 'https://github.com/demo/tool_one/blob/main/README.md'),
      community: { contributing: state('present', 'organization-default', 'https://github.com/demo/.github/blob/main/CONTRIBUTING.md'),
        code_of_conduct: state('unknown'), issue_template: state('not-reported'), pull_request_template: state('present', 'repository') },
    }] };
}
// Independent fence-state check: untrusted data must never escape into active Markdown.
function outsideLiteralBlocks(markdown) {
  const tick = String.fromCharCode(96), opening = new RegExp('^(' + tick + '{3,})text$'), closing = new RegExp('^' + tick + '+$');
  const output = []; let width = 0;
  for (const line of markdown.split('\n')) {
    if (width) { if (closing.test(line) && line.length >= width) width = 0; }
    else { const match = opening.exec(line); if (match) width = match[1].length; else output.push(line); }
  }
  assert.equal(width, 0, 'all literal blocks close');
  return output.join('\n');
}
function field(markdown, label) {
  const line = markdown.split('\n').find(line => line.startsWith(label + ': '));
  assert.ok(line, label);
  return JSON.parse(line.slice(label.length + 2));
}

test('Markdown preserves incomplete, archive, fork, file/default origins, URLs and errors without mutation', () => {
  const input = report(), before = structuredClone(input), csv = reportCsv(input), human = formatReport(input);
  const md = reportMarkdown(input, { origin: { kind: 'audit' } });
  for (const text of ['Report complete: No', 'Public repositories collected: 1', 'Include archived: Yes', 'Archived excluded: 0',
    'Errors: 1', 'Origin: Public audit result', 'Unknown results are not missing files.', 'Fork: Yes (community profile unsupported)',
    'README: Present (repository)', 'Contributing: Present (organization default)', 'Code of conduct: Unknown', 'Issue template: Not reported', 'License declared: Unknown']) assert.ok(md.includes(text), text);
  assert.equal(field(md, 'Description'), input.repositories[0].description);
  assert.equal(field(md, 'Homepage (optional)'), input.repositories[0].homepage);
  assert.equal(field(md, 'README URL'), input.repositories[0].readme.url);
  assert.equal(field(md, 'Contributing URL'), input.repositories[0].community.contributing.url);
  assert.equal(field(md, 'Error 1'), input.errors[0]);
  assert.match(md, /## \[demo\/tool\\_one\]\(https:\/\/github.com\/demo\/tool_one\)/);
  assert.deepEqual(input, before); assert.equal(reportCsv(input), csv); assert.equal(formatReport(input), human);
});

test('empty complete/incomplete reports retain context and do not invent membership or findings', () => {
  for (const complete of [true, false]) {
    const input = { ...report(), complete, repositories: [], errors: complete ? [] : ['listing failed'] };
    const md = reportMarkdown(input);
    assert.ok(md.includes('Report complete: ' + (complete ? 'Yes' : 'No')));
    assert.ok(md.includes('Public repositories collected: 0'));
    assert.ok(md.includes('Origin: Not supplied'));
    assert.equal(md.includes('Repository membership is unknown.'), !complete);
    assert.equal(md.includes('## ['), false);
    assert.doesNotMatch(md, /\bscore\b|\bmissing repository\b/i);
  }
});

test('hostile metadata, URLs, HTML, mentions and fence runs stay literal with reversible visible controls', () => {
  const input = report(), tick = String.fromCharCode(96);
  const hostile = '<img src=x onerror=alert(1)> @someone\n' + tick.repeat(35) + '\n[click](javascript:alert(1)) ![remote](https://evil.test/i)\r\t\u001b\u009b\u202e\u2066\u200b\u2028\u2029\u{e0001}';
  input.repositories[0].description = hostile;
  input.repositories[0].homepage = 'javascript:alert(1)';
  input.repositories[0].readme.url = 'data:text/html,<script>alert(1)</script>';
  input.repositories[0].license = { status: 'declared', declared: 'MIT </code> @someone' };
  input.errors = [hostile];
  const origin = { kind: 'saved', name: hostile };
  const md = reportMarkdown(input, { origin });
  for (const label of ['Description', 'Error 1', 'Saved report']) assert.equal(field(md, label), hostile);
  assert.equal(field(md, 'Homepage (optional)'), 'javascript:alert(1)');
  assert.equal(field(md, 'README URL'), input.repositories[0].readme.url);
  assert.ok(md.includes('\\u202e') && md.includes('\\u2066') && md.includes('\\udb40\\udc01'));
  assert.doesNotMatch(md, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u);
  const active = outsideLiteralBlocks(md);
  assert.doesNotMatch(active, /@someone|javascript:|data:|evil\.test|<img|<script|onerror/);
  assert.deepEqual([...active.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]), ['https://github.com/demo/tool_one']);
});

test('saved origins are supplied context rather than fabricated dates or authentication', () => {
  const input = report(), origin = Object.freeze({kind:'saved',name:'wlkr-si snapshot · 2026-11-12'});
  const md = reportMarkdown(input, {origin});
  assert.ok(md.includes('Origin: Saved report')); assert.equal(field(md,'Saved report'),origin.name);
  assert.doesNotMatch(outsideLiteralBlocks(md), /2026-11-12|captured|generated|authentic|timestamp/i);
  assert.doesNotMatch(reportMarkdown(input), /2026-|captured|generated|timestamp/i);
  for (const origin of [{kind:'live'}, {kind:'saved'}, {kind:'saved',name:42}, {kind:'audit',capturedAt:'invented'}]) assert.throws(()=>reportMarkdown(input,{origin}), /Invalid report origin/);
});

test('full report output is deterministic and preserves long fields, every repository and valid GitHub paths', () => {
  const input = report();
  input.repositories[0].description = 'A'.repeat(19990) + 'LAST_BYTES';
  for(let i=0;i<12;i++) input.repositories.push({...structuredClone(input.repositories[0]),name:'demo/tool-'+i,url:'https://github.com/demo/tool-'+i});
  const md = reportMarkdown(input);
  assert.equal((md.match(/^## \[/gm)||[]).length,13);
  assert.equal(field(md,'Description'),input.repositories[0].description);
  assert.ok(md.includes('LAST_BYTES'));
  assert.equal(reportMarkdown(input),md);
  const invalid = structuredClone(input); invalid.repositories[0].url='https://evil.test/demo/tool_one';
  assert.throws(()=>reportMarkdown(invalid),/GitHub path/);
  invalid.repositories[0].url='https://github.com/demo/tool_one';invalid.repositories[0].name='demo/../escape';
  assert.throws(()=>reportMarkdown(invalid),/belong/);
});

test('audit Markdown flag is exclusive with JSON and comparison, before requests or reads', async () => {
  assert.deepEqual(parseArgs(['demo','--markdown','--include-archived']),{org:'demo',json:false,markdown:true,includeArchived:true});
  let calls=0;
  for(const args of [['demo','--markdown','--json'],['--json','demo','--markdown'],['--compare','before.json','after.json','--markdown'],['demo','--markdown','--compare','before.json','after.json']]) {
    const out=[],err=[];
    assert.equal(await main(args,{fetchImpl(){calls++;throw new Error('Unexpected fetch');},stdout:value=>out.push(value),stderr:value=>err.push(value)}),1);
    assert.equal(out.length,0);assert.ok(err.length);assert.equal(calls,0);
  }
  assert.deepEqual(parseArgs(['--compare','before.json','after.json','--json']),{mode:'compare',paths:['before.json','after.json'],json:true});
});

test('actual CLI entry emits identical shared Markdown with complete/incomplete exit semantics and no further requests', async () => {
  for(const limited of [false,true]) {
    const makeFetch = async (url, options) => {
      assert.equal(url,'https://api.github.com/orgs/demo/repos?type=public&per_page=100&sort=full_name&direction=asc&page=1');
      assert.equal(options.credentials,'omit');
      return new Response('[]',{status:limited?429:200,headers:limited?{'x-ratelimit-remaining':'0'}:{}});
    };
    const expected = await audit('demo',{fetchImpl:makeFetch});
    const preload = 'globalThis.fetch=async (url,options)=>{if(url!=="https://api.github.com/orgs/demo/repos?type=public&per_page=100&sort=full_name&direction=asc&page=1"||options.credentials!=="omit")throw new Error("Unexpected request");return new Response("[]",{status:'+ (limited?429:200)+',headers:'+JSON.stringify(limited?{'x-ratelimit-remaining':'0'}:{})+'})}';
    const result = spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'studio-check.mjs','demo','--markdown'],{encoding:'utf8'});
    assert.equal(result.status,limited?2:0,result.stderr);assert.equal(result.stderr,'');
    assert.equal(result.stdout,reportMarkdown(expected,{origin:{kind:'audit'}})+'\n');
    const json=[],human=[];
    assert.equal(await main(['demo','--json'],{fetchImpl:makeFetch,stdout:value=>json.push(value)}),limited?2:0);
    assert.deepEqual(JSON.parse(json[0]),expected);
    await main(['demo'],{fetchImpl:makeFetch,stdout:value=>human.push(value)});
    assert.equal(human[0],formatReport(expected));
  }
});


test('native audit Markdown includes collected repository facts and inert metadata through the actual CLI entry', async () => {
  async function publicFixture(url, options) {
    if (!url.startsWith('https://api.github.com/') || options.credentials !== 'omit') throw new Error('Unexpected request');
    const path = new URL(url).pathname;
    if (path === '/orgs/demo/repos') return new Response(JSON.stringify([{name:'tool',full_name:'demo/tool',private:false,visibility:'public',archived:false,fork:false,description:'A CLI attachment <b>literal</b> @someone',homepage:'javascript:alert(1)',license:{spdx_id:'MIT'}}]));
    if (path === '/repos/demo/tool/community/profile') return new Response(JSON.stringify({files:{readme:{html_url:'https://github.com/demo/tool/blob/main/README.md'},contributing:{html_url:'https://github.com/demo/.github/blob/main/CONTRIBUTING.md'}}}));
    throw new Error('Unexpected request path');
  }
  const expected = await audit('demo',{fetchImpl:publicFixture});
  assert.equal(expected.complete,true);assert.equal(expected.repositories.length,1);
  const result = spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent('globalThis.fetch='+publicFixture.toString()),'studio-check.mjs','demo','--markdown'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
  assert.equal(result.stdout,reportMarkdown(expected,{origin:{kind:'audit'}})+'\n');
  assert.ok(result.stdout.includes('Contributing: Present (organization default)'));
  assert.ok(result.stdout.includes('Issue template: Not reported'));
  assert.doesNotMatch(outsideLiteralBlocks(result.stdout), /@someone|<b>|javascript:/);
});
