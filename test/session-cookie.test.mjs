import test from "node:test"
import assert from "node:assert/strict"

import {
  NO_TOKEN_KEY,
  accountOf,
  displayLabel,
  mergeAccount,
} from "../lib/auth.mjs"
import {
  SESSION_TTL_MS,
  cachedSessionCookie,
  clearSessionCookies,
  exchangeSessionCookie,
  forgetSessionCookie,
  rememberSessionCookie,
  sessionCookieFrom,
  sessionSelf,
} from "../lib/session-cookie.mjs"

/* ------------------------------------------------------------- helpers */

function headersOf(pairs) {
  const map = new Map()
  return {
    get: (name) => map.get(String(name).toLowerCase()) ?? null,
    getSetCookie: () => pairs,
  }
}

const LOGIN_ACCOUNT = {
  baseUrl: "https://site.test",
  platform: "new-api",
  checkinMode: "login",
  loginCheckin: { username: "alice@example.com", password: "pw" },
}

/* ------------------------------------------------------ metadata merge */

test("session-cookie: an edit stamps detectedAt and drops stale derived fields", () => {
  const current = {
    baseUrl: "https://site.test",
    platform: "new-api",
    checkinMode: "login",
    loginUsername: "alice@example.com",
    loginPassword: "pw",
    label: "alice",
    siteName: "Example Site",
    quotaPerUnit: 500_000,
    username: "github_100001",
    detectedAt: "2026-01-01T00:00:00.000Z",
  }
  const { ok, errors, metadata, changed } = mergeAccount({
    current,
    changes: { label: "bob" },
    now: "2026-02-02T00:00:00.000Z",
  })
  assert.equal(ok, true)
  assert.deepEqual(errors, [])
  assert.equal(metadata.label, "bob")
  // The site was not re-read, so what the last fetch described no longer applies.
  assert.equal(metadata.siteName, undefined)
  assert.equal(metadata.username, undefined)
  assert.equal(metadata.email, undefined)
  // ...except quotaPerUnit, which has a default the next read falls back to.
  assert.equal(metadata.quotaPerUnit, 500_000)
  assert.equal(metadata.detectedAt, "2026-02-02T00:00:00.000Z")
  // The credential itself is untouched: it is not given again by an edit.
  assert.equal(metadata.loginUsername, "alice@example.com")
  assert.equal(metadata.loginPassword, "pw")
  assert.equal(metadata.baseUrl, "https://site.test")
  assert.equal(metadata.checkinMode, "login")
  assert.deepEqual(changed, ["label"])
})

test("session-cookie: null changes leave a field alone", () => {
  const current = {
    baseUrl: "https://site.test",
    platform: "new-api",
    checkinMode: "login",
    loginUsername: "alice@example.com",
    loginPassword: "pw",
    label: "alice",
    userId: 601648,
  }
  const { ok, metadata, changed } = mergeAccount({
    current,
    changes: { label: null, userId: null },
    now: "t",
  })
  assert.equal(ok, true)
  assert.equal(metadata.label, "alice")
  assert.equal(metadata.userId, 601648)
  assert.deepEqual(changed, [])
})

test("session-cookie: a login-style account without a password is refused", () => {
  const { ok, errors } = mergeAccount({
    current: { baseUrl: "https://site.test", checkinMode: "login", loginUsername: "a@b.c" },
    changes: {},
    now: "t",
  })
  assert.equal(ok, false)
  assert.match(errors.join("\n"), /登录密码/)
})

test("session-cookie: an account with a password and no name is refused", () => {
  const { ok, errors } = mergeAccount({
    current: {
      baseUrl: "https://site.test",
      checkinMode: "login",
      loginUsername: "",
      token: "",
      label: "",
      email: "",
      username: "",
      password: "",
    },
    changes: {},
    now: "t",
  })
  assert.equal(ok, false)
  assert.match(errors.join("\n"), /登录式签到需要填写站点登录邮箱或用户名/)
})

/* ---------------------------------------------------- cookie parsing */

test("session-cookie: the login reply's session cookie is read with acw_tc", () => {
  const header = sessionCookieFrom(
    headersOf(["acw_tc=guard-1; Path=/; HttpOnly", "session=sess-1; Path=/; HttpOnly"]),
  )
  assert.equal(header, "session=sess-1; acw_tc=guard-1")
})

test("session-cookie: a reply without a session cookie yields nothing", () => {
  assert.equal(sessionCookieFrom(headersOf(["acw_tc=guard-1; Path=/"])), "")
  assert.equal(sessionCookieFrom(headersOf([])), "")
  assert.equal(sessionCookieFrom(undefined), "")
  assert.equal(sessionCookieFrom(headersOf(["session=; Path=/"])), "")
})

test("session-cookie: an empty session attribute is not mistaken for a value", () => {
  const header = sessionCookieFrom(headersOf(["Session=; Path=/", "session=abc"]))
  assert.equal(header, "session=abc")
})

/* -------------------------------------------------------- the exchange */

test("session-cookie: the exchange returns only a Cookie header value", async () => {
  clearSessionCookies()
  const calls = []
  const post = async (path, options) => {
    calls.push({ path, options })
    return {
      status: 200,
      ok: true,
      json: { success: true, data: { id: 7 } },
      headers: headersOf(["acw_tc=g; Path=/", "session=s; Path=/; HttpOnly"]),
    }
  }

  const header = await exchangeSessionCookie(LOGIN_ACCOUNT, post)
  assert.equal(header, "session=s; acw_tc=g")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, "/api/user/login")
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    username: "alice@example.com",
    password: "pw",
  })
})

test("session-cookie: a refused password is an auth failure", async () => {
  const post = async () => ({
    status: 200,
    ok: true,
    json: { success: false, message: "用户名或密码错误" },
  })
  const call = exchangeSessionCookie(LOGIN_ACCOUNT, post)
  await assert.rejects(call, (error) => error.kind === "auth")
})

test("session-cookie: a success with no session cookie is refused", async () => {
  const post = async () => ({ status: 200, ok: true, json: { success: true, data: {} } })
  const call = exchangeSessionCookie(LOGIN_ACCOUNT, post)
  await assert.rejects(call, (error) => /会话 Cookie/.test(error.message))
})

test("session-cookie: an account without a password is never sent anywhere", async () => {
  let posted = false
  const post = async () => {
    posted = true
  }
  const call = exchangeSessionCookie({ baseUrl: "https://site.test", loginCheckin: {} }, post)
  await assert.rejects(call, (error) => error.kind === "unsupported")
  assert.equal(posted, false)
})

test("session-cookie: one login is reused for SESSION_TTL_MS, then signs in again", async () => {
  clearSessionCookies()
  const account = LOGIN_ACCOUNT
  const until = { now: 1_000_000 }
  const realNow = Date.now
  Date.now = () => until.now
  try {
    rememberSessionCookie(account, "session=first; acw_tc=g1")
    assert.equal(cachedSessionCookie(account), "session=first; acw_tc=g1")

    until.now += SESSION_TTL_MS - 1
    assert.equal(cachedSessionCookie(account), "session=first; acw_tc=g1")

    until.now += 2
    assert.equal(cachedSessionCookie(account), "")
  } finally {
    Date.now = realNow
    clearSessionCookies()
  }
})

test("session-cookie: a session is not shared with another site of the same name", () => {
  clearSessionCookies()
  rememberSessionCookie(LOGIN_ACCOUNT, "session=s; acw_tc=g")
  const other = { ...LOGIN_ACCOUNT, baseUrl: "https://elsewhere.test" }
  assert.equal(cachedSessionCookie(LOGIN_ACCOUNT), "session=s; acw_tc=g")
  assert.equal(cachedSessionCookie(other), "")
  forgetSessionCookie(LOGIN_ACCOUNT)
  assert.equal(cachedSessionCookie(LOGIN_ACCOUNT), "")
  clearSessionCookies()
})

test("session-cookie: a stored token is not the key of a login-style account", () => {
  const key = `login:${"alice@example.com"}`
  const account = accountOf({
    key,
    metadata: {
      baseUrl: "https://site.test",
      platform: "new-api",
      checkinMode: "login",
      loginUsername: "alice@example.com",
      loginPassword: "pw",
      token: `{{SECRET_c0a1f0de}}`,
    },
  })
  // The cleanup: the key is the login name, and the stored token is dropped.
  assert.equal(account.token, "alice@example.com")
  assert.equal(account.checkinMode, "login")
  assert.equal(account.loginCheckin.password, "pw")
})

test("session-cookie: a custom account without a token keeps its key", () => {
  const account = accountOf({
    key: NO_TOKEN_KEY,
    metadata: { baseUrl: "https://site.test", platform: "custom", customUrl: "/api/checkin" },
  })
  assert.equal(account.token, "")
  assert.equal(account.noToken, true)
})

test("session-cookie: a login-style account is named after its login, not a token", () => {
  const label = displayLabel({ baseUrl: "https://site.test", username: "alice", label: "" })
  assert.equal(label, "alice · site.test")
  const fallback = displayLabel({ baseUrl: "https://site.test", username: "", userId: 0 })
  assert.equal(fallback, "site.test")
})

test("session-cookie: sessionSelf sends the New-API-User header for the account", async () => {
  const calls = []
  const post = async (path, options) => {
    calls.push({ path, headers: options.headers })
    return { status: 200, ok: true, json: { success: true, data: { id: 601648, quota: 12345 } }, headers: headersOf([]) }
  }
  const acct = { ...LOGIN_ACCOUNT, userId: 601648 }
  const data = await sessionSelf(acct, "session=s", post)
  assert.equal(data.quota, 12345)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, "/api/user/self")
  const h = calls[0].headers || {}
  assert.equal(h["New-API-User"], "601648")
  assert.equal(h.Cookie, "session=s")
})

test("session-cookie: sessionSelf reports a refused cookie as an auth failure", async () => {
  const post = async () => ({ status: 401, ok: false, json: null })
  const call = sessionSelf(LOGIN_ACCOUNT, "session=bad", post)
  await assert.rejects(call, (error) => error.kind === "auth")
})

