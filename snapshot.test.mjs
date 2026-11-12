import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { audit, validateOrg } from './web/audit.mjs';
import { reportCsv } from './web/report-csv.mjs';
import { compareReports, createReportSession, parseSavedReport } from './web/report-compare.mjs';

const source = await readFile(new URL('./web/app.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
const snapshotText = JSON.parse(source.match(/^export const PUBLIC_SNAPSHOT_TEXT = (.*);$/m)[1]);
const snapshot = parseSavedReport(snapshotText);
const file = (text, name = 'owned-report.json') => new File([text], name, { type: 'application/json' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Execute the real app handlers against a small DOM boundary; browser proof covers native geometry/focus.
function app({ fetchImpl = () => { throw new Error('Unexpected request'); }, auditImpl = audit } = {}) {
  const nodes = new Map(), downloads = [], blobs = new Map(), historyWrites = [];
  const document = {
    activeElement: null,
    querySelector(selector) {
      if (nodes.has(selector)) return nodes.get(selector);
      return nodes.get('#results').querySelector(selector);
    },
    createElement(tag) { return new Node(tag); },
  };
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = children; }
    addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
    async fire(event) { await Promise.all((this.listeners[event] || []).map(callback => callback({ preventDefault() {} }))); }
    click() { if (this.tagName === 'A') downloads.push({ name: this.download, blob: blobs.get(this.href) }); return this.fire('click'); }
    focus() { document.activeElement = this; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    get isConnected() { return this === nodes.get('#results') || nodes.get('#results').descendants().includes(this); }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll(selector) { return this.descendants().filter(node => selector.split(',').some(part => part.startsWith('#') ? node.id === part.slice(1) : node.tagName.toLowerCase() === part)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  for (const id of ['audit-form','organization','audit-button','include-archived','status','results','saved-report','load-snapshot']) nodes.set('#' + id, new Node(id === 'results' ? 'section' : 'input'));
  nodes.get('#organization').value = 'wlkr-si';
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = 'blob:owned-' + blobs.size; blobs.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const harness = { nodes, downloads, historyWrites, document };
  const script = source.replace(/^import .*;$/gm, '').replace('export const PUBLIC_SNAPSHOT_TEXT', 'const PUBLIC_SNAPSHOT_TEXT');
  const execute = new Function('document','location','history','audit','validateOrg','reportCsv','compareReports','createReportSession','parseSavedReport','File','AbortController','AbortSignal','fetch','URL','setTimeout', script);
  execute(document, { href: 'https://owned.invalid/?org=wlkr-si' }, { replaceState(...args) { historyWrites.push(args); } }, auditImpl, validateOrg, reportCsv, compareReports, () => (harness.session = createReportSession()), parseSavedReport, File, AbortController, AbortSignal, fetchImpl, LocalURL, callback => callback());
  harness.load = () => nodes.get('#load-snapshot').click();
  harness.buttons = () => nodes.get('#results').querySelectorAll('button');
  harness.button = label => harness.buttons().find(node => node.textContent === label);
  return harness;
}

test('embedded real public snapshot has exact source bytes/hash, strict shape and visible date', () => {
  assert.equal(Buffer.byteLength(snapshotText), 7904);
  assert.equal(createHash('sha256').update(snapshotText).digest('hex'), '18ba9eca859f9e66e9bce9887ef847c97e59db0b62418563be1f1bbfe869442e');
  assert.equal(snapshot.organization, 'wlkr-si'); assert.equal(snapshot.complete, true);
  assert.equal(snapshot.repositories.length, 6); assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.repositories.map(repo => repo.name).sort(), ['wlkr-si/.github','wlkr-si/phosphor','wlkr-si/starter','wlkr-si/studio-check','wlkr-si/ui','wlkr-si/foundation'].sort());
  assert.throws(() => parseSavedReport(JSON.stringify({ ...snapshot, capturedAt: 'invented' })), /unexpected/);
  assert.match(html, /id="load-snapshot" type="button" class="download">Load snapshot · 2026-11-12</);
});

test('actual snapshot handler uses saved rendering and full JSON/CSV exports without requests/history', async () => {
  let requests = 0;
  const h = app({ fetchImpl() { requests++; throw new Error('No request'); } });
  await h.load();
  assert.equal(requests, 0); assert.deepEqual(h.historyWrites, []);
  assert.deepEqual(h.session.state.current.report, snapshot);
  assert.equal(h.session.state.current.origin.kind, 'saved');
  assert.match(h.session.state.current.origin.name, /2026-11-12$/);
  assert.equal(h.document.activeElement.textContent, 'Saved report');
  assert.match(h.nodes.get('#results').textContent, /Opened: .*2026-11-12/);
  await h.button('Download JSON').click();
  assert.equal(await h.downloads[0].blob.text(), snapshotText);
  await h.button('Download CSV').click();
  assert.equal(await h.downloads[1].blob.text(), reportCsv(snapshot).replace(/^\uFEFF/, '')); // Blob.text removes the BOM.
  assert.equal(requests, 0);
});

test('snapshot stays enabled, aborts in-flight audit and prevents subsequent requests/stale commit', async () => {
  let requests = 0, aborted = false;
  const h = app({ fetchImpl(_url, options) {
    requests++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true }));
  } });
  const pending = h.nodes.get('#audit-form').fire('submit');
  assert.equal(h.session.state.busy, 'audit');
  assert.equal(h.nodes.get('#load-snapshot').disabled, false);
  await h.load(); await pending;
  assert.equal(aborted, true); assert.equal(requests, 1);
  assert.deepEqual(h.session.state.current.report, snapshot);
  assert.equal(h.nodes.get('#status').textContent, 'Snapshot opened.');
});

test('snapshot supersedes a late saved-current read while preserving compatible baseline', async () => {
  const h = app(); await h.load();
  const baseline = h.document.querySelector('#baseline-file');
  baseline.files = [file(snapshotText)]; await baseline.fire('change');
  const pending = deferred(), other = { ...snapshot, complete: false, errors: ['late fixture'] };
  const selected = h.nodes.get('#saved-report');
  selected.files = [{ name: 'owned-delayed.json', size: 7904, arrayBuffer: () => pending.promise }];
  const opening = selected.fire('change');
  await h.load();
  pending.resolve(new TextEncoder().encode(JSON.stringify(other)).buffer); await opening;
  assert.deepEqual(h.session.state.current.report, snapshot);
  assert.deepEqual(h.session.state.baseline.report, snapshot);
  assert.deepEqual(h.session.comparison().changes, []);
  assert.match(h.nodes.get('#status').textContent, /Snapshot opened/);
});

test('snapshot discards stale baseline read, clears and exports only the live comparison', async () => {
  const h = app(); await h.load();
  let baseline = h.document.querySelector('#baseline-file');
  baseline.files = [file(snapshotText)]; await baseline.fire('change');
  const staleDownload = h.button('Download comparison JSON');
  const pending = deferred();
  baseline.files = [{ name: 'owned-delayed-baseline.json', size: 7904, arrayBuffer: () => pending.promise }];
  const reading = baseline.fire('change');
  await h.load();
  pending.resolve(new TextEncoder().encode(snapshotText).buffer); await reading;
  assert.equal(h.session.state.baseline.name, 'owned-report.json');
  assert.deepEqual(h.session.comparison().changes, []);
  await staleDownload.click(); assert.equal(h.downloads.length, 0);
  await h.button('Download comparison JSON').click();
  assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()).changes, []);
  const download = h.button('Download comparison JSON');
  await h.button('Clear baseline').click();
  assert.equal(h.session.state.baseline, null); assert.equal(h.session.comparison(), null);
  await download.click(); assert.equal(h.downloads.length, 1);
});

test('incompatible existing baseline rejects snapshot without replacing either report', async () => {
  const other = structuredClone(snapshot);
  other.organization = 'other';
  for (const repo of other.repositories) { repo.name = repo.name.replace('wlkr-si/', 'other/'); repo.url = 'https://github.com/' + repo.name; }
  const text = JSON.stringify(other), h = app(), selected = h.nodes.get('#saved-report');
  selected.files = [file(text)]; await selected.fire('change');
  const baseline = h.document.querySelector('#baseline-file');
  baseline.files = [file(text)]; await baseline.fire('change');
  const previous = h.session.state;
  await h.load();
  assert.equal(h.session.state.current, previous.current); assert.equal(h.session.state.baseline, previous.baseline);
  assert.match(h.nodes.get('#status').textContent, /different organizations.*Reports unchanged/);
  assert.equal(h.document.activeElement, h.nodes.get('#load-snapshot'));
});
