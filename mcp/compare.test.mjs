import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { ReadBuffer } from "@modelcontextprotocol/server"
import { compareWithLimits, comparisonInputSchema, comparisonSchema, MAX_STDIO_BUFFER_BYTES, MAX_RESULT_BYTES } from "./index.mjs"
import { comparisonReport, MAX_REPORT_BYTES } from "../web/report-compare.mjs"

const report = () => ({ organization: "demo", complete: true, includeArchived: false, excludedArchived: 0, repositories: [], errors: [] })
const text = () => JSON.stringify(report())

test("comparison accepts exactly two JSON-text arguments; report bytes and schema remain bounded", async () => {
  assert.equal(comparisonInputSchema.safeParse({ baselineJson: text(), currentJson: text() }).success, true)
  for (const value of [{}, { baselineJson: report(), currentJson: text() }, { baselineJson: text(), currentJson: text(), url: "SECRET" }, { baselineJson: "x".repeat(MAX_REPORT_BYTES + 1), currentJson: text() }]) assert.equal(comparisonInputSchema.safeParse(value).success, false)
  for (const value of ["{ SECRET", "null", "[]", "{}", '{"__proto__":{"polluted":true}}', "[".repeat(10000) + "0" + "]".repeat(10000), text() + "é".repeat(MAX_REPORT_BYTES / 2)]) await assert.rejects(compareWithLimits(value, text(), new AbortController().signal))
  const result = await compareWithLimits(text(), text(), new AbortController().signal)
  assert.deepEqual(result, comparisonReport(report(), report()))
  assert.equal(comparisonSchema.safeParse(result).success, true)
  assert.equal({}.polluted, undefined)
})

test("comparison observes cancellation before and between bounded CPU stages without returning a delta", async () => {
  for (const during of [false, true]) {
    const controller = new AbortController()
    const pending = compareWithLimits(text(), text(), controller.signal)
    if (during) setImmediate(() => controller.abort())
    else controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
  }
  assert.equal((await compareWithLimits(text(), text(), new AbortController().signal)).membershipConfirmed, true)
})

test("SDK framing accepts its exact finite byte boundary, clears on overflow and never retains an unbounded line", () => {
  assert.equal(MAX_STDIO_BUFFER_BYTES, 21037056)
  const buffer = new ReadBuffer({ maxBufferSize: MAX_STDIO_BUFFER_BYTES })
  const chunk = Buffer.alloc(64 * 1024, 0x20)
  for (let bytes = 0; bytes < MAX_STDIO_BUFFER_BYTES; bytes += chunk.length) buffer.append(chunk.subarray(0, Math.min(chunk.length, MAX_STDIO_BUFFER_BYTES - bytes)))
  assert.equal(buffer.readMessage(), null)
  assert.throws(() => buffer.append(Buffer.from("x")), /exceeded maximum size/)
  assert.equal(buffer.readMessage(), null, "overflow clears the retained partial line")
  const message = { jsonrpc: "2.0", method: "notifications/initialized" }
  buffer.append(Buffer.from(JSON.stringify(message) + "\n"))
  assert.deepEqual(buffer.readMessage(), message)
  assert.ok(MAX_RESULT_BYTES * 3 + 64 * 1024 < MAX_STDIO_BUFFER_BYTES)
})

test("actual production stdio closes on an over-cap unterminated frame with no stdout or network", { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ["--import", 'data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}', "index.mjs"], { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  let out = "", errors = ""
  child.stdout.on("data", chunk => { out += chunk.toString(); assert.ok(out.length < 4096) })
  child.stderr.on("data", chunk => { errors += chunk.toString(); assert.ok(errors.length < 4096) })
  child.stdin.on("error", () => {})
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })) })
  // Backpressure prevents the test producer from accumulating unbounded queued chunks.
  let remaining = MAX_STDIO_BUFFER_BYTES + 1
  while (remaining && !child.stdin.destroyed) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining), 0x20)
    remaining -= chunk.length
    if (!child.stdin.write(chunk)) await new Promise(resolve => { const done = () => { child.stdin.off("drain", done); child.stdin.off("close", done); resolve() }; child.stdin.once("drain", done); child.stdin.once("close", done) })
  }
  const result = await closed
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.equal(out, "")
  assert.match(errors, /studio-check MCP transport error: Error/)
  assert.doesNotMatch(errors, /NETWORK_FORBIDDEN|maximum size|SECRET/)
})


test("production stdio recovers after malformed/unknown requests, invalid comparisons and a late cancellation", { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ["--import", 'data:text/javascript,globalThis.fetch=()=>{throw new Error("NETWORK_FORBIDDEN")}', "index.mjs"], { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => { if(child.exitCode === null) child.kill('SIGKILL') })
  let errors = '', buffered = ''; const messages = new Map(), waiters = new Map()
  child.stderr.on('data', chunk => {errors += chunk.toString()})
  child.stdout.on('data', chunk => {
    buffered += chunk.toString(); assert.ok(buffered.length < 65536)
    while(buffered.includes('\n')) {
      const end = buffered.indexOf('\n'), line = buffered.slice(0,end); buffered = buffered.slice(end+1)
      const response = JSON.parse(line); messages.set(response.id,response);waiters.get(response.id)?.(response)
    }
  })
  const wait = id => messages.has(id) ? Promise.resolve(messages.get(id)) : new Promise(resolve => waiters.set(id,resolve))
  const send = value => child.stdin.write(JSON.stringify(value)+'\n')
  const request = async (id,method,params) => {send({jsonrpc:'2.0',id,method,params});return wait(id)}
  const initialized = await request(0,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'bounded-native-recovery',version:'1'}})
  assert.ok(initialized.result)
  send({jsonrpc:'2.0',method:'notifications/initialized'})
  child.stdin.write('{invalid JSON\n') // The pinned SDK discards invalid JSON lines.
  send({jsonrpc:'2.0',id:90,method:7}) // Invalid JSON-RPC shape: recoverable SDK parse error.
  assert.ok((await request(1,'not/a/method',{})).error)
  const args = {baselineJson:text(),currentJson:text()}
  const tool = (id,arguments_) => request(id,'tools/call',{name:'compare_saved_reports',arguments:arguments_})
  assert.equal((await tool(2,{...args,extra:'SECRET'})).result.isError,true)
  assert.equal((await tool(3,{baselineJson:text(),currentJson:JSON.stringify({...report(),organization:'other'})})).result.isError,true)
  // Separate pipe writes do not prove that cancellation reaches a still-running
  // operation. Establish completion first, then exercise an explicitly late cancel.
  const completed = await tool(4,args)
  assert.equal(completed.result.isError,undefined)
  assert.deepEqual(JSON.parse(completed.result.content[0].text),comparisonReport(report(),report()))
  send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:4,reason:'already completed'}})
  const recovered = await tool(5,args)
  assert.equal(recovered.result.isError,undefined)
  assert.deepEqual(JSON.parse(recovered.result.content[0].text),comparisonReport(report(),report()))
  assert.equal(messages.get(4),completed,'late cancellation cannot invalidate an already received successful result')
  assert.ok((await request(6,'tools/list',{})).result.tools.length === 2)
  assert.doesNotMatch(errors,/SECRET|NETWORK_FORBIDDEN/)
  const exit = new Promise(resolve=>child.once('close',code=>resolve(code)))
  child.stdin.end();assert.equal(await exit,0)
})

async function orderedCancellationFixture() {
  globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  const { createMcpServer, compareWithLimits, MAX_STDIO_BUFFER_BYTES } = await import('./index.mjs');
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
  let sequence = 0;
  const acknowledge = (event, organization, extra = {}) => process.send({ event, organization, sequence: ++sequence, ...extra });
  const compareImpl = async (before, after, signal) => {
    const organization = JSON.parse(before).organization;
    if (['held-cancel', 'slot-one', 'slot-two'].includes(organization)) {
      await new Promise((resolve, reject) => {
        const abort = () => {
          process.off('message', release);
          acknowledge('aborted', organization);
          reject(new DOMException('Controlled comparison aborted', 'AbortError'));
        };
        const release = message => {
          if (message?.release !== organization || organization === 'held-cancel') return;
          process.off('message', release);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        signal.addEventListener('abort', abort, { once: true });
        process.on('message', release);
        // The acknowledgement follows listener registration, while completion is gated.
        acknowledge('started', organization, { alreadyAborted: signal.aborted });
        if (signal.aborted) abort();
      });
    }
    return compareWithLimits(before, after, signal);
  };
  serveStdio(() => createMcpServer({ compareImpl }), {
    legacy: 'serve',
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_STDIO_BUFFER_BYTES }),
    onerror: error => process.stderr.write('CONTROLLED_SERVER_ERROR:' + error.name + '\n'),
  });
  // Only the test control channel is additional; production stdio and server code are unchanged.
  process.channel.unref();
}

test('gated SDK stdio cancels an active comparison before completion and releases both operation slots', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', '(' + orderedCancellationFixture.toString() + ')()'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {});
  let buffered = '', errors = '';
  const messages = new Map(), responses = new Map(), responseWaiters = new Map(), events = new Map(), eventWaiters = new Map();
  child.stdout.on('data', chunk => {
    buffered += chunk.toString(); assert.ok(buffered.length < 65536);
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n'), value = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      messages.set(value.id, value); responseWaiters.get(value.id)?.(value);
    }
  });
  child.stderr.on('data', chunk => { errors += chunk.toString(); assert.ok(errors.length < 4096); });
  child.on('message', value => {
    const key = value.event + ':' + value.organization;
    events.set(key, value); eventWaiters.get(key)?.(value);
  });
  const waitResponse = id => {
    if (messages.has(id)) return Promise.resolve(messages.get(id));
    if (!responses.has(id)) responses.set(id, new Promise(resolve => responseWaiters.set(id, resolve)));
    return responses.get(id);
  };
  const waitEvent = key => events.has(key) ? Promise.resolve(events.get(key)) : new Promise(resolve => eventWaiters.set(key, resolve));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (id, method, params) => { send({ jsonrpc: '2.0', id, method, params }); return waitResponse(id); };
  const argumentsFor = organization => {
    const json = JSON.stringify({ ...report(), organization });
    return { baselineJson: json, currentJson: json };
  };
  const call = (id, organization) => request(id, 'tools/call', { name: 'compare_saved_reports', arguments: argumentsFor(organization) });
  const initialized = await request(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ordered-cancellation-fixture', version: '1' } });
  assert.ok(initialized.result);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const cancelledResponse = call(4, 'held-cancel');
  const started = await waitEvent('started:held-cancel');
  assert.equal(started.alreadyAborted, false);
  assert.equal(messages.has(4), false, 'the operation is known to be unfinished before cancellation');
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4, reason: 'controlled active cancellation' } });
  const aborted = await waitEvent('aborted:held-cancel');
  assert.ok(aborted.sequence > started.sequence, 'server observed cancellation after starting and before completing');
  // The SDK may suppress a cancelled response entirely; never wait for an optional reply.
  void cancelledResponse;
  assert.equal((await call(5, 'after-cancel')).result.isError, undefined);

  const one = call(6, 'slot-one');
  assert.equal(await Promise.race([waitEvent('started:slot-one').then(() => 'started'), one.then(() => 'responded')]), 'started');
  const two = call(7, 'slot-two');
  assert.equal(await Promise.race([waitEvent('started:slot-two').then(() => 'started'), two.then(() => 'responded')]), 'started',
    'cancellation must release its slot so two fresh operations can enter');
  const full = await call(8, 'over-capacity');
  assert.equal(full.result.isError, true);
  assert.match(full.result.content[0].text, /capacity/);
  child.send({ release: 'slot-one' }); child.send({ release: 'slot-two' });
  for (const [response, organization] of [[await one, 'slot-one'], [await two, 'slot-two']]) {
    assert.equal(response.result.isError, undefined);
    const input = { ...report(), organization };
    assert.deepEqual(JSON.parse(response.result.content[0].text), comparisonReport(input, input));
  }
  assert.equal((await request(9, 'tools/list', {})).result.tools.length, 2);
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  const cancelled = messages.get(4);
  assert.ok(!cancelled || cancelled.error || cancelled.result?.isError, 'a known active cancellation must never return a successful delta');
  assert.doesNotMatch(errors, /NETWORK_FORBIDDEN|SECRET|CONTROLLED_SERVER_ERROR/);
});
