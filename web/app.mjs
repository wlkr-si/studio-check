import { audit, validateOrg } from './audit.mjs';
import { reportCsv } from './report-csv.mjs';
import { compareReports, createReportSession } from './report-compare.mjs';

const form = document.querySelector('#audit-form');
const input = document.querySelector('#organization');
const button = document.querySelector('#audit-button');
const archived = document.querySelector('#include-archived');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const openSaved = document.querySelector('#saved-report');
const session = createReportSession();

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

function render({ report, origin }) {
  results.replaceChildren();
  const header = element('div', undefined, 'result-header');
  const heading = element('h2', origin.kind === 'saved' ? 'Saved report' : report.complete ? 'Audit complete' : 'Audit incomplete', report.complete ? 'complete' : '');
  heading.tabIndex = -1;
  header.append(heading);
  if (origin.kind === 'saved') header.append(element('p', `Opened: ${origin.name} · ${report.complete ? 'Complete' : 'Incomplete'}`, 'summary saved-origin'));
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

function syncControls() {
  const busy = session.state.busy;
  input.readOnly = Boolean(busy);
  archived.disabled = button.disabled = openSaved.disabled = Boolean(busy);
  button.textContent = busy === 'audit' ? 'Auditing…' : 'Audit';
  for (const control of results.querySelectorAll('button,input')) control.disabled = Boolean(busy);
  if (busy) results.setAttribute('aria-busy', 'true');
  else results.removeAttribute('aria-busy');
}

openSaved.addEventListener('change', async () => {
  const selected = openSaved.files?.[0];
  if (!selected || session.state.busy) return;
  const opening = session.openCurrent(selected);
  const revision = session.state.generation;
  let failed = false;
  syncControls();
  status.textContent = 'Opening saved report…';
  try {
    if (!await opening) return;
    const current = session.state.current;
    input.value = current.report.organization;
    archived.checked = current.report.includeArchived;
    render(current);
    status.textContent = 'Saved report opened locally.';
  } catch (error) {
    if (revision !== session.state.generation) return;
    status.textContent = `${error.message} Reports unchanged.`;
    failed = true;
  } finally {
    if (revision === session.state.generation) openSaved.value = '';
    syncControls();
    if (failed) openSaved.focus();
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (session.state.busy) return;
  const org = input.value.trim();
  try { validateOrg(org); }
  catch (error) { status.textContent = error.message; input.focus(); return; }
  input.value = org;
  const includeArchived = archived.checked;
  const auditing = session.runAudit(() => audit(org, { includeArchived }));
  const revision = session.state.generation;
  let failed = false;
  syncControls();
  status.textContent = `Auditing ${org}…`;
  const url = new URL(location.href);
  url.searchParams.set('org', org);
  if (includeArchived) url.searchParams.set('archived', '1');
  else url.searchParams.delete('archived');
  history.replaceState(null, '', url);
  try {
    if (!await auditing) return;
    render(session.state.current);
    status.textContent = session.state.current.report.complete ? `${org} audit complete.` : `${org} audit incomplete. Unknown results are not missing files.`;
  } catch (error) {
    if (revision !== session.state.generation) return;
    status.textContent = `Audit failed: ${error.message}`;
    failed = true;
  } finally { syncControls(); if (failed) input.focus(); }
});

function renderComparison(report) {
  const section = element('section', undefined, 'comparison');
  section.setAttribute('aria-label', 'Saved report comparison');
  const label = element('label', 'Compare baseline JSON');
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
    const { baseline } = session.state;
    clear.hidden = !baseline;
    selection.textContent = baseline ? `Baseline: ${baseline.name}` : '';
    content.replaceChildren();
    if (!baseline) return;
    let comparison;
    try { comparison = compareReports(baseline.report, report); }
    catch (error) { notice.textContent = `Cannot compare: ${error.message}`; return; }
    const title = element('h2', 'Changes from baseline');
    title.tabIndex = -1;
    content.append(title, element('p', `Baseline: ${comparison.baselineComplete ? 'complete' : 'incomplete'} · Current: ${comparison.currentComplete ? 'complete' : 'incomplete'}`, 'summary'));
    if (!comparison.membershipConfirmed) content.append(element('p', 'At least one report is incomplete. Repository membership differences are unconfirmed; unknown file states are not missing files.', 'description'));
    if (!comparison.changes.length) content.append(element('p', comparison.membershipConfirmed ? 'No recorded changes.' : 'No differences in the collected repositories. Incomplete reports cannot establish unchanged membership.', 'description'));
    for (const change of comparison.changes) {
      const article = element('article', undefined, 'comparison-repository');
      article.append(element('h3', change.name));
      if (change.membership) article.append(element('p', change.membership.replace('saved report', 'baseline')));
      for (const field of change.fields) {
        const row = element('p', undefined, 'field-change');
        row.append(element('strong', field.field), element('span', `Baseline: ${field.before}`), element('span', `Current: ${field.after}`));
        article.append(row);
      }
      content.append(article);
    }
  }
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected || session.state.busy) return;
    const importing = session.openBaseline(selected);
    const revision = session.state.generation;
    let failed = false;
    syncControls();
    notice.textContent = 'Reading baseline…';
    try {
      if (!await importing) return;
      notice.textContent = 'Baseline imported locally.';
      update();
      content.querySelector('h2')?.focus({ preventScroll: true });
    } catch (error) {
      if (revision !== session.state.generation) return;
      notice.textContent = `${error.message} Reports unchanged.`;
      failed = true;
    } finally {
      if (revision === session.state.generation) file.value = '';
      syncControls();
      if (failed) file.focus();
    }
  });
  clear.addEventListener('click', () => {
    if (session.state.busy) return;
    session.clearBaseline();
    file.value = '';
    notice.textContent = 'Baseline cleared.';
    update();
    file.focus();
  });
  section.append(label, file, clear, selection, notice, content);
  update();
  results.append(section);
}
