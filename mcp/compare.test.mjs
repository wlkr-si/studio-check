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


test("production stdio recovers after malformed/unknown requests, invalid comparisons and cancellation", { timeout: 15000 }, async t => {
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
  send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'compare_saved_reports',arguments:args}})
  send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:4,reason:'test'}})
  const recovered = await tool(5,args)
  assert.equal(recovered.result.isError,undefined)
  assert.deepEqual(JSON.parse(recovered.result.content[0].text),comparisonReport(report(),report()))
  const cancelled = messages.get(4)
  assert.ok(!cancelled || cancelled.error || cancelled.result?.isError,'cancelled comparison cannot return a successful delta')
  assert.ok((await request(6,'tools/list',{})).result.tools.length === 2)
  assert.doesNotMatch(errors,/SECRET|NETWORK_FORBIDDEN/)
  const exit = new Promise(resolve=>child.once('close',code=>resolve(code)))
  child.stdin.end();assert.equal(await exit,0)
})
