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
