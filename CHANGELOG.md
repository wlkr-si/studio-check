# Changelog

## 0.11.0 - 2026-11-12

- Download comparison JSON for a compatible browser report pair, using the same delta envelope as the offline CLI. Current-report JSON/CSV exports stay unchanged; pending work and cleared/incompatible baselines cannot export a stale delta.

## 0.10.0 - 2026-11-12

- Open a saved current JSON report in the browser and compare a baseline entirely locally, without first auditing GitHub. Saved origins remain visible and full JSON/CSV downloads retain the report data.
- Invalid imports preserve both reports; bounded strict file reads and guarded asynchronous state prevent stale imports and audits from replacing newer results.

## 0.9.0 - 2026-11-12

- Added an optional stdio MCP server with a single bounded, read-only public organization audit tool. The existing browser, CLI, and shared audit core remain dependency-free and unchanged.

## 0.8.0 — 2026-11-12

- Added primary-domain canonical and social preview metadata for the browser audit, reusing the approved WLKR.SI project image.
- Updated the description to include both public repository audits and local saved-report comparisons; query values stay out of preview metadata.
- Added a guarded static publisher that verifies served bytes and restores the prior version after an owned release failure.
