import { pathToFileURL } from "node:url"
import { audit } from "../web/audit.mjs"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

export const TOOL_NAME = "audit_public_org"
export const MAX_CONCURRENT_AUDITS = 2
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

export function createMcpServer({ auditImpl = audit, fetchImpl = fetch } = {}) {
  const server = new McpServer({ name: "studio-check", version: "0.9.0" }, { maxToolInputElements: 4 })
  let activeAudits = 0
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
      if (activeAudits >= MAX_CONCURRENT_AUDITS) {
        return { content: [{ type: "text", text: "Audit server is at capacity; try again later." }], isError: true }
      }
      activeAudits++
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
        activeAudits--
      }
    },
  )
  return server
}

export function startStdio() {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 })
  const handle = serveStdio(() => createMcpServer(), {
    legacy: "reject",
    transport,
    onerror: error => console.error("studio-check MCP transport error: " + error.name),
  })
  const close = () => { void handle.close().catch(() => {}) }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
  return handle
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio()
