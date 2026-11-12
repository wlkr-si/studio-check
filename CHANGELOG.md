# Changelog

## 0.9.0 - 2026-11-12

- Added an optional stdio MCP server with a single bounded, read-only public organization audit tool. The existing browser, CLI, and shared audit core remain dependency-free and unchanged.

## 0.8.0 — 2026-11-12

- Added primary-domain canonical and social preview metadata for the browser audit, reusing the approved WLKR.SI project image.
- Updated the description to include both public repository audits and local saved-report comparisons; query values stay out of preview metadata.
- Added a guarded static publisher that verifies served bytes and restores the prior version after an owned release failure.
