export function validateOrg(org) {
  if (typeof org !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(org) || org.includes('--')) {
    throw new Error('Supply a GitHub organization name (1–39 letters, numbers or single hyphens; no URL).');
  }
  return org;
}

class ApiError extends Error {
  constructor(message, rateLimited = false) { super(message); this.rateLimited = rateLimited; }
}

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function declaredLicense(license) {
  return text(license?.spdx_id) && license.spdx_id !== 'NOASSERTION'
    ? license.spdx_id : null;
}
const COMMUNITY = ['contributing', 'code_of_conduct', 'issue_template', 'pull_request_template'];

function fileState(file, source = 'repository') {
  return file ? { status: 'present', source, url: text(file.html_url) }
    : { status: 'not-reported', source: null, url: null };
}

/** Shared browser/CLI core. Fetch injection enables deterministic offline tests. */
export async function audit(org, { includeArchived = false, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  validateOrg(org);
  let rateLimited = false;
  const errors = [];
  async function request(path, allow404 = false) {
    if (rateLimited) throw new ApiError('Not requested after GitHub rate limit.', true);
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error', credentials: 'omit',
      });
    } catch (error) { throw new ApiError(`Request failed for ${path}: ${error.message}`); }
    if (allow404 && response.status === 404) return { data: null, next: false };
    if (!response.ok) {
      const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
      rateLimited ||= limited;
      const reset = response.headers.get('x-ratelimit-reset');
      const retry = response.headers.get('retry-after');
      throw new ApiError(`GitHub HTTP ${response.status} for ${path}${limited ? ' (rate limited)' : ''}${reset ? `; rate-limit reset Unix seconds: ${reset}` : ''}${retry ? `; retry-after: ${retry}` : ''}`, limited);
    }
    try {
      return { data: await response.json(), next: /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') || '') };
    } catch { throw new ApiError(`Invalid JSON from GitHub for ${path}`); }
  }

  const repos = [];
  let listingComplete = true;
  for (let page = 1; ; page++) {
    try {
      const result = await request(`/orgs/${org}/repos?type=public&per_page=100&sort=full_name&direction=asc&page=${page}`);
      if (!Array.isArray(result.data)) throw new ApiError('GitHub repository list was not an array.');
      repos.push(...result.data.filter(repo => repo.private === false && (!repo.visibility || repo.visibility === 'public')));
      if (!result.next) break;
    } catch (error) { errors.push(error.message); listingComplete = false; break; }
  }
  // A repeated repository can appear if the organization changes during pagination.
  const publicRepos = [...new Map(repos.map(repo => [repo.full_name, repo])).values()];
  const selected = publicRepos.filter(repo => includeArchived || !repo.archived);
  const defaultsRepo = publicRepos.find(repo => repo.name === '.github' && !repo.fork);
  const profiles = new Map();
  const work = [...selected];
  if (defaultsRepo && !work.includes(defaultsRepo)) work.push(defaultsRepo);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
    while (cursor < work.length) {
      const repo = work[cursor++];
      // Construct paths from names; never follow URLs returned by GitHub.
      const path = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo.name)}`;
      try {
        if (repo.fork) {
          const result = await request(`${path}/readme`, true);
          profiles.set(repo.full_name, { forkReadme: result.data });
        } else {
          const result = await request(`${path}/community/profile`, true);
          if (!result.data || !result.data.files || typeof result.data.files !== 'object') {
            throw new ApiError(`Community profile unavailable for ${repo.full_name}; file presence is unknown.`);
          }
          profiles.set(repo.full_name, result.data);
        }
      } catch (error) { errors.push(error.message); }
    }
  }));
  const defaults = defaultsRepo && profiles.get(defaultsRepo.full_name)?.files;
  const repositories = selected.map(repo => {
    const profile = profiles.get(repo.full_name);
    const files = profile?.files;
    const community = Object.fromEntries(COMMUNITY.map(key => {
      if (!files) return [key, { status: 'unknown', source: null, url: null }];
      // Only community files inherit. README and license never inherit.
      const own = files[key === 'code_of_conduct' ? 'code_of_conduct_file' : key] || files[key];
      const fallback = defaults?.[key === 'code_of_conduct' ? 'code_of_conduct_file' : key] || defaults?.[key];
      const inherited = repo.name !== '.github' && typeof own?.html_url === 'string'
        && own.html_url.toLowerCase().startsWith(`https://github.com/${org.toLowerCase()}/.github/`);
      return [key, own ? fileState(own, inherited ? 'organization-default' : 'repository')
        : fallback ? fileState(fallback, 'organization-default') : fileState(null)];
    }));
    return {
      name: repo.full_name, url: `https://github.com/${org}/${encodeURIComponent(repo.name)}`,
      archived: Boolean(repo.archived), fork: Boolean(repo.fork),
      description: text(repo.description), homepage: text(repo.homepage),
      readme: files ? fileState(files.readme) : repo.fork && profile ? fileState(profile.forkReadme) : { status: 'unknown', source: null, url: null },
      license: { declared: declaredLicense(repo.license), status: declaredLicense(repo.license) ? 'declared' : 'unknown' },
      community,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { organization: org, complete: listingComplete && errors.length === 0,
    includeArchived, excludedArchived: publicRepos.filter(repo => repo.archived && !includeArchived).length,
    repositories, errors };
}
