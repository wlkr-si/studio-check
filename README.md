# studio-check

<a href="https://wlkr.si"><picture><source media="(prefers-color-scheme: dark)" srcset="https://wlkr.si/brand/part-of-wlkr-si-dark.svg"><img src="https://wlkr.si/brand/part-of-wlkr-si-light.svg" alt="Part of WLKR.SI" width="184" height="32"></picture></a>

See what a developer can discover about an organization's public GitHub repositories.

## Run

Requires Node.js 24 or newer. No dependencies, installation, token, or account access.

```sh
git clone https://github.com/wlkr-si/studio-check.git
cd studio-check
node studio-check.mjs wlkr-si
node studio-check.mjs wlkr-si --json
node studio-check.mjs wlkr-si --include-archived
node studio-check.mjs --help
```

The organization must be a name, not a URL. The CLI sends read-only, unauthenticated requests to `api.github.com`. It does not read credentials or environment tokens, follow returned URLs, fetch homepages, or write files.

## Report

Each public repository shows its description, optional homepage, README presence, GitHub-declared SPDX license identifier, and contribution guide, code of conduct, issue template, and pull request template presence. Archived repositories are excluded unless requested; forks are included.

`present` means GitHub reported a file. `not-reported` means a successful API response did not report one; it is not an exhaustive file search. `unknown` means the endpoint was unavailable or unsupported. Missing descriptions and homepages are shown as `not set`. An absent or unrecognized license is always `unknown`; studio-check does not infer a license or recommend changing one.

Community files from the organization's public `.github` repository are labeled `organization-default` when the repository profile does not report its own file. This reports available defaults, not proof of how every GitHub interface will apply them. README and license files never inherit. Fork community profiles are unsupported by GitHub, so their community file states remain `unknown`; their README is checked separately.

Exit codes:

- `0`: all supported requests completed, including reports with metadata gaps.
- `1`: invalid arguments.
- `2`: incomplete report because of an API, network, or profile availability error. JSON includes `complete: false` and `errors`; repositories collected before a pagination failure remain in the report.

## Checks

```sh
node --check studio-check.mjs
node --test studio-check.test.mjs
```

Tests inject an in-memory fetch fixture and never call GitHub or create disk fixtures.

## Limits

This is a presence inventory, not a quality score, legal review, security scan, link checker, or test of whether software works. It inspects only GitHub's public metadata and community profiles. Public API rate limits apply; large organizations can exceed them. Requests time out after 10 seconds, run at most four at a time, and are not retried. After an identified rate limit, new requests stop; already running requests may finish. The API can change while pagination is in progress; duplicates are removed but a report is not an atomic snapshot. GitHub's community profile detection may lag file changes or omit file formats. Organization defaults cannot be verified if the repository list is incomplete.

API references: [organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories), [community profiles](https://docs.github.com/en/rest/metrics/community).

MIT licensed. Built by [WLKR.SI](https://wlkr.si).
