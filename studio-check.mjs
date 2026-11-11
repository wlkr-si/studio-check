#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { audit, validateOrg } from './web/audit.mjs';
export { audit } from './web/audit.mjs';

export const HELP = `Usage: node studio-check.mjs <organization> [--json] [--include-archived]

Audit public GitHub repository descriptions, README files, declared licenses,
and community files. Homepage is optional. No token or installation needed.

  --json              Print a structured report
  --include-archived  Include archived public repositories
  --help              Show this help

Exit codes: 0 complete, 1 invalid arguments, 2 incomplete/API failure.
Missing metadata is a finding, not a command failure.
`;

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { json: false, includeArchived: false };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg === '--include-archived') options.includeArchived = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.org) throw new Error('Supply exactly one organization.');
    else options.org = arg;
  }
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

export async function main(args, { stdout = console.log, stderr = console.error, ...options } = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { stderr(safe(error.message)); stderr('Use --help for usage.'); return 1; }
  if (parsed.help) { stdout(HELP); return 0; }
  const report = await audit(parsed.org, { ...options, includeArchived: parsed.includeArchived });
  stdout(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.complete ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
