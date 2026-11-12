#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { audit, validateOrg } from './web/audit.mjs';
import { reportMarkdown } from './web/report-csv.mjs';
import { comparisonReport } from './web/report-compare.mjs';
import { readSavedReport } from './read-saved-report.mjs';
export { audit } from './web/audit.mjs';

export const HELP = `Usage: node studio-check.mjs <organization> [--json | --markdown] [--include-archived]
       node studio-check.mjs --compare <before.json> <after.json> [--json]

Audit public GitHub repository descriptions, README files, declared licenses,
and community files. Homepage is optional. No token or installation needed.

  --json              Print a structured report
  --markdown          Print an audit report for a Markdown attachment
  --include-archived  Include archived public repositories
  --help              Show this help

Exit codes: 0 complete, 1 invalid arguments, 2 incomplete/API failure.
Unknown and not-reported metadata are findings, not command failures.
--json and --markdown are mutually exclusive. Markdown is audit-only;
--compare keeps its existing human/JSON formats.

--compare is offline: read only the two named regular UTF-8 JSON files.
No network, credentials or writes. Max 5 MiB/5,000 repositories per report.
Reports must use the same organization and Include archived mode.
Final-component symlinks are refused; symlinked parent directories resolve normally.
Use -- before filenames beginning with '-'. A filename '-' is not stdin.
Compare exits: 0 both reports complete (even with differences), 2 either incomplete,
1 invalid arguments, unreadable/invalid files or incompatible reports.
Incomplete membership differences remain unconfirmed. No quality scores.
--compare --help shows this help; an organization named compare still audits normally.
`;

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.includes('--compare')) {
    if (args[0] !== '--compare') throw new Error('Put --compare before both report filenames.');
    if (args.length === 2 && args[1] === '--help') return { help: true };
    const paths = [];
    let json = false, literal = false;
    for (const arg of args.slice(1)) {
      if (!literal && arg === '--') literal = true;
      else if (!literal && arg === '--json') json = true;
      else if (!literal && arg.startsWith('-')) throw new Error('Comparison accepts only --json and two report filenames.');
      else paths.push(arg);
    }
    if (paths.length !== 2 || paths.some(path => !path)) throw new Error('Supply exactly two report filenames after --compare.');
    return { mode: 'compare', paths, json };
  }
  const options = { json: false, markdown: false, includeArchived: false };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--include-archived') options.includeArchived = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.org) throw new Error('Supply exactly one organization.');
    else options.org = arg;
  }
  if (options.json && options.markdown) throw new Error('Choose either --json or --markdown.');
  validateOrg(options.org);
  return options;
}


function safe(value) { return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
export function formatReport(report) {
  const lines = [`${report.organization}: ${report.repositories.length} public repositories; ${report.excludedArchived} archived excluded`,
    report.complete ? 'Audit complete.' : 'Audit incomplete; unknown results are not missing files.'];
  for (const repo of report.repositories) {
    lines.push('', repo.name + (repo.archived ? ' [archived]' : '') + (repo.fork ? ' [fork; community profile unsupported]' : ''),
      `  Description: ${repo.description || 'not set'}`, `  Homepage (optional): ${repo.homepage || 'not set'}`,
      `  README: ${repo.readme.status}`, `  License declared: ${repo.license.declared || 'unknown'}`);
    for (const [key, file] of Object.entries(repo.community)) lines.push(`  ${key}: ${file.status}${file.source ? ` (${file.source})` : ''}`);
  }
  if (report.errors.length) lines.push('', 'Errors:', ...report.errors.map(error => `  ${error}`));
  return lines.map(safe).join('\n');
}

export function formatComparison(organization, includeArchived, comparison) {
  const lines = [`${organization}: saved report → current report; archived ${includeArchived ? 'included' : 'excluded'}`,
    `Saved: ${comparison.baselineComplete ? 'complete' : 'incomplete'}; current: ${comparison.currentComplete ? 'complete' : 'incomplete'}.`];
  if (!comparison.membershipConfirmed) lines.push('Repository membership differences are unconfirmed because at least one report is incomplete. Unknown file states are not missing files.');
  if (!comparison.changes.length) lines.push(comparison.membershipConfirmed ? 'No recorded changes.' : 'No differences in collected repositories; unchanged membership cannot be established.');
  for (const change of comparison.changes) {
    lines.push('', change.name);
    if (change.membership) lines.push(`  ${change.membership}`);
    for (const field of change.fields) lines.push(`  ${field.field}:`, `    Saved: ${field.before}`, `    Current: ${field.after}`);
  }
  return lines.map(safe).join('\n');
}

export async function main(args, { stdout = console.log, stderr = console.error, ...options } = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { stderr(safe(error.message)); stderr('Use --help for usage.'); return 1; }
  if (parsed.help) { stdout(HELP); return 0; }
  if (parsed.mode === 'compare') {
    try {
      const baseline = await readSavedReport(parsed.paths[0], 'Saved');
      const current = await readSavedReport(parsed.paths[1], 'Current');
      const comparison = comparisonReport(baseline, current);
      stdout(parsed.json ? JSON.stringify(comparison, null, 2).replace(/[\x7f-\x9f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) : formatComparison(current.organization, current.includeArchived, comparison));
      return comparison.membershipConfirmed ? 0 : 2;
    } catch (error) { stderr(safe(error.message)); return 1; }
  }
  const report = await audit(parsed.org, { ...options, includeArchived: parsed.includeArchived });
  if (parsed.markdown) {
    try { stdout(reportMarkdown(report, { origin: { kind: 'audit' } })); }
    catch (error) { stderr(safe(error.message)); return 1; }
  } else stdout(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.complete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
