import { validateOrg } from './audit.mjs';

export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
export const MAX_REPOSITORIES = 5000;
const COMMUNITY = ['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'];
function invalid(detail) { throw new Error(`Invalid saved report: ${detail}.`); }
function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(`${label} has unexpected or missing fields`);
}
function string(value, max, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > max || !value.trim()) invalid(`${label} must be nonempty text up to ${max} characters${nullable ? ' or null' : ''}`);
}
function file(value, label, defaults = true) {
  record(value, ['status', 'source', 'url'], label);
  if (!['present', 'not-reported', 'unknown'].includes(value.status)) invalid(`${label} status`);
  if (value.status === 'present') {
    if (!(defaults ? ['repository', 'organization-default'] : ['repository']).includes(value.source)) invalid(`${label} source`);
    string(value.url, 4096, `${label} URL`, true);
  } else if (value.source !== null || value.url !== null) invalid(`${label} unknown/not-reported source and URL must be null`);
}
/** Validate the exact current JSON report shape. Never follow imported URLs. */
export function validateReport(report) {
  record(report, ['organization', 'complete', 'includeArchived', 'excludedArchived', 'repositories', 'errors'], 'report');
  try { validateOrg(report.organization); } catch { invalid('organization name'); }
  if (typeof report.complete !== 'boolean' || typeof report.includeArchived !== 'boolean' || !Number.isSafeInteger(report.excludedArchived) || report.excludedArchived < 0) invalid('audit context');
  if (!Array.isArray(report.errors) || report.errors.length > 10000) invalid('errors must be an array of at most 10000 entries');
  for (const error of report.errors) string(error, 8192, 'request error');
  if (report.complete && report.errors.length) invalid('a complete report cannot contain request errors');
  if (report.includeArchived && report.excludedArchived !== 0) invalid('archive context');
  if (!Array.isArray(report.repositories) || report.repositories.length > MAX_REPOSITORIES) invalid(`repositories must be an array of at most ${MAX_REPOSITORIES} entries`);
  const names = new Set();
  for (const repo of report.repositories) {
    record(repo, ['name', 'url', 'archived', 'fork', 'description', 'homepage', 'readme', 'license', 'community'], 'repository');
    string(repo.name, 140, 'repository name');
    const parts = repo.name.split('/');
    if (parts.length !== 2 || parts[0].toLowerCase() !== report.organization.toLowerCase() || !/^[a-z\d_.-]{1,100}$/i.test(parts[1]) || ['.', '..'].includes(parts[1])) invalid('repository must belong to the report organization');
    const key = repo.name.toLowerCase();
    if (names.has(key)) invalid('duplicate repository');
    names.add(key);
    if (typeof repo.url !== 'string' || repo.url.toLowerCase() !== `https://github.com/${repo.name}`.toLowerCase()) invalid('repository URL must match its GitHub path');
    if (typeof repo.archived !== 'boolean' || typeof repo.fork !== 'boolean' || repo.archived && !report.includeArchived) invalid('repository flags');
    string(repo.description, 20000, 'description', true);
    string(repo.homepage, 4096, 'homepage', true);
    file(repo.readme, 'README', false);
    record(repo.license, ['declared', 'status'], 'license');
    if (repo.license.status === 'declared') {
      string(repo.license.declared, 256, 'declared license');
      if (repo.license.declared === 'NOASSERTION') invalid('unrecognized license must remain unknown');
    }
    else if (repo.license.status !== 'unknown' || repo.license.declared !== null) invalid('license declaration');
    record(repo.community, COMMUNITY, 'community files');
    for (const key of COMMUNITY) file(repo.community[key], key);
  }
  return report;
}
export function parseSavedReport(text) {
  if (typeof text !== 'string' || text.length > MAX_REPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('Saved report is not valid JSON.'); }
  return validateReport(report);
}
export function fileLabel(value) {
  return value.status === 'present' ? `Present (${value.source === 'organization-default' ? 'organization default' : 'repository'})` : value.status === 'unknown' ? 'Unknown' : 'Not reported';
}
function fields(repo) {
  return [
    ['Description', repo.description === null ? 'Not set' : JSON.stringify(repo.description)], ['Homepage (optional)', repo.homepage === null ? 'Not set' : JSON.stringify(repo.homepage)],
    ['Archived', repo.archived ? 'Yes' : 'No'], ['Fork', repo.fork ? 'Yes' : 'No'],
    ['README', fileLabel(repo.readme)], ['License declared', repo.license.declared === null ? 'Unknown' : `Declared: ${repo.license.declared}`],
    ...COMMUNITY.map((key, i) => [['Contributing', 'Code of conduct', 'Issue template', 'Pull request template'][i], fileLabel(repo.community[key])]),
  ];
}
/** Missing membership is never interpreted as added/removed if either report is incomplete. */
export function compareReports(baseline, current) {
  validateReport(baseline);
  try { validateReport(current); }
  catch (error) { throw new Error(`Current audit cannot be compared: ${error.message.replace('Invalid saved report: ', '')}`); }
  if (baseline.organization.toLowerCase() !== current.organization.toLowerCase()) throw new Error('Reports belong to different organizations.');
  if (baseline.includeArchived !== current.includeArchived) throw new Error('Reports use different Include archived modes.');
  const membershipConfirmed = baseline.complete && current.complete;
  const before = new Map(baseline.repositories.map(repo => [repo.name.toLowerCase(), repo]));
  const after = new Map(current.repositories.map(repo => [repo.name.toLowerCase(), repo]));
  const changes = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(key), now = after.get(key);
    if (!old || !now) {
      changes.push({ name: (now || old).name, membership: now ? membershipConfirmed ? 'Added' : 'Only in current report (unconfirmed)' : membershipConfirmed ? 'Removed' : 'Only in saved report (unconfirmed)', fields: [] });
      continue;
    }
    const previous = fields(old), next = fields(now);
    const changed = next.flatMap(([field, value], i) => value === previous[i][1] ? [] : [{ field, before: previous[i][1], after: value }]);
    if (changed.length) changes.push({ name: now.name, membership: null, fields: changed });
  }
  return { baselineComplete: baseline.complete, currentComplete: current.complete, membershipConfirmed, changes };
}

/** Read only a selected File's bounded bytes; never follow metadata URLs. */
export async function readReportFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch { throw new Error('Saved report could not be read.'); }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('Saved report must be UTF-8 JSON.'); }
  return parseSavedReport(text);
}

/** In-memory transactions shared by the browser and controlled async tests. */
export function createReportSession() {
  let current = null, baseline = null, busy = null, generation = 0;
  const name = file => typeof file.name === 'string' ? file.name.slice(0, 200) : 'Saved report';
  async function operation(kind, read, commit) {
    const revision = ++generation;
    busy = kind;
    try {
      const value = await read();
      if (revision !== generation) return false;
      commit(value);
      return true;
    } catch (error) {
      if (revision !== generation) return false;
      throw error;
    } finally { if (revision === generation) busy = null; }
  }
  return {
    get state() { return { current, baseline, busy, generation }; },
    openCurrent(file) {
      return operation('current', () => readReportFile(file), report => {
        if (baseline) compareReports(baseline.report, report);
        current = { report, origin: { kind: 'saved', name: name(file) } };
      });
    },
    openBaseline(file) {
      return operation('baseline', () => readReportFile(file), report => {
        if (!current) throw new Error('Open or audit a current report before choosing a baseline.');
        compareReports(report, current.report);
        baseline = { report, name: name(file) };
      });
    },
    runAudit(read) {
      return operation('audit', read, report => { current = { report, origin: { kind: 'audit' } }; });
    },
    clearBaseline() { generation++; busy = null; baseline = null; },
  };
}
