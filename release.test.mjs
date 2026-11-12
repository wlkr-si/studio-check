import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ASSETS, BASELINE, BASELINE_COMMIT, HOST, latestDeployment, release, sourceState, validateReceipt, verifyBaselineSource, verifyPublic, withReleaseLock, createSnapshot } from "./release.mjs"

const COMMIT = "1111111111111111111111111111111111111111"
const OLD = "11111111-1111-4111-8111-111111111111"
const NEW = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const digest = value => createHash("sha256").update(value).digest("hex")
const fixtureRoots = new Set()
after(async () => { await Promise.all([...fixtureRoots].map(path => rm(path, { recursive: true, force: true }))); fixtureRoots.clear() })
const paths = ["web/_headers", ...Object.values(ASSETS).map(name => "web/" + name)].sort()

function fixture(options = {}) {
  const root = join("/tmp", "studio-check-release-fixture-" + Math.random().toString(16).slice(2))
  fixtureRoots.add(root)
  const assets = Object.fromEntries(Object.values(ASSETS).map((name, i) => [name, "source-" + i]))
  const state = { calls: [], writes: [], baselineChecks: 0, history: [], seq: 0, rollbackCount: 0 }
  function deployment(version, message) {
    const record = { id: "00000000-0000-4000-8000-" + String(++state.seq).padStart(12, "0"), created_on: new Date(Date.UTC(2026, 0, 1, 0, 0, state.seq)).toISOString(), versions: [{ version_id: version, percentage: 100 }], annotations: { "workers/message": message } }
    state.history.unshift(record)
    return record
  }
  deployment(OLD, "prior release")
  const run = (command, args) => {
    state.calls.push([command, ...args])
    if (command === "wrangler" && args[0] === "--version") return { status: 0, stdout: "4.153.0\n" }
    if (command === "git") {
      if (args[0] === "status" && args[1] === "--porcelain=v1") return { status: 0, stdout: options.dirty ? " M README.md\n" : "" }
      if (args[0] === "status") return { status: 0, stdout: "" }
      if (args[0] === "branch") return { status: 0, stdout: options.branch || "main\n" }
      if (args[0] === "rev-parse") return { status: 0, stdout: COMMIT + "\n" }
      if (args[0] === "ls-files") return { status: 0, stdout: [...paths].join("\0") + "\0" }
      if (args[0] === "merge-base") return { status: options.unknownBaseline ? 1 : 0, stdout: "" }
      if (args[0] === "tag") return { status: 0, stdout: options.taggedBaseline ? "v0.7.0\n" : "" }
      if (args[0] === "show") return { status: 0, stdout: "source" }
    }
    if (command === "node") return { status: 0, stdout: "" }
    assert.equal(command, "wrangler")
    if (args[0] === "deployments") {
      if (options.foreignOnRead && state.candidateFailed && !state.writes.includes("foreign")) {
        state.writes.push("foreign")
        deployment(OTHER, "external release")
      }
      return { status: 0, stdout: JSON.stringify(state.history) }
    }
    if (args[0] === "versions" && args[1] === "upload") {
      state.writes.push("upload")
      return { status: options.uploadFails ? 1 : 0, stdout: options.uploadFails ? "" : "Worker Version ID: " + NEW + "\n" }
    }
    if (args[0] === "versions" && args[1] === "deploy") {
      const version = args[2].split("@")[0]
      const message = args[args.indexOf("--message") + 1]
      if (version === NEW) {
        state.writes.push("candidate")
        if (!options.activationFailsWithoutMutation) deployment(NEW, message)
        return { status: options.activationFailsWithoutMutation || options.activationFailsAfterMutation ? 1 : 0, stdout: "", stderr: "injected activation result" }
      }
      state.rollbackCount++
      state.writes.push("rollback")
      if (!options.rollbackDoesNotMutate) deployment(OLD, message)
      return { status: options.rollbackDoesNotMutate ? 1 : 0, stdout: "", stderr: "injected rollback result" }
    }
    throw new Error("Unexpected command " + command + " " + args.join(" "))
  }
  async function verifyImpl(expected) {
    if (expected === null) {
      state.baselineChecks++
      if (options.badRestore && state.rollbackCount > 0) throw new Error("injected restored bytes mismatch")
      return { schemaVersion: 1, sourceCommit: BASELINE_COMMIT, assets: BASELINE }
    }
    if (options.candidateVerificationFails) { state.candidateFailed = true; throw new Error("injected candidate bytes mismatch") }
    return expected
  }
  return { root, assets, state, run, verifyImpl }
}

test("receipt rejects unknown fields, wrong path set and malformed hashes", () => {
  const valid = { schemaVersion: 1, sourceCommit: COMMIT, assets: Object.fromEntries(Object.keys(ASSETS).map(path => [path, "a".repeat(64)])) }
  assert.equal(validateReceipt(valid), valid)
  assert.throws(() => validateReceipt({ ...valid, private: "data" }), /unexpected fields/)
  assert.throws(() => validateReceipt({ ...valid, assets: { "/private": "a".repeat(64) } }), /exact six/)
  assert.throws(() => validateReceipt({ ...valid, assets: { ...valid.assets, "/": "bad" } }), /exact six/)
})

test("deployment parser refuses empty, ambiguous and split traffic", () => {
  assert.throws(() => latestDeployment("[]"), /invalid or empty/)
  const base = { id: OLD, created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: OLD, percentage: 100 }] }
  assert.throws(() => latestDeployment(JSON.stringify([base, { ...base, id: NEW }])), /ambiguous/)
  assert.throws(() => latestDeployment(JSON.stringify([{ ...base, versions: [{ version_id: OLD, percentage: 50 }] }])), /single version at 100%/)
})

test("pinned migration and later tagged baselines are checked against source history", () => {
  assert.equal(verifyBaselineSource({ schemaVersion: 1, sourceCommit: BASELINE_COMMIT, assets: BASELINE }, COMMIT, (_c, args) => args[0] === "merge-base" ? { status: 0 } : assert.fail("pinned baseline needs no tag lookup")), true)
  const other = { schemaVersion: 1, sourceCommit: COMMIT, assets: Object.fromEntries(Object.keys(ASSETS).map(path => [path, digest("source")])) }
  const run = (_command, args) => {
    if (args[0] === "merge-base") return { status: 0 }
    if (args[0] === "tag") return { status: 0, stdout: "v0.8.0\n" }
    if (args[0] === "show") return { status: 0, stdout: "source" }
    throw new Error(args.join(" "))
  }
  assert.equal(verifyBaselineSource(other, "2222222222222222222222222222222222222222", run), true)
  assert.throws(() => verifyBaselineSource(other, "2222222222222222222222222222222222222222", (_c, args) => args[0] === "merge-base" ? { status: 0 } : { status: 0, stdout: "" }), /no accepted release tag/)
  const tagged = (_c, args) => args[0] === "merge-base" ? { status: 0 } : args[0] === "tag" ? { status: 0, stdout: "v0.8.0" } : { status: 0, stdout: "changed" }
  assert.throws(() => verifyBaselineSource(other, "2222222222222222222222222222222222222222", tagged), /differs from tagged source/)
  assert.throws(() => verifyBaselineSource(other, "2222222222222222222222222222222222222222", (_c, args) => args[0] === "merge-base" ? { status: 1 } : { status: 0 }), /not an ancestor/)
})

test("source gate refuses dirty, non-main and unexpected deploy files", () => {
  const base = (args, dirty = false, branch = "main") => {
    if (args[0] === "status") return { status: 0, stdout: dirty ? " M x" : "" }
    if (args[0] === "branch") return { status: 0, stdout: branch }
    if (args[0] === "rev-parse") return { status: 0, stdout: COMMIT }
    if (args[0] === "ls-files") return { status: 0, stdout: paths.join("\0") + "\0" }
  }
  assert.throws(() => sourceState((cmd, args) => base(args, true)), /clean committed/)
  assert.throws(() => sourceState((cmd, args) => base(args, false, "feature")), /main branch/)
  assert.equal(sourceState((cmd, args) => base(args)), COMMIT)
  assert.throws(() => sourceState((cmd, args) => args[0] === "ls-files" ? { status: 0, stdout: "web/secret.js\0" } : base(args)), /exact seven/)
  assert.throws(() => sourceState((_cmd, args) => args[0] === "status" && args.includes("--untracked-files=all") ? { status: 0, stdout: "?? web/ignored.js" } : base(args)), /untracked file under web/)
})

test("snapshot contains exactly six served assets, headers and strict receipt", async () => {
  const f = fixture()
  await mkdir(join(f.root, "web"), { recursive: true })
  await mkdir(join(f.root, ".task"), { recursive: true })
  for (const name of Object.values(ASSETS)) await writeFile(join(f.root, "web", name), f.assets[name])
  await writeFile(join(f.root, "web", "_headers"), "headers")
  const directory = await mkdtemp(join(f.root, ".task", "snap-"))
  try {
    const receipt = await createSnapshot({ root: f.root, directory: join(directory, "assets"), commit: COMMIT })
    const files = (await readdir(join(directory, "assets"))).sort()
    assert.deepEqual(files, [...Object.values(ASSETS), "_headers", "build-info.json"].sort())
    assert.equal(receipt.assets["/"], digest("source-0"))
    assert.deepEqual(JSON.parse(await readFile(join(directory, "assets", "build-info.json"), "utf8")), receipt)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("public verifier checks response identity, all bytes and required headers", async () => {
  const bodies = Object.fromEntries(Object.keys(ASSETS).map((path, i) => [path, Buffer.from("body-" + i)]))
  const receipt = { schemaVersion: 1, sourceCommit: COMMIT, assets: Object.fromEntries(Object.keys(ASSETS).map(path => [path, digest(bodies[path])])) }
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls++
    assert.equal(new URL(url).origin, HOST)
    assert.equal(init.credentials, "omit")
    assert.equal(init.redirect, "error")
    assert.equal(init.cache, "no-store")
    const path = new URL(url).pathname
    const body = path === "/build-info.json" ? Buffer.from(JSON.stringify(receipt)) : bodies[path]
    return new Response(body, { headers: { "cache-control": "public, no-transform", "x-content-type-options": "nosniff" } })
  }
  assert.deepEqual(await verifyPublic(receipt, { fetchImpl }), receipt)
  assert.equal(calls, 7)
  await assert.rejects(verifyPublic({ ...receipt, sourceCommit: "2".repeat(40) }, { fetchImpl }), /differs from the expected receipt/)
  await assert.rejects(verifyPublic(receipt, { fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init)
    if (new URL(url).pathname === "/app.mjs") return new Response("bad", { headers: response.headers })
    return response
  } }), /SHA-256/)
  await assert.rejects(verifyPublic(receipt, { fetchImpl: async (url, init) => { const response = await fetchImpl(url, init); return new Response(await response.arrayBuffer(), { headers: { "x-content-type-options": "nosniff" } }) } }), /no-transform/)
})

async function prepare(f) {
  await mkdir(join(f.root, "web"), { recursive: true })
  await mkdir(join(f.root, ".task"), { recursive: true })
  for (const name of Object.values(ASSETS)) await writeFile(join(f.root, "web", name), f.assets[name])
  await writeFile(join(f.root, "web", "_headers"), "headers")
}

test("unsupported Wrangler refuses before reading provider state", async () => {
  const calls = []
  await assert.rejects(release({ run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: "wrangler 4.160.1" } } }), /requires Wrangler 4.153.0/)
  assert.deepEqual(calls, [["wrangler", "--version"]])
})

test("stale source and unsafe provider state stop before upload", async () => {
  const f = fixture({ dirty: true })
  await prepare(f)
  await assert.rejects(release({ root: f.root, run: f.run, verifyImpl: f.verifyImpl, sleep: async () => {} }), /clean committed/)
  assert.equal(f.state.writes.length, 0)
  const g = fixture({ unsafeTraffic: true })
  await prepare(g)
  g.state.history[0].versions[0].percentage = 50
  await assert.rejects(release({ root: g.root, run: g.run, verifyImpl: g.verifyImpl, sleep: async () => {} }), /single version at 100%/)
  assert.equal(g.state.writes.length, 0)
})

test("upload error and failed activation without provider mutation reconcile old version", async () => {
  for (const options of [{ uploadFails: true }, { activationFailsWithoutMutation: true }]) {
    const f = fixture(options)
    await prepare(f)
    await assert.rejects(release({ root: f.root, run: f.run, verifyImpl: f.verifyImpl, sleep: async () => {} }), /Previous deployment .* remains active and verified/)
    assert.equal(f.state.rollbackCount, 0)
    assert.equal(f.state.writes.includes("rollback"), false)
  }
})

test("activation error after mutation is reconciled and owned version restored", async () => {
  const f = fixture({ activationFailsAfterMutation: true })
  await prepare(f)
  await assert.rejects(release({ root: f.root, run: f.run, verifyImpl: f.verifyImpl, sleep: async () => {} }), /Previous version .* restored and verified/)
  assert.equal(f.state.rollbackCount, 1)
  assert.equal(f.state.history[0].versions[0].version_id, OLD)
})

test("candidate byte mismatch rolls back only owned version; foreign deployment is never overwritten", async () => {
  const f = fixture({ candidateVerificationFails: true })
  await prepare(f)
  await assert.rejects(release({ root: f.root, run: f.run, verifyImpl: f.verifyImpl, sleep: async () => {} }), /Previous version .* restored and verified/)
  assert.equal(f.state.rollbackCount, 1)
  const foreign = fixture({ candidateVerificationFails: true, foreignOnRead: true })
  await prepare(foreign)
  await assert.rejects(release({ root: foreign.root, run: foreign.run, verifyImpl: foreign.verifyImpl, sleep: async () => {} }), /not owned by this run.*No rollback/)
  assert.equal(foreign.state.rollbackCount, 0)
})

test("restoration is not reported when restored public bytes fail verification", async () => {
  const f = fixture({ candidateVerificationFails: true, badRestore: true })
  await prepare(f)
  await assert.rejects(release({ root: f.root, run: f.run, verifyImpl: f.verifyImpl, sleep: async () => {} }), /failed public verification/)
  assert.equal(f.state.rollbackCount, 1)
})

test("release lock serializes runs and removes lock after action failure", async () => {
  const dir = await mkdtemp("/tmp/studio-check-lock-")
  const path = join(dir, "lock")
  try {
    let entered = false
    await withReleaseLock(path, async () => { entered = true; await assert.rejects(withReleaseLock(path, () => {}), /Release lock exists/) })
    assert.equal(entered, true)
    await assert.rejects(withReleaseLock(path, async () => { throw new Error("injected") }), /injected/)
    await assert.rejects(readFile(path))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
