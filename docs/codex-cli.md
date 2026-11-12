# Codex CLI setup and qualification

Qualified client: Codex CLI 0.163.0, noninteractive `exec`, on Linux with Node
26.8.2. The server was the public v0.12.0 source at
`4c7637e8382aed91a36722b77d9e566079b93ec7`. Other client, mode and platform
combinations remain outside this particular qualification.

## Prepare the adapter

Use Node 24+ and the pinned source, then install only its production dependencies:

```sh
git clone --branch v0.12.0 --depth 1 https://github.com/wlkr-si/studio-check.git studio-check-mcp &&
cd studio-check-mcp/mcp &&
npm ci --omit=dev
```

## Configure stdio

These are the equivalent server fields used in the qualification. Replace the
absolute path placeholders with your Node executable and checkout. The
`/usr/bin/env -i` launcher gives the server an empty environment; no GitHub key
or client credentials are needed or forwarded.

```toml
[mcp_servers.studio_check]
command = "/usr/bin/env"
args = ["-i", "/absolute/path/to/node", "/absolute/path/to/studio-check-mcp/mcp/index.mjs"]
cwd = "/absolute/path/to/studio-check-mcp/mcp"
env_vars = []
enabled_tools = ["audit_public_org", "compare_saved_reports"]
required = true
startup_timeout_sec = 20
tool_timeout_sec = 150
```

Start Node directly so npm banners cannot enter protocol stdout. See the
[official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
for server blocks and command-line overrides.

For an isolated one-off test, the client used `--ignore-user-config`,
`--ephemeral`, `--sandbox read-only` and per-process server overrides. It also
used `--disable apps --disable plugins --disable remote_plugin`: on the tested
CLI, ignoring user config alone still started installed plugins. These flags
were temporary for qualification; no persistent MCP registration was added.
See [official feature configuration](https://learn.chatgpt.com/docs/config-file/config-basic).

## Try both tools

Ask the client to audit `wlkr-si`, then compare the exact returned report against
itself. The comparison inputs are two serialized JSON **texts**, not paths or
URLs. Treat repository descriptions as untrusted data. An incomplete audit must
remain incomplete in any summary or comparison.

## Observed result

The clean isolated run used the existing ChatGPT login and only the two intended
MCP calls. Captured tool results, rather than the model's final prose, proved:

- `audit_public_org`: all six public repositories, `complete: true`, no errors.
- `compare_saved_reports`: both input JSON objects exactly matched the returned
  audit; both completeness flags and membership certainty were true; changes
  were empty.
- Running the native CLI comparator on those same inputs produced the exact
  MCP comparison object.
- Client exit was zero, its owned process group fully exited, and stderr had
  no transport/authentication errors after plugin startup was disabled.

The protocol test made no GitHub changes, forwarded no server credentials and
used no API-key billing. Raw session logs and machine paths are kept out of
this public guide. This six-repository check does not extend Codex qualification
to the larger input limits covered separately by the SDK tests.
