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

## MCP server

The optional `mcp/` package exposes two read-only tools over stdio: `audit_public_org` calls the shared public audit core, and `compare_saved_reports` compares report texts locally. Neither reads credentials or user report files, starts an HTTP listener, or changes GitHub data.

Run it from a checkout or package copy with Node.js 24 or newer:

```sh
cd mcp
npm ci --omit=dev
node index.mjs
```

For the offline fixture tests, install the test-only official clients and run:

```sh
npm ci
npm test
```

Register `node` with argument `index.mjs` and the `mcp/` working directory in an MCP client that supports stdio. This direct command keeps npm startup banners out of protocol stdout. The adapter serves both the 2025-11-25 protocol and the modern 2026-07-28 protocol. Interoperability was verified with the official TypeScript SDK client 1.32.2 on 2025-11-25 and official client 2.4.0 pinned to 2026-07-28. A real Codex CLI 0.163.0 `exec` session on Linux also completed a six-repository audit and exact saved-report self-comparison; see [Codex setup and qualification](docs/codex-cli.md). Only the explicitly listed versions and modes are qualified. Adapter tests passed on Node 24.22.3 (official archive SHA-256 verified) and 26.8.2.

`audit_public_org` accepts a GitHub organization name and optional includeArchived boolean. It uses unauthenticated public API requests only. Each audit is limited to two repository pages (at most 200 listed repositories), 256 requests, 512 KiB per response, and 8 MiB across responses. At most two operations run concurrently across both tools. The returned report is capped at 1 MiB; if repository rows must be omitted, complete becomes false and an error explains the truncation. API failures and these limits remain visible as incomplete results. Cancellation is passed through to active requests, and stdin EOF closes the server.

`compare_saved_reports` accepts exactly two required strings, `baselineJson` and `currentJson`: the JSON **text contents** of a baseline and current report, never filenames, URLs or nested report objects. Each text must match the exact current report schema, at most 5 MiB of UTF-8 and 5,000 repositories. A disjoint pair may produce up to 10,000 membership changes, provided the complete delta fits the result cap. It uses the same strict parser and comparison envelope as the CLI/browser. Organization names must match case-insensitively and archive modes must agree. Partial/unknown states and unconfirmed membership remain explicit. Saved reports do not establish capture time or authenticity. Comparison makes no network requests, follows no metadata URLs, reads no user files or environment tokens, starts no shell and stores nothing.

A successful comparison returns the complete delta as `content` JSON text and `structuredContent`, with organization, archive mode, both completeness flags, membership certainty and changes. Invalid/incompatible input returns an explicit tool error without echoing input. A delta body larger than 1 MiB returns a size error with **no partial delta**. The 1 MiB cap describes the serialized delta body, not the full MCP response: duplicated text/structured data plus outer JSON escaping can approach 3 MiB plus envelope overhead. Clients need a finite read buffer large enough for that response; qualification uses 3 MiB + 64 KiB. This does not change audit report truncation behavior.

Stdio input buffering is capped at exactly **21,037,056 bytes (20 MiB + 64 KiB)**. This accommodates two valid 5 MiB report texts under ordinary compact UTF-8 `JSON.stringify` escaping (up to two wire bytes per source byte), plus envelope/pipe-chunk overhead. Manually expanded Unicode escapes, excessive metadata, or several queued frames remain subject to that same total buffered-byte cap. Overflow is fatal to the stdio session: it closes the transport, discards buffered input and releases stdin; reconnect with a supported request. Invalid tool arguments, incompatible reports, unknown methods and recoverable SDK parse errors do not close the session. There is no unbounded input buffer. The SDK’s four-element tool-input limit is unchanged: two JSON-text properties count as two elements, independent of repository count. Cancellation/EOF abort active operations and release their slots; comparison observes cancellation between bounded parse/compare stages rather than interrupting a synchronous JSON parse mid-stage.

The MCP adapter has its own private, locked dependencies under mcp/; the browser and CLI remain dependency-free. See [MCP TypeScript SDK stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) and [protocol version negotiation](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

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

## Guarded static publication

From a clean main checkout on the release machine, run this with Node 26.8.2 and the existing Wrangler 4.153.0 executable on PATH:

    node release.mjs

The command runs the repository syntax and behavior checks, snapshots only the six tracked served files plus _headers, and adds a public build-info.json receipt in the temporary upload directory. Tests stay outside the upload; generated files do not change the tracked web/ source.

Before uploading, it captures the active 100-percent deployment and verifies every public asset and the no-transform/nosniff headers. The first receipt-less release accepts only the pinned migration source hashes; later receipts must match an accepted release tag and its committed bytes. It uploads the snapshot as an inactive version, verifies the source and deployment again, activates only that version, then checks the receipt and all six asset hashes from the public host. A failed owned activation is reconciled and restored to the prior version only after a fresh deployment-ID check; foreign or uncertain states stop without another write. The command does not read credentials itself; Wrangler uses its caller-provided authentication environment.

The publisher binds every uploaded file, including headers and configuration, to a regular-file Git blob in the declared commit. It checks the closed snapshot before and after upload, rejects changed or extra artifacts, and permits only the qualified static-only configuration. Public verification rereads the receipt after checking all six assets. Reconciliation and restoration compare against the exact baseline captured before upload, including the explicitly pinned first migration where the public receipt is absent; a different valid receipt cannot count as restoration.

Cloudflare does not provide atomic compare-and-swap for deployment activation. The publisher checks deployment identity immediately before each write and stops if an intervening deployment is observed, but a separate publisher can still race between that check and the provider write. In an uncertain race, inspect provider state before retrying.

## Checks

```sh
node --check studio-check.mjs
node --check read-saved-report.mjs
node --test *.test.mjs
```

Audit tests inject an in-memory fetch fixture and never call GitHub. Offline CLI tests use task-owned temporary files, real process entry points, FIFO/device rejection and a fetch guard; fixtures are removed after each test.

The 46 audit, CSV and saved-report comparison checks passed on Linux with Node 24.22.3 and Node 26.8.2, and on macOS with Node 26.5.0. The Node 24 run used the official Linux x64 distribution with its published SHA-256 checksum verified. The macOS run used the same committed CLI, reader, shared modules and tests without installing dependencies. These are the qualified runtime combinations; native file flags and filesystem behavior still apply.

## Browser app

Serve the `web` directory with any static HTTP server. For example, if Python 3 is already available:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open `http://127.0.0.1:8000`. Enter a GitHub organization and choose **Audit**. The form defaults to `wlkr-si`; loading the page never starts an audit. The `?org=` query preserves the form value for sharing. JSON and spreadsheet-ready CSV are downloadable after an audit or opening a saved report. Filter a finished report by repository name or description; words match together regardless of case or accents. Filtering runs locally without further API requests. Both downloads always contain the entire current report, including repositories hidden by the filter. CSV retains completeness, archive mode, request errors, unknown states and organization defaults. It prefixes formula-like metadata cells with an apostrophe for spreadsheet use; JSON preserves the original values. CSV uses UTF-8 with a byte-order mark and quoted CRLF records. An empty report retains its audit context with blank repository fields. The browser uses the same audit core as the CLI, excludes archived repositories by default, and has no account, saved history, analytics, backend, or installation. It does not open homepage or metadata-provided links.

The browser sends requests directly to GitHub without credentials or a custom User-Agent. GitHub's public API rate limits and CORS rules apply to the visitor's network. Modern browsers with ES modules, native fetch, and `AbortSignal.timeout` are required. Opening the HTML as a `file:` URL is unsupported; use HTTP. Choose **Include archived** to mirror the CLI’s `--include-archived` option. The shareable URL retains that choice as `archived=1`, and the downloaded report records the selected mode.

The public app is [studio-check.wlkr.si](https://studio-check.wlkr.si). Its canonical URL and social preview always identify the tool and never include the shared organization query. Static response headers include `no-transform`, which prevents automatic proxy script injection; this keeps the deployed HTML identical to the committed app. No account-wide analytics setting is changed.

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

Choose **Open saved report** to view a previously downloaded current JSON report without starting an audit. The heading identifies it as a saved report and shows the selected filename and completeness. Choose **Compare baseline JSON** to compare a second report against it, or against a finished audit. Opening, comparing and clearing files work offline after the app has loaded; no API request, URL/history update, upload or browser-storage write occurs. Only an explicit **Audit** sends requests and updates the shareable form URL. File selection reads the original without modifying it. **Clear baseline** removes the in-memory baseline; a page reload discards both loaded reports. A selected baseline can be reused for another audit, with an explicit incompatibility message for a different organization or Include archived mode.

The importer accepts UTF-8 JSON up to 5 MiB and 5,000 repositories, with bounded metadata and request errors. It validates the exact report structure, repository identity, unique names, archive flags, file states, and license declarations. Extra or missing fields, malformed data, or incompatible modes are rejected. Invalid or incompatible imports preserve both the current report and any baseline and say so. Controls are disabled while reading or auditing; generation guards reject delayed results from superseded operations. These bounds can reject unusually large genuine reports; the existing CLI and JSON/CSV exports are unchanged.

Comparison shows description, optional homepage, archive/fork flags, declared license, README and community-file presence/source changes. Unknown and organization-default states remain explicit. File URLs and file contents are not compared. Added/Removed describe differences between the selected reports only, and appear only when **both** report completeness flags are true. If either report is incomplete, membership differences remain unconfirmed, including empty reports. Reports have no capture timestamp or authenticity signature: comparison cannot establish their age, accuracy, or an atomic history of GitHub changes. Imported metadata is rendered as text and imported URLs are never followed. JSON/CSV downloads still contain only the entire current report, unaffected by the baseline or repository filter. **Download comparison JSON** is a separate action for a compatible report pair. Its parsed output matches the offline CLI’s `--compare before.json after.json --json`: organization, archive mode, completeness flags, membership certainty and field changes. It contains no source filenames or timestamps. Filtering does not change it; pending reads/audits disable it, and clearing the baseline or auditing an incompatible organization/mode removes it.

For local browser verification, open a real saved current report before any audit, select a baseline while offline, then use controlled GitHub response fixtures to recover to Audit. Import complete/partial/incompatible/malformed saved JSON, check literal HTML-like metadata, then clear with the keyboard. Confirm no API call occurs during import/clear, downloads stay unchanged, and the comparison fits 320px with reduced motion.

## Limits

This is a presence inventory, not a quality score, legal review, security scan, link checker, or test of whether software works. It inspects only GitHub's public metadata and community profiles. Public API rate limits apply; large organizations can exceed them. Requests time out after 10 seconds, run at most four at a time, and are not retried. After an identified rate limit, new requests stop; already running requests may finish. The API can change while pagination is in progress; duplicates are removed but a report is not an atomic snapshot. GitHub's community profile detection may lag file changes or omit file formats. Organization defaults cannot be verified if the repository list is incomplete.

API references: [organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories), [community profiles](https://docs.github.com/en/rest/metrics/community).

MIT licensed. Built by [WLKR.SI](https://wlkr.si).
