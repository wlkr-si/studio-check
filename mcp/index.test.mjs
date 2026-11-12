import test from "node:test"
import assert from "node:assert/strict"
import { auditWithLimits, boundReport, boundedFetcher, inputSchema, MAX_RESPONSE_BYTES } from "./index.mjs"

const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } })

test("input is strict and organization names are bounded", () => {
  assert.equal(inputSchema.safeParse({ organization: "wlkr-si" }).success, true)
  assert.equal(inputSchema.safeParse({ organization: "x".repeat(40) }).success, false)
  assert.equal(inputSchema.safeParse({ organization: "wlkr--si" }).success, false)
  assert.equal(inputSchema.safeParse({ organization: "wlkr-si", path: "/etc/passwd" }).success, false)
  assert.equal(inputSchema.safeParse({ organization: "wlkr-si", includeArchived: "true" }).success, false)
})

test("audit uses only public API routes and never follows metadata URLs", async () => {
  const requested = []
  const fetchImpl = async (url, init) => {
    requested.push([String(url), init])
    if (String(url).includes("/orgs/wlkr-si/repos")) return json([{ full_name: "wlkr-si/sample", name: "sample", private: false, visibility: "public", archived: false, fork: false, description: "<img src=x>", homepage: "https://attacker.invalid/", license: null }])
    return json({ files: { readme: { html_url: "https://attacker.invalid/readme" } } })
  }
  const report = await auditWithLimits("wlkr-si", false, new AbortController().signal, { fetchImpl })
  assert.equal(report.repositories[0].description, "<img src=x>")
  assert.equal(report.repositories[0].readme.url, "https://attacker.invalid/readme")
  assert.equal(requested.length, 2)
  assert.ok(requested.every(([url]) => new URL(url).origin === "https://api.github.com"))
  assert.ok(requested.every(([, init]) => init.credentials === "omit" && init.redirect === "error"))
  assert.ok(requested.every(([, init]) => !new Headers(init.headers).has("authorization")))
})

test("refuses non-GitHub destinations and excess response bytes", async () => {
  const signal = new AbortController().signal
  const fetcher = boundedFetcher(signal, async () => new Response("ok"))
  await assert.rejects(fetcher("https://attacker.invalid/"), /destination refused/)
  const large = boundedFetcher(signal, async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)))
  await assert.rejects(large("https://api.github.com/orgs/wlkr-si/repos"), /byte limit/)
})

test("caps request count and aggregate response bytes", async () => {
  const signal = new AbortController().signal
  let calls = 0
  const requestBound = boundedFetcher(signal, async () => {
    calls++
    return new Response(null, { status: 204 })
  })
  for (let i = 0; i < 256; i++) await requestBound("https://api.github.com/orgs/wlkr-si/repos")
  await assert.rejects(requestBound("https://api.github.com/orgs/wlkr-si/repos"), /request limit/)
  assert.equal(calls, 256)

  let total = 0
  const byteBound = boundedFetcher(signal, async () => {
    total++
    return new Response(new Uint8Array(512 * 1024))
  })
  for (let i = 0; i < 16; i++) await byteBound("https://api.github.com/orgs/wlkr-si/repos")
  await assert.rejects(byteBound("https://api.github.com/orgs/wlkr-si/repos"), /total response byte limit/)
  assert.equal(total, 17)
})

test("caps repository pagination and returns an incomplete report", async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    const page = Number(new URL(url).searchParams.get("page"))
    return page < 2
      ? json([], { link: '<https://api.github.com/orgs/wlkr-si/repos?page=2>; rel="next"' })
      : json([], { link: '<https://api.github.com/orgs/wlkr-si/repos?page=3>; rel="next"' })
  }
  const report = await auditWithLimits("wlkr-si", false, new AbortController().signal, { fetchImpl })
  assert.equal(calls.length, 2)
  assert.equal(report.complete, false)
  assert.match(report.errors.join(" "), /two pages/)
})

test("cancellation reaches an active fetch and does not become a complete result", async () => {
  const controller = new AbortController()
  let sawAbort = false
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")) }, { once: true })
    setTimeout(() => controller.abort(), 10)
  })
  await assert.rejects(auditWithLimits("wlkr-si", false, controller.signal, { fetchImpl }), { name: "AbortError" })
  assert.equal(sawAbort, true)
})

test("truncates oversized reports while preserving an explicit incomplete state", () => {
  const report = { organization: "wlkr-si", complete: true, includeArchived: false, excludedArchived: 0, errors: [], repositories: Array.from({ length: 10 }, (_, i) => ({ name: `repo-${i}`, description: "x".repeat(100) })) }
  const bounded = boundReport(report, 400)
  assert.ok(bounded)
  assert.equal(bounded.complete, false)
  assert.ok(bounded.repositories.length < report.repositories.length)
  assert.match(bounded.errors[0], /result-size limit/)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 400)
})
