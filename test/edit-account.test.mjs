import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { mergeAccount } from "../lib/auth.mjs"
import {
  accountAfter,
  accountKeys,
  applyEdit,
  commitEdit,
  formatSummary,
  readStore,
  summaryOf,
} from "../lib/edit-account.mjs"

const TOKEN = "tok-test-1"
const PASSWORD = "pw-test-1"

function baseStore() {
  return {
    "api-checkin": {
      type: "api",
      key: TOKEN,
      metadata: {
        platform: "new-api",
        baseUrl: "https://api.example.com",
        label: "主站",
        userId: 42,
        username: "alice",
        email: "alice@example.com · api.example.com",
        siteName: "Example",
        quotaPerUnit: 500000,
        detectedAt: "2026-01-01T00:00:00.000Z",
        checkinMode: "login",
        loginUsername: "alice@example.com",
        loginPassword: PASSWORD,
        token: TOKEN,
      },
    },
    "api-checkin#other": {
      type: "api",
      key: "login:bob@example.com",
      metadata: {
        platform: "new-api",
        baseUrl: "https://b.example.com",
        label: "备用",
        checkinMode: "login",
        loginUsername: "bob@example.com",
        loginPassword: "pw-bob",
        token: "tok-bob",
      },
    },
  }
}

test("mergeAccount：只改 label，其余字段保持，派生字段被丢弃，quotaPerUnit 例外", () => {
  const current = baseStore()["api-checkin"].metadata
  const result = mergeAccount({
    current,
    changes: { label: "新名字" },
    frozenToken: TOKEN,
    now: "2026-11-23T00:00:00.000Z",
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.changed, ["label"])
  assert.equal(result.metadata.label, "新名字")
  for (const key of ["platform", "baseUrl", "userId", "checkinMode", "loginUsername", "loginPassword"]) {
    assert.deepEqual(result.metadata[key], current[key], key)
  }
  for (const key of ["username", "email", "siteName"]) {
  }
  assert.equal(result.metadata.detectedAt, "2026-11-23T00:00:00.000Z")
})

test("mergeAccount：null 表示保持原值", () => {
  const current = baseStore()["api-checkin"].metadata
  const result = mergeAccount({
    current,
    changes: { label: null, loginPassword: null },
    frozenToken: TOKEN,
    now: "T",
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed, [])
  assert.equal(result.metadata.label, current.label)
  assert.equal(result.metadata.loginPassword, PASSWORD)
})

test("mergeAccount：更新站点地址并做规范化", () => {
  const current = baseStore()["api-checkin"].metadata
  const result = mergeAccount({
    current,
    changes: { baseUrl: "https://api2.example.com/v1/" },
    frozenToken: TOKEN,
    now: "T",
  })
  assert.equal(result.ok, true)
  assert.equal(result.metadata.baseUrl, "https://api2.example.com")
  assert.deepEqual([...result.changed].sort(), ["baseUrl"])
})

test("mergeAccount：账号标识携带地址时拒绝改站点地址", () => {
  // A key that is itself a site address cannot have that address changed.
  for (const frozenToken of ["https://old.example.com"]) {
    const current = { baseUrl: "https://old.example.com", platform: "new-api" }
    const result = mergeAccount({
      current,
      changes: { baseUrl: "https://new.example.com" },
      frozenToken,
      now: "T",
    })
    assert.equal(result.ok, false, frozenToken)
    assert.match(result.errors.join("；"), /地址写在账号标识里/)
    // The refused address is not stored, so the old one stays as it was.
    assert.equal(result.metadata.baseUrl, "https://old.example.com")
  }

  // A login-keyed account's address lives in metadata, not the key, so it can move.
  const login = mergeAccount({
    current: { baseUrl: "https://old.example.com", platform: "new-api" },
    changes: { baseUrl: "https://new.example.com" },
    frozenToken: "login:alice@example.com",
    now: "T",
  })
  assert.equal(login.ok, true)
  assert.equal(login.metadata.baseUrl, "https://new.example.com")
})

test("mergeAccount：校验站点类型，custom 不允许编辑", () => {
  const bad = mergeAccount({
    current: { platform: "auto" },
    changes: { platform: "nope" },
    frozenToken: "plain-token",
    now: "T",
  })
  // The unknown value is refused and the old one stays as it was.
  assert.equal(bad.metadata.platform, "auto")

  const custom = mergeAccount({
    current: { platform: "custom" },
    changes: { label: "x" },
    frozenToken: "plain-token",
    now: "T",
  })
  assert.equal(custom.ok, false)
  assert.match(custom.errors.join("；"), /自定义接口账号/)
})

test("mergeAccount：登录式签到的密码和用户名必填", () => {
  const current = {
    checkinMode: "login",
    loginUsername: "alice@example.com",
    loginPassword: PASSWORD,
  }
  const missing = mergeAccount({
    current,
    changes: { loginPassword: "" },
    frozenToken: "login:alice@example.com",
    now: "T",
  })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join("；"), /登录式签到需要填写站点登录密码/)

  const placeholder = mergeAccount({
    current,
    changes: { loginPassword: "密码" },
    frozenToken: "login:alice@example.com",
    now: "T",
  })
  assert.equal(placeholder.ok, false)

  const noName = mergeAccount({
    current,
    changes: { loginUsername: "" },
    frozenToken: "login:alice@example.com",
    now: "T",
  })
  assert.equal(noName.ok, false)
  assert.match(noName.errors.join("；"), /登录式签到需要填写站点登录邮箱或用户名/)
})

test("accountKeys/summaryOf/formatSummary：列表不泄露令牌和密码", () => {
  const store = baseStore()
  assert.deepEqual(accountKeys(store), ["api-checkin", "api-checkin#other"])
  const text = accountKeys(store)
    .map((key) => formatSummary(summaryOf(key, store[key])))
    .join("\n")
  assert.match(text, /主站/)
  assert.match(text, /https:\/\/api\.example\.com/)
  assert.match(text, /密码已设置/)
  assert.doesNotMatch(text, new RegExp(TOKEN))
  assert.doesNotMatch(text, new RegExp(PASSWORD))
  assert.doesNotMatch(text, /pw-bob/)
  assert.doesNotMatch(text, /tok-bob/)
})

test("applyEdit：只动目标账号，不改输入对象，token-keyed 的 key 不漂移", () => {
  const store = baseStore()
  const snapshot = structuredClone(store)
  const result = applyEdit(store, "api-checkin", { label: "改名" }, "T")
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed, ["label"])
  assert.equal(result.store["api-checkin"].metadata.label, "改名")
  assert.equal(result.store["api-checkin"].key, TOKEN)
  assert.equal(result.store["api-checkin"].metadata.token, TOKEN)
  assert.deepEqual(result.store["api-checkin#other"], snapshot["api-checkin#other"])
  assert.deepEqual(store, snapshot)
  assert.equal(accountAfter(result.store, "api-checkin").token, TOKEN)
})

test("applyEdit：只改 label 时 key 与其余字段不动", () => {
  const store = baseStore()
  const before = store["api-checkin"].key
  const result = applyEdit(store, "api-checkin", { label: "改个名" }, "T")
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed, ["label"])
  assert.equal(result.store["api-checkin"].key, before)
  assert.equal(result.store["api-checkin"].metadata.label, "改个名")
  assert.equal(store["api-checkin"].key, before)
})

test("applyEdit：校验失败时原样返回，不写文件", () => {
  const store = baseStore()
  const result = applyEdit(store, "api-checkin", { loginPassword: "密码" }, "T")
  assert.equal(result.ok, false)
  assert.match(result.errors.join("；"), /登录式签到需要填写站点登录密码/)
  assert.deepEqual(result.store, store)
})

test("mergeAccount：原值回传不算修改，空值三种写法视为相等", () => {
  const same = mergeAccount({
    current: { label: "名" },
    changes: { label: "名" },
    now: "T",
  })
  assert.equal(same.changed.includes("label"), false)

  const blanked = mergeAccount({ current: {}, changes: { label: "" }, now: "T" })
  assert.equal(blanked.changed.includes("label"), false)

  const objectValue = { a: 1 }
  const objs = mergeAccount({
    current: { extra: objectValue },
    changes: { extra: { a: 1 } },
    now: "T",
  })
  assert.equal(objs.changed.includes("extra"), false)
})

test("commitEdit：取消不写，确认才写并留下备份", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "edit-account-"))
  const file = path.join(dir, "plugin-auth.json")
  try {
    const store = baseStore()
    await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8")
    const original = await readFile(file, "utf8")
    const originalStat = await stat(file)

    const cancelled = applyEdit(store, "api-checkin", { label: "取消" }, "T")
    const notSaved = await commitEdit({ file, store: cancelled.store, confirmed: false })
    assert.equal(notSaved.saved, false)
    assert.equal(await readFile(file, "utf8"), original)
    assert.equal((await stat(file)).mtimeMs, originalStat.mtimeMs)

    const edited = applyEdit(store, "api-checkin", { label: "新名字" }, "T")
    const saved = await commitEdit({ file, store: edited.store, confirmed: true, stamp: "test" })
    assert.equal(saved.saved, true)
    assert.equal(await readFile(`${file}.bak-test`, "utf8"), original)

    const reread = await readStore(file)
    assert.equal(reread["api-checkin"].metadata.label, "新名字")
    assert.equal(accountAfter(reread, "api-checkin").token, TOKEN)
    assert.equal(accountAfter(reread, "api-checkin").loginCheckin.password, PASSWORD)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
