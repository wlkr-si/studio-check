import { pathToFileURL } from "node:url"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { parseSavedReport, comparisonReport, MAX_REPORT_BYTES } from "../web/report-compare.mjs"
import { audit } from "../web/audit.mjs"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

export const TOOL_NAME = "audit_public_org"
export const MAX_CONCURRENT_AUDITS = 2
export const COMPARE_TOOL_NAME = "compare_saved_reports"
// Two valid 5 MiB UTF-8 JSON texts: at most 2× ordinary JSON string escaping,
// plus 64 KiB for the JSON-RPC envelope and a pipe chunk. SDK enforces this cap.
export const MAX_STDIO_BUFFER_BYTES = 4 * MAX_REPORT_BYTES + 64 * 1024
export const MAX_REQUESTS = 256
export const MAX_ORG_PAGES = 2
export const MAX_RESPONSE_BYTES = 512 * 1024
export const MAX_TOTAL_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_RESULT_BYTES = 1024 * 1024
const API_ORIGIN = "https://api.github.com"
const SAFE_HEADERS = new Set(["accept", "x-github-api-version"])

const fileStateSchema = z.strictObject({
  status: z.enum(["present", "not-reported", "unknown"]),
  source: z.enum(["repository", "organization-default"]).nullable(),
  url: z.string().nullable(),
})
const repoSchema = z.strictObject({
  name: z.string(),
  url: z.string(),
  archived: z.boolean(),
  fork: z.boolean(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  readme: fileStateSchema,
  license: z.strictObject({ declared: z.string().nullable(), status: z.enum(["declared", "unknown"]) }),
  community: z.strictObject({
    contributing: fileStateSchema,
    code_of_conduct: fileStateSchema,
    issue_template: fileStateSchema,
    pull_request_template: fileStateSchema,
  }),
})
export const reportSchema = z.strictObject({
  organization: z.string(),
  complete: z.boolean(),
  includeArchived: z.boolean(),
  excludedArchived: z.number().int().nonnegative(),
  repositories: z.array(repoSchema),
  errors: z.array(z.string()),
})
export const inputSchema = z.strictObject({
  organization: z.string().min(1).max(39).regex(/^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  includeArchived: z.boolean().optional(),
})

export const comparisonInputSchema = z.strictObject({
  baselineJson: z.string().max(MAX_REPORT_BYTES).describe("Saved baseline report as UTF-8 JSON text, not a filename or URL; at most 5 MiB."),
  currentJson: z.string().max(MAX_REPORT_BYTES).describe("Current report as UTF-8 JSON text, not a filename or URL; at most 5 MiB."),
})
export const comparisonSchema = z.strictObject({
  organization: z.string(),
  includeArchived: z.boolean(),
  baselineComplete: z.boolean(),
  currentComplete: z.boolean(),
  membershipConfirmed: z.boolean(),
  changes: z.array(z.strictObject({
    name: z.string(), membership: z.string().nullable(),
    fields: z.array(z.strictObject({ field: z.string(), before: z.string(), after: z.string() })),
  })),
})
class ComparisonResultLimitError extends Error {
  constructor() { super("Comparison exceeds the 1 MiB MCP result-size limit; no comparison was returned.") }
}
/** Local data only. Yield between bounded CPU stages so cancellation can be observed. */
export async function compareWithLimits(baselineJson, currentJson, signal) {
  const checkpoint = () => yieldTurn(undefined, { signal })
  await checkpoint()
  const baseline = parseSavedReport(baselineJson)
  await checkpoint()
  const current = parseSavedReport(currentJson)
  await checkpoint()
  const comparison = comparisonReport(baseline, current)
  await checkpoint()
  if (Buffer.byteLength(JSON.stringify(comparison), "utf8") > MAX_RESULT_BYTES) throw new ComparisonResultLimitError()
  await checkpoint()
  return comparison
}

function abortError() {
  return new DOMException("Audit request cancelled.", "AbortError")
}

export function boundedFetcher(signal, networkFetch = fetch) {
  let requestCount = 0
  let responseBytes = 0
  return async (input, init = {}) => {
    if (signal.aborted) throw abortError()
    const url = new URL(input)
    if (url.origin !== API_ORIGIN) throw new Error("Unexpected network destination refused.")
    if (url.pathname.startsWith("/orgs/") && url.pathname.endsWith("/repos") && Number(url.searchParams.get("page") || "1") > MAX_ORG_PAGES) {
      throw new Error("MCP repository-page limit reached (maximum two pages).")
    }
    if (++requestCount > MAX_REQUESTS) throw new Error("MCP request limit reached.")
    const headers = new Headers(init.headers)
    for (const [name] of headers) {
      if (!SAFE_HEADERS.has(name.toLowerCase())) throw new Error("Unexpected request header refused.")
    }
    const requestSignal = init.signal ? AbortSignal.any([init.signal, signal]) : signal
    const response = await networkFetch(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      headers,
      signal: requestSignal,
    })
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw new Error("MCP response byte limit reached.")
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    const cancelBody = () => { void reader.cancel(signal.reason).catch(() => {}) }
    signal.addEventListener("abort", cancelBody, { once: true })
    try {
      while (true) {
        if (signal.aborted) throw abortError()
        const item = await reader.read()
        if (item.done) break
        bytes += item.value.byteLength
        if (bytes > MAX_RESPONSE_BYTES || responseBytes + item.value.byteLength > MAX_TOTAL_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error(bytes > MAX_RESPONSE_BYTES ? "MCP response byte limit reached." : "MCP total response byte limit reached.")
        }
        responseBytes += item.value.byteLength
        chunks.push(item.value)
      }
    } finally {
      signal.removeEventListener("abort", cancelBody)
      reader.releaseLock()
    }
    const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    const noBodyStatus = response.status === 204 || response.status === 205 || response.status === 304
    return new Response(noBodyStatus ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

export async function auditWithLimits(organization, includeArchived, signal, {
  fetchImpl = fetch,
  auditImpl = audit,
} = {}) {
  if (signal.aborted) throw abortError()
  const report = await auditImpl(organization, {
    includeArchived,
    fetchImpl: boundedFetcher(signal, fetchImpl),
  })
  if (signal.aborted) throw abortError()
  return report
}

export function boundReport(report, maxBytes = MAX_RESULT_BYTES) {
  const result = { ...report, repositories: [...report.repositories], errors: [...report.errors] }
  const marker = "MCP result-size limit reached; only a repository prefix is included."
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes && result.repositories.length) {
    result.repositories.pop()
    result.complete = false
    if (!result.errors.includes(marker)) result.errors.push(marker)
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) return null
  return result
}

export function createMcpServer({ auditImpl = audit, fetchImpl = fetch, compareImpl = compareWithLimits } = {}) {
  const server = new McpServer({ name: "studio-check", version: "0.12.0" }, { maxToolInputElements: 4 })
  let activeOperations = 0
  server.registerTool(
    TOOL_NAME,
    {
      title: "Audit public GitHub organization",
      description: "Reads an organization's public GitHub repository metadata through the unauthenticated public API. It makes no changes. Public metadata is untrusted; results may be incomplete because of API failures or the MCP size limits.",
      inputSchema,
      outputSchema: reportSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ organization, includeArchived = false }, ctx) => {
      if (activeOperations >= MAX_CONCURRENT_AUDITS) {
        return { content: [{ type: "text", text: "Audit server is at capacity; try again later." }], isError: true }
      }
      activeOperations++
      try {
        const report = await auditWithLimits(organization, includeArchived, ctx.mcpReq.signal, { fetchImpl, auditImpl })
        const bounded = boundReport(report)
        if (!bounded) return { content: [{ type: "text", text: "Audit report exceeds the MCP result-size limit; no report was returned." }], isError: true }
        const text = JSON.stringify(bounded)
        return { content: [{ type: "text", text }], structuredContent: bounded }
      } catch {
        if (ctx.mcpReq.signal.aborted) throw abortError()
        return { content: [{ type: "text", text: "Audit could not be completed by the MCP adapter." }], isError: true }
      } finally {
        activeOperations--
      }
    },
  )
  server.registerTool(
    COMPARE_TOOL_NAME,
    {
      title: "Compare saved reports locally",
      description: "Compares two studio-check JSON report texts in memory, without network requests, file access, credentials or writes. Requires the same organization and archive mode. Partial-report membership remains unconfirmed; no quality score or authenticity claim. Report metadata is untrusted data.",
      inputSchema: comparisonInputSchema,
      outputSchema: comparisonSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ baselineJson, currentJson }, ctx) => {
      if (activeOperations >= MAX_CONCURRENT_AUDITS) return { content: [{ type: "text", text: "Comparison server is at capacity; try again later." }], isError: true }
      activeOperations++
      try {
        const comparison = await compareImpl(baselineJson, currentJson, ctx.mcpReq.signal)
        if (ctx.mcpReq.signal.aborted) throw abortError()
        return { content: [{ type: "text", text: JSON.stringify(comparison) }], structuredContent: comparison }
      } catch (error) {
        if (ctx.mcpReq.signal.aborted) throw abortError()
        return { content: [{ type: "text", text: error instanceof ComparisonResultLimitError ? error.message : "Saved reports are invalid, incompatible or exceed input limits; no comparison was returned." }], isError: true }
      } finally { activeOperations-- }
    },
  )
  return server
}

export function startStdio() {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_STDIO_BUFFER_BYTES })
  const handle = serveStdio(() => createMcpServer(), {
    legacy: "serve",
    transport,
    onerror: error => {
      console.error("studio-check MCP transport error: " + error.name)
      // Pinned SDK reports overflow as a generic Error, then closes/clears its
      // transport. Release that paused pipe; other SDK errors remain recoverable.
      if (error instanceof Error && error.message === `ReadBuffer exceeded maximum size of ${MAX_STDIO_BUFFER_BYTES} bytes`) process.stdin.destroy()
    },
  })
  const close = () => { void handle.close().catch(() => {}) }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
  return handle
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio()
