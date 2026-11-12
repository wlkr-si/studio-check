import assert from "node:assert/strict"
import process from "node:process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Client as ModernClient } from "@modelcontextprotocol/client"
import { StdioClientTransport as ModernTransport } from "@modelcontextprotocol/client/stdio"

const mcpDir = fileURLToPath(new URL(".", import.meta.url))
const emptyState = () => ({ status: "not-reported", source: null, url: null })
const fixtureProgram = `
import { createMcpServer } from "./index.mjs"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
const sleepWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => {
    clearTimeout(timer)
    reject(new DOMException("fixture aborted", "AbortError"))
  }, { once: true })
})
async function fixtureFetch(input, init) {
  if (init.credentials !== "omit" || init.redirect !== "error") throw new Error("unsafe fetch options")
  const url = new URL(input)
  process.stderr.write("FIXTURE_REQUEST:" + url.pathname + "\\n")
  if (url.pathname.startsWith("/orgs/") && url.pathname.endsWith("/repos")) {
    const org = decodeURIComponent(url.pathname.split("/")[2])
    if (org === "cancel-me" || org === "eof-me") {
      process.stderr.write("FIXTURE_STARTED:" + org + "\\n")
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          process.stderr.write("FIXTURE_ABORTED:" + org + "\\n")
          reject(new DOMException("fixture aborted", "AbortError"))
        }, { once: true })
      })
    }
    if (org.startsWith("slow-")) {
      process.stderr.write("FIXTURE_SLOW_STARTED:" + org + "\\n")
      await sleepWithSignal(350, init.signal)
    }
    if (org === "wlkr-si") return json([
      { full_name: "wlkr-si/demo", name: "demo", private: false, visibility: "public", archived: false, fork: false, description: "fixture project", homepage: null, license: { spdx_id: "MIT" } },
      { full_name: "wlkr-si/old", name: "old", private: false, visibility: "public", archived: true, fork: false, description: null, homepage: null, license: null },
      { full_name: "wlkr-si/private", name: "private", private: true, visibility: "private", archived: false, fork: false, description: "excluded", homepage: null, license: null },
    ])
    return json([])
  }
  if (url.pathname === "/repos/wlkr-si/demo/community/profile") return json({
    files: {
      readme: { html_url: "https://github.com/wlkr-si/demo/blob/main/README.md" },
      contributing: { html_url: "https://github.com/wlkr-si/demo/blob/main/CONTRIBUTING.md" },
    },
  })
  throw new Error("unexpected fixture route")
}
serveStdio(() => createMcpServer({ fetchImpl: fixtureFetch }), {
  legacy: "serve",
  onerror: error => process.stderr.write("FIXTURE_SERVER_ERROR:" + error.name + "\\n"),
})
`

const expectedReport = {
  organization: "wlkr-si",
  complete: true,
  includeArchived: false,
  excludedArchived: 1,
  repositories: [{
    name: "wlkr-si/demo",
    url: "https://github.com/wlkr-si/demo",
    archived: false,
    fork: false,
    description: "fixture project",
    homepage: null,
    readme: { status: "present", source: "repository", url: "https://github.com/wlkr-si/demo/blob/main/README.md" },
    license: { declared: "MIT", status: "declared" },
    community: {
      contributing: { status: "present", source: "repository", url: "https://github.com/wlkr-si/demo/blob/main/CONTRIBUTING.md" },
      code_of_conduct: emptyState(),
      issue_template: emptyState(),
      pull_request_template: emptyState(),
    },
  }],
  errors: [],
}

function connectClient(Client, Transport, modern) {
  const transport = new Transport({
    command: process.execPath,
    args: ["--input-type=module", "-e", fixtureProgram],
    cwd: mcpDir,
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
    maxBufferSize: 65536,
  })
  let stderr = ""
  transport.stderr?.on("data", chunk => { stderr += chunk.toString() })
  const client = new Client({ name: "studio-check-offline-wire-test", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined)
  return { client, transport, modern, get stderr() { return stderr } }
}

function call(connection, organization, extra = {}, signal) {
  const params = { name: "audit_public_org", arguments: { organization, ...extra } }
  const options = signal ? { signal } : undefined
  return connection.modern
    ? connection.client.callTool(params, options)
    : connection.client.callTool(params, undefined, options)
}
function reportFrom(result) {
  const content = result.content.find(item => item.type === "text")
  return JSON.parse(content.text)
}
async function waitForText(connection, text) {
  const deadline = Date.now() + 5000
  while (!connection.stderr.includes(text) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(connection.stderr.includes(text), "timed out waiting for " + text + "; stderr=" + connection.stderr)
}
async function withClient(t, Client, Transport, modern, exercise) {
  const connection = connectClient(Client, Transport, modern)
  t.after(async () => {
    await connection.client.close().catch(() => {})
  })
  await connection.client.connect(connection.transport)
  await exercise(connection, t)
}

for (const protocol of [
  { name: "MCP 2025-11-25 via SDK 1.32.2", Client: LegacyClient, Transport: LegacyTransport, modern: false },
  { name: "MCP 2026-07-28 via client 2.4.0", Client: ModernClient, Transport: ModernTransport, modern: true },
]) {
  test(protocol.name + " stdio wire behavior", { timeout: 20000 }, async t => {
    await withClient(t, protocol.Client, protocol.Transport, protocol.modern, async (connection, t) => {
      const listed = await connection.client.listTools()
      assert.deepEqual(listed.tools.map(tool => tool.name), ["audit_public_org"])
      assert.equal(connection.stderr.includes("FIXTURE_REQUEST:"), false)

      const invalid = await call(connection, "wlkr-si", { extra: "rejected" })
      assert.equal(invalid.isError, true)
      assert.equal(connection.stderr.includes("FIXTURE_REQUEST:"), false)

      const result = await call(connection, "wlkr-si")
      assert.equal(result.isError, undefined)
      assert.deepEqual(reportFrom(result), expectedReport)
      if (connection.modern) assert.deepEqual(result.structuredContent, expectedReport)

      const slowOne = call(connection, "slow-one")
      const slowTwo = call(connection, "slow-two")
      await Promise.all([
        waitForText(connection, "FIXTURE_SLOW_STARTED:slow-one"),
        waitForText(connection, "FIXTURE_SLOW_STARTED:slow-two"),
      ])
      const overCapacity = await call(connection, "slow-three")
      assert.equal(overCapacity.isError, true)
      assert.match(overCapacity.content[0].text, /capacity/)
      const [one, two] = await Promise.all([slowOne, slowTwo])
      assert.equal(reportFrom(one).complete, true)
      assert.equal(reportFrom(two).complete, true)
      assert.equal(reportFrom(await call(connection, "after-capacity")).organization, "after-capacity")

      const controller = new AbortController()
      const cancelled = call(connection, "cancel-me", {}, controller.signal)
      await waitForText(connection, "FIXTURE_STARTED:cancel-me")
      controller.abort()
      await assert.rejects(cancelled)
      await waitForText(connection, "FIXTURE_ABORTED:cancel-me")
      assert.equal(reportFrom(await call(connection, "after-cancel")).organization, "after-cancel")

      const eofConnection = connectClient(protocol.Client, protocol.Transport, protocol.modern)
      t.after(async () => {
        await eofConnection.client.close().catch(() => {})
      })
      await eofConnection.client.connect(eofConnection.transport)
      const pending = call(eofConnection, "eof-me")
      pending.catch(() => {})
      await waitForText(eofConnection, "FIXTURE_STARTED:eof-me")
      const eofStarted = Date.now()
      await eofConnection.transport.close()
      assert.ok(Date.now() - eofStarted < 1500, "stdio EOF should close the server promptly")
      await assert.rejects(pending)
      await waitForText(eofConnection, "FIXTURE_ABORTED:eof-me")
      await eofConnection.client.close().catch(() => {})
    })
  })
}
