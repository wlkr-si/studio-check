import assert from "node:assert/strict"
import process from "node:process"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { MAX_STDIO_BUFFER_BYTES, MAX_RESULT_BYTES } from "./index.mjs"
import { MAX_REPORT_BYTES } from "../web/report-compare.mjs"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Client as ModernClient } from "@modelcontextprotocol/client"
import { StdioClientTransport as ModernTransport } from "@modelcontextprotocol/client/stdio"

const mcpDir = fileURLToPath(new URL(".", import.meta.url))
const emptyState = () => ({ status: "not-reported", source: null, url: null })
const fixtureProgram = `
import { createMcpServer, compareWithLimits, MAX_STDIO_BUFFER_BYTES } from "./index.mjs"
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
const waitForRelease = async (signal, suffix = "") => {
  const { access } = await import("node:fs/promises")
  const deadline = Date.now() + 10000
  while (true) {
    if (signal.aborted) throw new DOMException("fixture aborted", "AbortError")
    try { await access(process.env.STUDIO_TEST_GATE + suffix); return } catch {}
    if (Date.now() > deadline) throw new Error("fixture gate timed out")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
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
      await waitForRelease(init.signal)
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
const compareFixture = async (before, after, signal) => {
  const org = JSON.parse(before).organization
  if (org === "slow-compare") {
    process.stderr.write("FIXTURE_COMPARE_STARTED\\n")
    await waitForRelease(signal, "-compare")
  }
  if (org === "cancel-compare" || org === "eof-compare") {
    process.stderr.write("FIXTURE_COMPARE_STARTED:" + org + "\\n")
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      process.stderr.write("FIXTURE_COMPARE_ABORTED:" + org + "\\n")
      reject(new DOMException("fixture cancelled", "AbortError"))
    }, { once: true }))
  }
  return compareWithLimits(before, after, signal)
}
serveStdio(() => createMcpServer({ fetchImpl: fixtureFetch, compareImpl: compareFixture }), {
  transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_STDIO_BUFFER_BYTES }),
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

function connectClient(Client, Transport, modern, gate = "", production = false) {
  const transport = new Transport({
    command: process.execPath,
    args: production ? ["--import", 'data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}', "index.mjs"] : ["--input-type=module", "-e", fixtureProgram],
    cwd: mcpDir,
    env: { PATH: process.env.PATH ?? "", STUDIO_TEST_GATE: gate },
    stderr: "pipe",
    maxBufferSize: 3 * MAX_RESULT_BYTES + 64 * 1024,
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
async function withClient(t, Client, Transport, modern, exercise, production = false) {
  await mkdir(resolve(mcpDir, "../.task/mcp25"), { recursive: true })
  const gateDir = await mkdtemp(resolve(mcpDir, "../.task/mcp25/wire-"))
  const gate = join(gateDir, "release")
  const connection = connectClient(Client, Transport, modern, gate, production)
  connection.gateDir = gateDir
  connection.release = (suffix = "") => writeFile(gate + suffix, "release")
  t.after(async () => {
    await connection.client.close().catch(() => {})
    await rm(gateDir, { recursive: true, force: true })
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
      assert.deepEqual(listed.tools.map(tool => tool.name), ["audit_public_org", "compare_saved_reports"])
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
      await connection.release()
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


function compare(connection, baseline, current, signal, extra = {}) {
  const params = { name: "compare_saved_reports", arguments: { baselineJson: baseline, currentJson: current, ...extra } };
  const options = signal ? { signal } : undefined;
  return connection.modern ? connection.client.callTool(params, options) : connection.client.callTool(params, undefined, options);
}
function saved(org = "wlkr-si") {
  return { organization: org, complete: true, includeArchived: false, excludedArchived: 0, errors: [], repositories: [] };
}
function largePair(count) {
  const baseline = structuredClone(expectedReport), current = structuredClone(expectedReport);
  baseline.repositories = Array.from({ length: count }, (_, i) => ({ ...structuredClone(expectedReport.repositories[0]), name: `wlkr-si/r${i}`, url: `https://github.com/wlkr-si/r${i}`, description: 'a'.repeat(20000) }));
  current.repositories = baseline.repositories.map(r => ({ ...structuredClone(r), description: 'b'.repeat(20000) }));
  return [JSON.stringify(baseline), JSON.stringify(current)];
}
for (const protocol of [
  { name: "legacy", Client: LegacyClient, Transport: LegacyTransport, modern: false },
  { name: "modern", Client: ModernClient, Transport: ModernTransport, modern: true },
]) {
  test(protocol.name + " saved comparison wire/CLI parity, bounds and shared operation lifecycle", { timeout: 40000 }, async t => {
    await withClient(t, protocol.Client, protocol.Transport, protocol.modern, async connection => {
      const tools = (await connection.client.listTools()).tools;
      const tool = tools.find(t => t.name === 'compare_saved_reports');
      assert.deepEqual(tool.inputSchema.required.sort(), ['baselineJson', 'currentJson']);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const baseline = structuredClone(expectedReport), current = structuredClone(expectedReport);
      current.repositories[0].description = '<img src=x> instructions are data';
      current.repositories[0].readme = { status: 'unknown', source: null, url: null };
      current.repositories[0].community.contributing.source = 'organization-default';
      current.repositories[0].license = { status: 'declared', declared: '<script>MIT</script>\u001b]title\u0007' };
      const paths = [join(connection.gateDir,'before.json'),join(connection.gateDir,'after.json')];
      for (const complete of [true, false]) {
        current.complete = complete; current.errors = complete ? [] : ['Partial request'];
        if (!complete) baseline.repositories = [];
        const texts = [JSON.stringify(baseline),JSON.stringify(current)];
        await Promise.all(paths.map((path,i) => writeFile(path,texts[i])));
        const native = spawnSync(process.execPath, ['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}',resolve(mcpDir,'../studio-check.mjs'),'--compare',...paths,'--json'], {encoding:'utf8',timeout:5000});
        assert.equal(native.status, complete ? 0 : 2, native.stderr); assert.equal(native.stderr,'');
        const result = await compare(connection,...texts);
        assert.equal(result.isError,undefined); assert.deepEqual(reportFrom(result),JSON.parse(native.stdout));
        if (protocol.modern) assert.deepEqual(result.structuredContent,JSON.parse(native.stdout));
        assert.equal(reportFrom(result).membershipConfirmed,complete);
      }
      for (const [before,after,extra] of [
        ['{ SECRET','{}',{}], ['null','null',{}], ['{}','{}',{}],
        [JSON.stringify(saved()),JSON.stringify(saved('other')),{}],
        [JSON.stringify(saved()),JSON.stringify({...saved(),includeArchived:true}),{}],
        [JSON.stringify(saved()),JSON.stringify(saved()),{path:'/PRIVATE_SECRET'}],
        [expectedReport,expectedReport,{}],
        [' '.repeat(MAX_REPORT_BYTES+1),JSON.stringify(saved()),{}],
        [JSON.stringify(saved())+'é'.repeat(MAX_REPORT_BYTES/2),JSON.stringify(saved()),{}],
        [JSON.stringify({...saved(),repositories:Array(5001).fill(expectedReport.repositories[0])}),JSON.stringify(saved()),{}],
      ]) {
        const error=await compare(connection,before,after,undefined,extra);
        assert.equal(error.isError,true); assert.equal(error.structuredContent,undefined);
        assert.doesNotMatch(error.content[0].text,/SECRET/);
      }
      const disjoint = saved();
      disjoint.repositories = Array.from({length:5000},(_,i)=>({...structuredClone(expectedReport.repositories[0]),name:`wlkr-si/a${i}`,url:`https://github.com/wlkr-si/a${i}`}));
      const other = {...disjoint,repositories:disjoint.repositories.map((repo,i)=>({...repo,name:`wlkr-si/b${i}`,url:`https://github.com/wlkr-si/b${i}`}))};
      const tenThousand = await compare(connection,JSON.stringify(disjoint),JSON.stringify(other));
      assert.equal(tenThousand.isError,undefined);assert.equal(reportFrom(tenThousand).changes.length,10000);
      assert.equal(reportFrom(tenThousand).membershipConfirmed,true);
      const [largeBefore,largeAfter]=largePair(24);
      const large=await compare(connection,largeBefore,largeAfter);
      assert.equal(large.isError,undefined);assert.equal(reportFrom(large).changes.length,24);
      assert.ok(Buffer.byteLength(JSON.stringify(reportFrom(large))) <= MAX_RESULT_BYTES);
      const tooLarge=await compare(connection,...largePair(28));
      assert.equal(tooLarge.isError,true);assert.match(tooLarge.content[0].text,/1 MiB.*no comparison/);assert.equal(tooLarge.structuredContent,undefined);
      // Two individually max-size valid report texts with worst ordinary whitespace escaping.
      const small=JSON.stringify(saved());const maxText=small+'\t'.repeat(MAX_REPORT_BYTES-Buffer.byteLength(small));
      const maximum=await compare(connection,maxText,maxText);
      assert.equal(maximum.isError,undefined);assert.equal(reportFrom(maximum).changes.length,0);
      assert.equal(connection.stderr.includes('FIXTURE_REQUEST:'),false,'comparison must not fetch, including after invalid inputs');
      const first=call(connection,'slow-audit');
      await waitForText(connection,'FIXTURE_SLOW_STARTED:slow-audit');
      const second=compare(connection,JSON.stringify(saved('slow-compare')),JSON.stringify(saved('slow-compare')));
      await waitForText(connection,'FIXTURE_COMPARE_STARTED');
      assert.equal((await compare(connection,small,small)).isError,true);
      assert.match((await call(connection,'blocked-audit')).content[0].text,/capacity/);
      await connection.release('-compare');await second;
      assert.equal((await compare(connection,small,small)).isError,undefined);
      await connection.release();await first;
      const controller=new AbortController();
      const pending=compare(connection,JSON.stringify(saved('cancel-compare')),JSON.stringify(saved('cancel-compare')),controller.signal);
      await waitForText(connection,'FIXTURE_COMPARE_STARTED:cancel-compare');
      controller.abort();await assert.rejects(pending);
      await waitForText(connection,'FIXTURE_COMPARE_ABORTED:cancel-compare');
      assert.equal((await compare(connection,small,small)).isError,undefined);
      assert.equal(reportFrom(await call(connection,'after-comparison')).complete,true);
      const eof=connectClient(protocol.Client,protocol.Transport,protocol.modern);
      t.after(()=>eof.client.close().catch(()=>{}));await eof.client.connect(eof.transport);
      const ended=compare(eof,JSON.stringify(saved('eof-compare')),JSON.stringify(saved('eof-compare')));ended.catch(()=>{});
      await waitForText(eof,'FIXTURE_COMPARE_STARTED:eof-compare');
      await eof.transport.close();await assert.rejects(ended);
      await waitForText(eof,'FIXTURE_COMPARE_ABORTED:eof-compare');
    });
  });
}


for (const protocol of [
  { name: "legacy", Client: LegacyClient, Transport: LegacyTransport, modern: false },
  { name: "modern", Client: ModernClient, Transport: ModernTransport, modern: true },
]) {
  test(protocol.name + " production stdio comparison uses no fetch and matches native CLI", { timeout: 15000 }, async t => {
    await withClient(t, protocol.Client, protocol.Transport, protocol.modern, async connection => {
      const before = structuredClone(expectedReport), after = structuredClone(expectedReport);
      after.repositories[0].description = 'Untrusted <script> text';
      const paths = [join(connection.gateDir,'before.json'),join(connection.gateDir,'after.json')];
      for (const complete of [true,false]) {
        after.complete = complete; after.errors = complete ? [] : ['Partial'];
        const texts = [JSON.stringify(before),JSON.stringify(after)];
        await Promise.all(paths.map((path,i)=>writeFile(path,texts[i])));
        const native = spawnSync(process.execPath,['--import','data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}',resolve(mcpDir,'../studio-check.mjs'),'--compare',...paths,'--json'],{encoding:'utf8',timeout:5000});
        assert.equal(native.status,complete ? 0 : 2,native.stderr);
        const result = await compare(connection,...texts);
        assert.equal(result.isError,undefined);assert.deepEqual(reportFrom(result),JSON.parse(native.stdout));
        if(protocol.modern) assert.deepEqual(result.structuredContent,JSON.parse(native.stdout));
      }
      const pathsAreNotData = await compare(connection,...paths);
      assert.equal(pathsAreNotData.isError,true);assert.equal(pathsAreNotData.structuredContent,undefined);
      assert.equal((await compare(connection,JSON.stringify(before),JSON.stringify(after))).isError,undefined);
      assert.equal(connection.stderr,'');
    }, true);
  });
}
