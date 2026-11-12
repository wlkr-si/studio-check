import { audit, validateOrg } from './audit.mjs';
import { reportCsv } from './report-csv.mjs';
import { MAX_REPORT_BYTES, parseSavedReport, compareReports } from './report-compare.mjs';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#organization');
const button = document.querySelector('#audit-button');
const archived = document.querySelector('#include-archived');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
let pending = false;
let baseline = null;
let baselineName = '';
let comparisonRevision = 0;

const sharedOrg = new URL(location.href).searchParams.get('org');
if (sharedOrg !== null) input.value = sharedOrg;
archived.checked = new URL(location.href).searchParams.get('archived') === '1';

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function stateText(state) {
  return state.status === 'present' ? 'Present' : state.status === 'not-reported' ? 'Not reported' : 'Unknown';
}

function render(report) {
  comparisonRevision++;
  results.replaceChildren();
  const header = element('div', undefined, 'result-header');
  const heading = element('h2', report.complete ? 'Audit complete' : 'Audit incomplete', report.complete ? 'complete' : '');
  heading.tabIndex = -1;
  header.append(heading);
  const downloads = element('div', undefined, 'download-actions');
  for (const { extension, mime, content } of [
    { extension: 'json', mime: 'application/json', content: () => JSON.stringify(report, null, 2) + '\n' },
    { extension: 'csv', mime: 'text/csv;charset=utf-8', content: () => reportCsv(report) },
  ]) {
    const download = element('button', `Download ${extension.toUpperCase()}`, 'download');
    download.type = 'button';
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([content()], { type: mime }));
      const link = element('a');
      link.href = url;
      link.download = `${report.organization}-studio-check.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    downloads.append(download);
  }
  header.append(downloads, element('p', `${report.organization} · ${report.repositories.length} public repositories · ${report.excludedArchived} archived excluded`, 'summary'));
  results.append(header);
  if (report.errors.length) {
    const details = element('details', undefined, 'errors');
    details.open = true;
    details.append(element('summary', `${report.errors.length} request ${report.errors.length === 1 ? 'error' : 'errors'}`));
    const list = element('ul');
    for (const error of report.errors) list.append(element('li', error));
    details.append(list);
    results.append(details);
  }
  renderComparison(report);
  if (!report.repositories.length) results.append(element('p', report.complete ? 'No public repositories to report.' : 'No repositories could be reported.', 'empty'));
  const rows = [];
  if (report.repositories.length) {
    const controls = element('div', undefined, 'report-filter');
    const label = element('label', 'Filter repositories');
    label.htmlFor = 'repository-filter';
    const row = element('div', undefined, 'form-row');
    const filter = element('input');
    filter.id = 'repository-filter';
    filter.type = 'search';
    filter.autocomplete = 'off';
    filter.spellcheck = false;
    const clear = element('button', 'Clear', 'download');
    clear.type = 'button';
    clear.hidden = true;
    const count = element('p', undefined, 'summary');
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    const empty = element('p', 'No matching repositories.', 'empty');
    empty.hidden = true;
    const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    function updateFilter() {
      const terms = normalize(filter.value).trim().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const { article, text } of rows) {
        article.hidden = !terms.every(term => text.includes(term));
        if (!article.hidden) shown++;
      }
      clear.hidden = !filter.value;
      count.textContent = `${shown} of ${rows.length} repositories`;
      empty.hidden = shown > 0;
    }
    filter.addEventListener('input', updateFilter);
    clear.addEventListener('click', () => { filter.value = ''; updateFilter(); filter.focus(); });
    row.append(filter, clear);
    controls.append(label, row, count, empty);
    results.append(controls);
    // Rows are filled synchronously below, before any user input can run.
    count.textContent = `${report.repositories.length} of ${report.repositories.length} repositories`;
  }
  for (const repo of report.repositories) {
    const article = element('article', undefined, 'repository');
    const title = element('h3');
    const link = element('a', repo.name);
    // Only construct links to repository paths on github.com. Metadata URLs are never used.
    const name = repo.name.slice(repo.name.indexOf('/') + 1);
    link.href = `https://github.com/${encodeURIComponent(report.organization)}/${encodeURIComponent(name)}`;
    title.append(link);
    article.append(title, element('p', repo.description || 'Description not set', 'description'));
    const states = [
      ['README', stateText(repo.readme)], ['License declared', repo.license.declared || 'Unknown'],
      ['Contributing', stateText(repo.community.contributing), repo.community.contributing.source],
      ['Code of conduct', stateText(repo.community.code_of_conduct), repo.community.code_of_conduct.source],
      ['Issue template', stateText(repo.community.issue_template), repo.community.issue_template.source],
      ['Pull request template', stateText(repo.community.pull_request_template), repo.community.pull_request_template.source],
    ];
    const list = element('dl');
    for (const [label, value, source] of states) {
      const pair = element('div');
      const detail = element('dd', value);
      if (source === 'organization-default') detail.append(element('span', 'Organization default', 'default-source'));
      pair.append(element('dt', label), detail);
      list.append(pair);
    }
    article.append(list);
    if (repo.fork) article.append(element('p', 'Fork: community profile unavailable', 'summary'));
    rows.push({ article, text: `${repo.name} ${repo.description || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() });
    results.append(article);
  }
  results.hidden = false;
  heading.focus({ preventScroll: true });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  const org = input.value.trim();
  try { validateOrg(org); }
  catch (error) { status.textContent = error.message; input.focus(); return; }
  comparisonRevision++;
  pending = true;
  input.value = org;
  input.readOnly = true;
  const includeArchived = archived.checked;
  archived.disabled = true;
  button.disabled = true;
  button.textContent = 'Auditing…';
  results.hidden = true;
  results.setAttribute('aria-busy', 'true');
  status.textContent = `Auditing ${org}…`;
  const url = new URL(location.href);
  url.searchParams.set('org', org);
  if (includeArchived) url.searchParams.set('archived', '1');
  else url.searchParams.delete('archived');
  history.replaceState(null, '', url);
  try {
    const report = await audit(org, { includeArchived });
    render(report);
    status.textContent = report.complete ? `${org} audit complete.` : `${org} audit incomplete. Unknown results are not missing files.`;
  } catch (error) {
    status.textContent = `Audit failed: ${error.message}`;
    input.focus();
  } finally {
    pending = false;
    input.readOnly = false;
    archived.disabled = false;
    button.disabled = false;
    button.textContent = 'Audit';
    results.removeAttribute('aria-busy');
  }
});

function renderComparison(report) {
  const section = element('section', undefined, 'comparison');
  section.setAttribute('aria-label', 'Saved report comparison');
  const label = element('label', 'Compare saved JSON');
  label.htmlFor = 'baseline-file';
  const file = element('input');
  file.id = 'baseline-file';
  file.type = 'file';
  file.accept = '.json,application/json';
  const clear = element('button', 'Clear baseline', 'download');
  clear.type = 'button';
  const selection = element('p', undefined, 'summary');
  const notice = element('p', undefined, 'comparison-status');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const content = element('div');
  function update() {
    clear.hidden = !baseline;
    selection.textContent = baseline ? `Saved report: ${baselineName}` : '';
    content.replaceChildren();
    if (!baseline) return;
    let comparison;
    try { comparison = compareReports(baseline, report); }
    catch (error) { notice.textContent = `Cannot compare: ${error.message}`; return; }
    const title = element('h2', 'Changes from saved report');
    title.tabIndex = -1;
    content.append(title, element('p', `Saved: ${comparison.baselineComplete ? 'complete' : 'incomplete'} · Current: ${comparison.currentComplete ? 'complete' : 'incomplete'}`, 'summary'));
    if (!comparison.membershipConfirmed) content.append(element('p', 'At least one report is incomplete. Repository membership differences are unconfirmed; unknown file states are not missing files.', 'description'));
    if (!comparison.changes.length) content.append(element('p', comparison.membershipConfirmed ? 'No recorded changes.' : 'No differences in the collected repositories. Incomplete reports cannot establish unchanged membership.', 'description'));
    for (const change of comparison.changes) {
      const article = element('article', undefined, 'comparison-repository');
      article.append(element('h3', change.name));
      if (change.membership) article.append(element('p', change.membership));
      for (const field of change.fields) {
        const row = element('p', undefined, 'field-change');
        row.append(element('strong', field.field), element('span', `Saved: ${field.before}`), element('span', `Current: ${field.after}`));
        article.append(row);
      }
      content.append(article);
    }
  }
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const revision = ++comparisonRevision;
    file.disabled = clear.disabled = true;
    notice.textContent = 'Reading saved report…';
    try {
      if (selected.size > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
      const buffer = await selected.arrayBuffer();
      if (revision !== comparisonRevision) return;
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new Error('Saved report must be UTF-8 JSON.'); }
      const imported = parseSavedReport(text);
      // Check compatibility before replacing an existing baseline.
      compareReports(imported, report);
      baseline = imported;
      baselineName = selected.name.slice(0, 200);
      notice.textContent = 'Saved report imported locally.';
      update();
      content.querySelector('h2')?.focus({ preventScroll: true });
    } catch (error) {
      notice.textContent = `${error.message}${baseline ? ' Previous baseline retained.' : ''}`;
      file.value = '';
    } finally { file.disabled = clear.disabled = false; }
  });
  clear.addEventListener('click', () => {
    comparisonRevision++;
    baseline = null;
    baselineName = '';
    file.value = '';
    notice.textContent = 'Saved report cleared.';
    update();
    file.focus();
  });
  section.append(label, file, clear, selection, notice, content);
  update();
  results.append(section);
}
