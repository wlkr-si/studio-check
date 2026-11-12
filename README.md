# studio-check

<a href="https://wlkr.si"><picture><source media="(prefers-color-scheme: dark)" srcset="https://wlkr.si/brand/part-of-wlkr-si-dark.svg"><img src="https://wlkr.si/brand/part-of-wlkr-si-light.svg" alt="Part of WLKR.SI" width="184" height="32"></picture></a>

See what a developer can discover about an organization's public GitHub repositories.

[Run the browser audit](https://studio-check.wlkr.si) · [Use the CLI](#run)

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

The organization must be a name, not a URL. The organization audit sends read-only, unauthenticated requests to `api.github.com`. It does not read credentials or environment tokens, follow returned URLs, fetch homepages, or write files.

## Offline CLI comparison

```sh
node studio-check.mjs --compare before.json after.json
node studio-check.mjs --compare before.json after.json --json
node studio-check.mjs --compare --json -- "-before report.json" "-after report.json"
node studio-check.mjs --compare --help
```

`--compare` must come first and takes exactly two filenames. It reads only those named report files, calls the same parser/comparator as the browser, and makes no network request or credential lookup. It writes no report or cache. The first file is the saved baseline; the second is the current report. JSON output is a comparison object with organization, archive mode, both completeness flags, membership certainty and per-repository changes. Human output removes terminal control characters; comparison JSON preserves them as escaped data. It does not change the audit JSON/CSV formats. An organization literally named `compare` still works with the existing audit invocation.

Each input must be a readable regular UTF-8 JSON file of at most 5 MiB and 5,000 repositories matching the exact current report schema. File size is checked before reading, and reads stop at the limit plus one byte even if a file grows. Directories, FIFOs and devices are refused. Final-component symlinks are refused; symlinked parent directories resolve normally and hard links behave as regular files. `--` lets filenames begin with a hyphen; a filename `-` is a file, never stdin. File-open/read errors do not print paths or file contents. Keep the files unchanged while comparing; the reader cannot make concurrent external edits into an atomic snapshot.

Offline file safety requires Node's nonblocking/no-follow open flags (Linux and macOS); unsupported platforms fail explicitly rather than following a link or potentially waiting on a special file. These flags and regular-file checks do not guarantee a deadline for a stalled network filesystem. See [Node file-open constants](https://nodejs.org/download/release/v26.8.2/docs/api/fs.html#file-open-constants).

Comparison requires matching organization names (case-insensitive) and Include archived modes. Exit **0** means both reports claim completeness, including when differences exist. Exit **2** means either report is incomplete; repository membership differences remain unconfirmed. Exit **1** means argument, read, validation or compatibility failure. Metadata differences are observations, not a quality score. Saved files have no timestamp or authenticity proof; the command cannot establish their age or truth. See [comparison scope and limits](#compare-a-saved-report).

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
node --check read-saved-report.mjs
node --test *.test.mjs
```

Audit tests inject an in-memory fetch fixture and never call GitHub. Offline CLI tests use task-owned temporary files, real process entry points, FIFO/device rejection and a fetch guard; fixtures are removed after each test.

## Browser app

Serve the `web` directory with any static HTTP server. For example, if Python 3 is already available:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open `http://127.0.0.1:8000`. Enter a GitHub organization and choose **Audit**. The form defaults to `wlkr-si`; loading the page never starts an audit. The `?org=` query preserves the form value for sharing. JSON and spreadsheet-ready CSV are downloadable after an actual result. Filter a finished report by repository name or description; words match together regardless of case or accents. Filtering runs locally without further API requests. Both downloads always contain the complete audit, including repositories hidden by the filter. CSV retains completeness, archive mode, request errors, unknown states and organization defaults. It prefixes formula-like metadata cells with an apostrophe for spreadsheet use; JSON preserves the original values. CSV uses UTF-8 with a byte-order mark and quoted CRLF records. An empty report retains its audit context with blank repository fields. The browser uses the same audit core as the CLI, excludes archived repositories by default, and has no account, saved history, analytics, backend, or installation. It does not open homepage or metadata-provided links.

The browser sends requests directly to GitHub without credentials or a custom User-Agent. GitHub's public API rate limits and CORS rules apply to the visitor's network. Modern browsers with ES modules, native fetch, and `AbortSignal.timeout` are required. Opening the HTML as a `file:` URL is unsupported; use HTTP. Choose **Include archived** to mirror the CLI’s `--include-archived` option. The shareable URL retains that choice as `archived=1`, and the downloaded report records the selected mode.

The public app is [studio-check.wlkr.si](https://studio-check.wlkr.si). Its static response headers include `no-transform`, which prevents automatic proxy script injection; this keeps the deployed HTML identical to the committed app. No account-wide analytics setting is changed.

`wrangler.jsonc` describes static assets only, with no Worker runtime, functions, domain routes, or paid bindings. The `web` directory is the entire deployable artifact; keep source tests, git metadata, credentials, and fixture files outside it. Provider costs and domain setup must be checked separately before a deployment. Nothing in the run/check commands deploys or publishes the app.

Validate source syntax and the shared behavior before publishing:

```sh
node --check studio-check.mjs
node --check web/audit.mjs
node --check web/app.mjs
node --check web/report-csv.mjs
node --check web/report-compare.mjs
node --test *.test.mjs
```

For browser verification, serve `web`, confirm no API request happens before **Audit**, run an audit, and check complete, incomplete, empty, and rate-limit results. Check keyboard focus and a 320px viewport. Public descriptions must render as text, including strings resembling HTML; repository links must stay on `github.com`. Browser results are live public metadata, not bundled demo results.

## Compare a saved report

After an audit finishes, choose **Compare saved JSON** and select a report previously downloaded from studio-check. Import and comparison happen in memory in this browser; no file, filename, metadata, or comparison is uploaded or saved to browser storage. **Clear baseline** discards it. A page reload also discards it. A selected baseline can be reused for another audit, with an explicit incompatibility message for a different organization or Include archived mode.

The importer accepts UTF-8 JSON up to 5 MiB and 5,000 repositories, with bounded metadata and request errors. It validates the exact report structure, repository identity, unique names, archive flags, file states, and license declarations. Extra or missing fields, malformed data, or incompatible modes are rejected. Invalid imports keep any previous baseline and say so. These bounds can reject unusually large genuine reports; the existing CLI and JSON/CSV exports are unchanged.

Comparison shows description, optional homepage, archive/fork flags, declared license, README and community-file presence/source changes. Unknown and organization-default states remain explicit. File URLs and file contents are not compared. Added/Removed describe differences between the selected reports only, and appear only when **both** report completeness flags are true. If either report is incomplete, membership differences remain unconfirmed, including empty reports. Reports have no capture timestamp or authenticity signature: comparison cannot establish their age, accuracy, or an atomic history of GitHub changes. Imported metadata is rendered as text and imported URLs are never followed. JSON/CSV downloads still contain only the entire current audit, unaffected by the baseline or repository filter.

For local browser verification, use controlled GitHub response fixtures, import complete/partial/incompatible/malformed saved JSON, check literal HTML-like metadata, then clear with the keyboard. Confirm no API call occurs during import/clear, downloads stay unchanged, and the comparison fits 320px with reduced motion.

## Limits

This is a presence inventory, not a quality score, legal review, security scan, link checker, or test of whether software works. It inspects only GitHub's public metadata and community profiles. Public API rate limits apply; large organizations can exceed them. Requests time out after 10 seconds, run at most four at a time, and are not retried. After an identified rate limit, new requests stop; already running requests may finish. The API can change while pagination is in progress; duplicates are removed but a report is not an atomic snapshot. GitHub's community profile detection may lag file changes or omit file formats. Organization defaults cannot be verified if the repository list is incomplete.

API references: [organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories), [community profiles](https://docs.github.com/en/rest/metrics/community).

MIT licensed. Built by [WLKR.SI](https://wlkr.si).
