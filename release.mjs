import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, resolve } from "node:path"

export const HOST = "https://studio-check.wlkr.si"
export const NAME = "studio-check"
export const BASELINE_COMMIT = "800979dfb8e5fc5d9c56fcf5294b7867aa38669d"
export const ASSETS = Object.freeze({
  "/": "index.html",
  "/app.mjs": "app.mjs",
  "/audit.mjs": "audit.mjs",
  "/report-compare.mjs": "report-compare.mjs",
  "/report-csv.mjs": "report-csv.mjs",
  "/style.css": "style.css",
})
export const BASELINE = Object.freeze({
  "/": "a19906f112d053846059d31d5dec74301f3fe3fa293a18de0ef081651c68cadb",
  "/app.mjs": "b34049f855c0098fe1fcc4032cef8d3b007ff25398b2fea3624a2e36d7889977",
  "/audit.mjs": "ebe754f709737d21375cfba56f3de2f7fb0e6bd648511993cd029bbbb676c3f8",
  "/report-compare.mjs": "281d83f10408b13711de66b324dfac4531581af3028f5a340dff1ce855ea2423",
  "/report-csv.mjs": "b11ec417cf37158e1ef5a54c59bdc46384866c89ada2d7d8ca1b5d9a0af35292",
  "/style.css": "8ce581ac99f1617b9a37f1679a138118b119f489a510e0bbfb85349e93608509",
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const sha = value => createHash("sha256").update(value).digest("hex")
export class ConflictError extends Error {}

export function validateReceipt(value) {
  if (!value || value.schemaVersion !== 1 || !HEX40.test(value.sourceCommit || "") || !value.assets || !isDeepStrictEqual(Object.keys(value.assets).sort(), Object.keys(ASSETS).sort()) || Object.values(value.assets).some(hash => !HEX64.test(hash))) {
    throw new Error("Invalid build receipt: expected schema version 1, source commit and hashes for the exact six served assets.")
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), ["assets", "schemaVersion", "sourceCommit"].sort())) throw new Error("Invalid build receipt: unexpected fields.")
  return value
}

export function latestDeployment(raw) {
  const deployments = JSON.parse(raw)
  if (!Array.isArray(deployments) || !deployments.length || deployments.some(item => !UUID.test(item.id) || !Number.isFinite(Date.parse(item.created_on)) || !Array.isArray(item.versions))) throw new Error("Wrangler returned an invalid or empty deployment list; inspect deployments manually.")
  deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  if (deployments[1] && Date.parse(deployments[1].created_on) === Date.parse(deployments[0].created_on)) throw new Error("Latest deployment is ambiguous; inspect deployments manually.")
  const versions = deployments[0].versions
  if (versions.length !== 1 || versions[0].percentage !== 100 || !UUID.test(versions[0].version_id)) throw new Error("Release requires a single version at 100%; gradual or unknown deployments are not changed.")
  return deployments[0]
}

function processAdapter(command, args, spawn = spawnSync, timeout = 120_000) {
  try {
    const result = spawn(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 })
    return { status: result.status, stdout: result.stdout || "", stderr: result.error?.message || result.stderr || "" }
  } catch (error) { return { status: null, stdout: "", stderr: error.message } }
}
function required(result, label) {
  if (result.status !== 0) throw new Error(label + " failed (" + (result.status ?? "interrupted") + "): " + (result.stderr + "\n" + result.stdout).trim().slice(-3000))
  return result.stdout
}

export function sourceState(run = processAdapter) {
  const status = required(run("git", ["status", "--porcelain=v1"]), "Read source status")
  if (status.trim()) throw new Error("Release requires a clean committed checkout.")
  const tracked = required(run("git", ["ls-files", "-z", "--", "web"]), "Read deployable source list").split("\0").filter(Boolean).sort()
  const expected = ["web/_headers", ...Object.values(ASSETS).map(name => "web/" + name)].sort()
  if (!isDeepStrictEqual(tracked, expected)) throw new Error("Release requires the exact seven tracked static source files.")
  if (required(run("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "web"]), "Check deployable source files").trim()) throw new Error("Unexpected untracked file under web; refusing release.")
  const branch = required(run("git", ["branch", "--show-current"]), "Read source branch").trim()
  if (branch !== "main") throw new Error("Release requires the main branch.")
  const commit = required(run("git", ["rev-parse", "HEAD"]), "Read source commit").trim()
  if (!HEX40.test(commit)) throw new Error("Git returned an invalid source commit.")
  return commit
}

export function verifyCommittedFile(commit, path, bytes, run = processAdapter) {
  const tree = required(run("git", ["ls-tree", commit, "--", path]), "Read committed file identity").trim()
  const entry = tree.match(/^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/)
  if (!entry || entry[2] !== path) throw new Error("Deploy source must be a committed regular file: " + path)
  const blob = createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex")
  if (blob !== entry[1]) throw new Error("Snapshot bytes differ from committed source: " + path)
  return bytes
}

export async function createSnapshot({ root = process.cwd(), directory, commit, read = readFile, run = processAdapter } = {}) {
  if (!HEX40.test(commit || "")) throw new Error("Cannot create a snapshot without a full source commit.")
  await mkdir(directory, { recursive: false })
  const hashes = {}
  for (const [path, filename] of Object.entries(ASSETS)) {
    const bytes = verifyCommittedFile(commit, "web/" + filename, await read(join(root, "web", filename)), run)
    hashes[path] = sha(bytes)
    await writeFile(join(directory, filename), bytes, { flag: "wx" })
  }
  const headers = verifyCommittedFile(commit, "web/_headers", await read(join(root, "web", "_headers")), run)
  await writeFile(join(directory, "_headers"), headers, { flag: "wx" })
  const receipt = { schemaVersion: 1, sourceCommit: commit, assets: hashes }
  validateReceipt(receipt)
  await writeFile(join(directory, "build-info.json"), JSON.stringify(receipt) + "\n", { flag: "wx" })
  return receipt
}

export async function verifySnapshot(directory, receipt, run = processAdapter) {
  validateReceipt(receipt)
  const entries = await readdir(directory, { withFileTypes: true })
  const expected = [...Object.values(ASSETS), "_headers", "build-info.json"].sort()
  if (entries.some(entry => !entry.isFile()) || !isDeepStrictEqual(entries.map(entry => entry.name).sort(), expected)) throw new Error("Unexpected or nonregular snapshot asset.")
  for (const [path, filename] of Object.entries(ASSETS)) if (sha(await readFile(join(directory, filename))) !== receipt.assets[path]) throw new Error("Snapshot asset changed: " + path)
  verifyCommittedFile(receipt.sourceCommit, "web/_headers", await readFile(join(directory, "_headers")), run)
  if (!isDeepStrictEqual(validateReceipt(JSON.parse(await readFile(join(directory, "build-info.json"), "utf8"))), receipt)) throw new Error("Snapshot receipt changed.")
}

export async function parsePublicReceipt(response, expected) {
  if (expected) validateReceipt(expected)
  const bootstrap = { schemaVersion: 1, sourceCommit: BASELINE_COMMIT, assets: BASELINE }
  if (response.status === 404 && (!expected || isDeepStrictEqual(expected, bootstrap))) return bootstrap
  if (!response.ok) throw new Error("Public build receipt returned HTTP " + response.status + ".")
  const receipt = validateReceipt(JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8")))
  if (expected && !isDeepStrictEqual(receipt, expected)) throw new Error("Public build receipt differs from the expected receipt.")
  return receipt
}

export async function verifyPublic(expected, { fetchImpl = fetch, timeoutMs = 7000, nonce = randomUUID() } = {}) {
  const receiptUrl = HOST + "/build-info.json?release=" + nonce
  const response = await fetchImpl(receiptUrl, requestOptions(timeoutMs))
  const receipt = await parsePublicReceipt(response, expected)
  for (const [path, hash] of Object.entries(receipt.assets)) {
    const asset = await fetchImpl(HOST + path + "?release=" + nonce, requestOptions(timeoutMs))
    if (!asset.ok) throw new Error(HOST + path + ": HTTP " + asset.status)
    if (sha(Buffer.from(await asset.arrayBuffer())) !== hash) throw new Error(HOST + path + ": SHA-256 differs from verified receipt.")
    if (!/no-transform/i.test(asset.headers.get("cache-control") || "") || (asset.headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff") throw new Error(HOST + path + ": expected no-transform and nosniff response headers.")
  }
  const finalResponse = await fetchImpl(receiptUrl, requestOptions(timeoutMs))
  if ((response.status === 404) !== (finalResponse.status === 404)) throw new Error("Public receipt availability changed during verification.")
  await parsePublicReceipt(finalResponse, receipt)
  return receipt
}
function requestOptions(timeoutMs) {
  return { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { "Cache-Control": "no-cache", Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) }
}

function owns(deployment, version, marker) {
  return deployment.versions.length === 1 && deployment.versions[0].percentage === 100 && deployment.versions[0].version_id === version && deployment.annotations?.["workers/message"] === marker
}

export function verifyBaselineSource(baseline, candidateCommit, run = processAdapter) {
  validateReceipt(baseline)
  if (baseline.sourceCommit === BASELINE_COMMIT) {
    if (run("git", ["merge-base", "--is-ancestor", BASELINE_COMMIT, candidateCommit]).status !== 0) throw new Error("Pinned migration baseline is not an ancestor of main.")
    if (!isDeepStrictEqual(baseline.assets, BASELINE)) throw new Error("The migration baseline receipt does not match the pinned source hashes.")
    return true
  }
  if (run("git", ["merge-base", "--is-ancestor", baseline.sourceCommit, candidateCommit]).status !== 0) throw new Error("Published source commit is not an ancestor of main; unknown baseline refused.")
  const tags = required(run("git", ["tag", "--points-at", baseline.sourceCommit]), "Check accepted release tag").split(/\s+/)
  if (!tags.some(tag => /^v\d+\.\d+\.\d+$/.test(tag))) throw new Error("Published source commit has no accepted release tag; unknown baseline refused.")
  for (const [path, filename] of Object.entries(ASSETS)) {
    const committed = required(run("git", ["show", baseline.sourceCommit + ":web/" + filename]), "Read tagged baseline asset")
    if (sha(Buffer.from(committed)) !== baseline.assets[path]) throw new Error("Published baseline differs from tagged source at " + path + ".")
  }
  return true
}

export async function release({ root = process.cwd(), run = processAdapter, fetchImpl = fetch, verifyImpl = verifyPublic, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), id = randomUUID(), read = readFile, log = () => {} } = {}) {
  const cli = required(run("wrangler", ["--version"]), "Check installed Wrangler").trim()
  if (cli !== "4.153.0") throw new Error("Release requires Wrangler 4.153.0 on PATH.")
  const commit = sourceState(run)
  const configBytes = verifyCommittedFile(commit, "wrangler.jsonc", await read(join(root, "wrangler.jsonc")), run)
  const config = JSON.parse(configBytes.toString("utf8"))
  const allowedConfig = { name: NAME, compatibility_date: "2026-11-11", assets: { directory: "./web" }, workers_dev: false, preview_urls: false }
  if (!isDeepStrictEqual(config, allowedConfig)) throw new Error("Release requires the qualified static-only Wrangler configuration.")
  const gate = ["release.mjs", "studio-check.mjs", "read-saved-report.mjs", "web/audit.mjs", "web/app.mjs", "web/report-csv.mjs", "web/report-compare.mjs"]
  for (const path of gate) required(run("node", ["--check", path]), "Syntax check " + path)
  required(run("node", ["--test", "*.test.mjs"], undefined, 600_000), "Behavior tests")
  if (sourceState(run) !== commit) throw new Error("Source changed while release checks ran.")
  await mkdir(join(root, ".task"), { recursive: true })
  const work = await mkdtemp(join(root, ".task", "release-"))
  let prior, priorVersion, version, baseline, baselineVerified = false, activationAttempted = false
  const marker = "studio-check-release:" + id
  const restoreMarker = "studio-check-restore:" + id
  const wrangler = async args => run("wrangler", [...args, "--config", "wrangler.jsonc", "--name", NAME])
  const current = async () => latestDeployment(required(await wrangler(["deployments", "list", "--json"]), "Read deployment"))
  const assertCurrent = async known => {
    const observed = await current()
    if (observed.id !== known.id || observed.versions[0].version_id !== known.versions[0].version_id) throw new ConflictError("Deployment changed from " + known.id + "; no further writes. Inspect provider before retrying.")
    return observed
  }
  const verify = async expected => {
    const served = validateReceipt(await verifyImpl(expected, { fetchImpl }))
    if (expected && !isDeepStrictEqual(served, expected)) throw new Error("Public receipt differs from the captured expected release.")
    return served
  }
  try {
    if (sourceState(run) !== commit) throw new Error("Source changed before snapshot creation.")
    const candidate = await createSnapshot({ root, directory: join(work, "assets"), commit, read, run })
    if (sourceState(run) !== commit) throw new Error("Source changed while the candidate snapshot was created.")
    prior = await current()
    priorVersion = prior.versions[0].version_id
    baseline = await verify(null)
    verifyBaselineSource(baseline, commit, run)
    baselineVerified = true
    await assertCurrent(prior)
    log("Verified prior deployment " + prior.id + " version " + priorVersion + "; baseline " + baseline.sourceCommit + ".")
    if (sourceState(run) !== commit) throw new Error("Source changed before upload.")
    await verifySnapshot(join(work, "assets"), candidate, run)
    const uploaded = required(await wrangler(["versions", "upload", "--assets", join(work, "assets"), "--message", marker, "--strict"]), "Upload inactive static version")
    const ids = [...uploaded.matchAll(/Worker Version ID:\s*([0-9a-f-]{36})/gi)]
    if (ids.length !== 1 || !UUID.test(ids[0][1])) throw new Error("Upload did not return one valid version ID; no activation attempted. Inspect provider versions.")
    version = ids[0][1]
    await verifySnapshot(join(work, "assets"), candidate, run)
    await assertCurrent(prior)
    if (sourceState(run) !== commit) throw new Error("Source changed before activation.")
    activationAttempted = true
    required(await wrangler(["versions", "deploy", version + "@100", "--yes", "--message", marker]), "Activate candidate")
    const active = await current()
    if (!owns(active, version, marker)) throw new ConflictError("Candidate ownership cannot be established at deployment " + active.id + "; no rollback attempted.")
    const served = await verify(candidate)
    if (!isDeepStrictEqual(served, candidate)) throw new Error("Public candidate receipt changed during verification.")
    await assertCurrent(active)
    if (sourceState(run) !== commit) throw new Error("Source changed after publication verification.")
    return { sourceCommit: commit, version, deployment: active.id, previousVersion: priorVersion, previousDeployment: prior.id, host: HOST }
  } catch (failure) {
    if (failure instanceof ConflictError) throw failure
    if (!prior || !baselineVerified) throw failure
    let active
    for (let attempt = 0; attempt < (activationAttempted ? 3 : 1); attempt++) {
      try { active = await current() }
      catch (error) { throw new Error(failure.message + "\nCannot reconcile deployment state: " + error.message + ". No rollback attempted; inspect prior " + priorVersion + ", candidate " + (version || "unknown") + ", marker " + marker + ".") }
      if (active.id !== prior.id) break
      if (activationAttempted && attempt < 2) await sleep(2000)
    }
    if (active.id === prior.id) {
      await verify(baseline)
      await assertCurrent(prior)
      throw new Error(failure.message + "\nPrevious deployment " + prior.id + " remains active and verified. " + (activationAttempted ? "Activation outcome may be delayed; inspect marker " + marker + "." : "No activation occurred."))
    }
    if (!version || !owns(active, version, marker)) throw new ConflictError(failure.message + "\nCurrent deployment " + active.id + " is not owned by this run. No rollback; inspect prior " + priorVersion + " and candidate " + (version || "unknown") + ".")
    await assertCurrent(active)
    let rollback
    try { rollback = await wrangler(["versions", "deploy", priorVersion + "@100", "--yes", "--message", restoreMarker]) }
    catch (error) { rollback = { status: null, stderr: error.message } }
    let restored
    for (let attempt = 0; attempt < 3; attempt++) {
      try { restored = await current() }
      catch (error) { throw new Error(failure.message + "\nRollback outcome unknown: " + error.message + ". No further writes; inspect restore marker " + restoreMarker + ".") }
      if (owns(restored, priorVersion, restoreMarker)) break
      if (restored.id !== active.id) throw new ConflictError("Rollback encountered deployment " + restored.id + "; no further writes.")
      if (attempt < 2) await sleep(2000)
    }
    if (!owns(restored, priorVersion, restoreMarker)) throw new Error(failure.message + "\nRollback not confirmed (CLI status " + rollback.status + "); inspect active deployment " + restored.id + " and prior version " + priorVersion + ".")
    try { await verify(baseline); await assertCurrent(restored) }
    catch (error) { throw new Error(failure.message + "\nRestored deployment " + restored.id + " failed public verification: " + error.message + ".") }
    throw new Error(failure.message + "\nPrevious version " + priorVersion + " restored and verified in deployment " + restored.id + ".")
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

export async function withReleaseLock(path, action) {
  let handle
  try { handle = await open(path, "wx", 0o600) }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Release lock exists at " + path + "; inspect and remove only a confirmed stale lock.")
    throw error
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action() }
  finally { await handle.close(); await rm(path, { force: true }) }
}

async function main() {
  if (process.versions.node !== "26.8.2") throw new Error("Static publication requires the qualified Node 26.8.2 runtime.")
  if (process.argv.length !== 2) throw new Error("Usage: node release.mjs")
  const root = fileURLToPath(new URL("./", import.meta.url))
  process.chdir(root)
  const lock = execFileSync("git", ["rev-parse", "--git-path", "studio-check-release.lock"], { encoding: "utf8" }).trim()
  const result = await withReleaseLock(resolve(lock), () => release({ root, log: console.log }))
  console.log(JSON.stringify(result, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
