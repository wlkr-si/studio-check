import { validateReport, fileLabel } from './report-compare.mjs';

const columns = [
  'Organization', 'Audit complete', 'Include archived', 'Archived excluded', 'Errors',
  'Repository', 'URL', 'Archived', 'Fork', 'Description', 'Homepage', 'License',
  'README', 'Contributing', 'Code of conduct', 'Issue template', 'Pull request template',
];

export function csvCell(value) {
  let text = String(value ?? '');
  // Quotes preserve CSV structure. The prefix separately prevents formula-like
  // public metadata from becoming spreadsheet expressions after whitespace trimming.
  if (/^[\s\p{Cc}\p{Cf}]*[=+@\-＝＋＠－]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function presence(state) {
  if (!state || state.status === 'unknown') return 'unknown';
  return state.status === 'present' && state.source === 'organization-default'
    ? 'present (organization-default)' : state.status;
}

/** Complete audit export, independent of the browser's visible filter. */
export function reportCsv(report) {
  const context = [report.organization, report.complete, report.includeArchived,
    report.excludedArchived, report.errors.join(' | ')];
  const rows = report.repositories.map(repo => [...context,
    repo.name, repo.url, repo.archived, repo.fork, repo.description ?? '', repo.homepage ?? '',
    repo.license.declared || 'unknown', presence(repo.readme),
    ...['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'].map(key => presence(repo.community[key])),
  ]);
  // Even an empty/failed report retains its audit context without inventing a repository.
  if (!rows.length) rows.push([...context, ...Array(columns.length - context.length).fill('')]);
  return '\ufeff' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Quote untrusted fields as literal data, making invisible layout/bidi controls visible. */
function markdownLiteral(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, character =>
    character.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}

function literalBlock(lines) {
  const text = lines.join('\n');
  let length = 3;
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const fence = '`'.repeat(length);
  return fence + 'text\n' + text + '\n' + fence;
}

/** Full factual report, independent of visible filters. No network or invented capture time. */
export function reportMarkdown(report, { origin } = {}) {
  validateReport(report);
  if (origin !== undefined && (!origin || typeof origin !== 'object' || Array.isArray(origin) ||
    !['audit', 'saved'].includes(origin.kind) ||
    Object.keys(origin).sort().join(',') !== (origin.kind === 'saved' ? 'kind,name' : 'kind') ||
    origin.kind === 'saved' && (typeof origin.name !== 'string' || !origin.name.trim()))) throw new Error('Invalid report origin.');
  const summary = [
    '# studio-check — ' + report.organization,
    '',
    '- Report complete: ' + (report.complete ? 'Yes' : 'No'),
    '- Public repositories collected: ' + report.repositories.length,
    '- Include archived: ' + (report.includeArchived ? 'Yes' : 'No'),
    '- Archived excluded: ' + report.excludedArchived,
    '- Errors: ' + report.errors.length,
    '- Origin: ' + (origin?.kind === 'saved' ? 'Saved report' : origin?.kind === 'audit' ? 'Public audit result' : 'Not supplied'),
  ];
  if (!report.complete) summary.push('', 'Incomplete report. Unknown results are not missing files.');
  const sections = [summary.join('\n')];
  const context = [];
  if (origin?.kind === 'saved') context.push('Saved report: ' + markdownLiteral(origin.name));
  report.errors.forEach((error, index) => context.push('Error ' + (index + 1) + ': ' + markdownLiteral(error)));
  if (context.length) sections.push(literalBlock(context));
  if (!report.repositories.length) sections.push(report.complete ? 'No public repositories to report.' : 'No repositories could be reported. Repository membership is unknown.');
  for (const repo of report.repositories) {
    // Only validated owner/repository names become links. Metadata URLs remain literal.
    const [owner, name] = repo.name.split('/');
    const url = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name);
    const label = repo.name.replaceAll('_', '\\_');
    const lines = [
      'Description: ' + markdownLiteral(repo.description),
      'Homepage (optional): ' + markdownLiteral(repo.homepage),
      'Archived: ' + (repo.archived ? 'Yes' : 'No'),
      'Fork: ' + (repo.fork ? 'Yes (community profile unsupported)' : 'No'),
      'License declared: ' + (repo.license.status === 'declared' ? markdownLiteral(repo.license.declared) : 'Unknown'),
    ];
    for (const [label, state] of [
      ['README', repo.readme],
      ...['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'].map((key, index) =>
        [['Contributing', 'Code of conduct', 'Issue template', 'Pull request template'][index], repo.community[key]]),
    ]) {
      lines.push(label + ': ' + fileLabel(state), label + ' URL: ' + markdownLiteral(state.url));
    }
    sections.push('## [' + label + '](' + url + ')\n\n' + literalBlock(lines));
  }
  return sections.join('\n\n');
}
