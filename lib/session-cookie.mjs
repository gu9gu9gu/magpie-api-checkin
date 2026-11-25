// Session cookies for the login-style and token-keyed accounts that still fetch
// a balance.
//
// Why this file exists: some New API forks (ps.air-outer.com is the one this was
// written against) do not hand out a long-lived access token at all. Their login
// reply carries `access_token: null`, and the only credential /api/user/self
// accepts is the `session=<value>` cookie that same reply sets in Set-Cookie. A
// token issued elsewhere on such a site is answered with
// "无权进行此操作，access token 无效", so nothing a person can type reads a balance.
//
// The rule this module keeps:
//
//   * A login-style account has no token, neither for the sign-in nor for the
//     balance beside it. It exchanges its saved login name and password at
//     POST /api/user/login and uses the session cookie that comes back.
//   * The cookie is never asked from a person, never written to plugin-auth.json
//     and never printed. It is a short-lived credential: it lives in this
//     process's memory for SESSION_TTL_MS (30 minutes), and the next read after
//     that signs in again, so the Usage page keeps a balance and the viewer never
//     sees an expiry.
//   * The password is used only for that in-memory exchange. It stays where it
//     was, in the account's metadata.

import { PlatformError, hostOf, messageOf, nonEmptyString, record } from "./http.mjs"
import { appendUserIds } from "./auth.mjs"

/** The cookie name New API forks issue for a browser session. */
export const SESSION_COOKIE = "session"

/** The WAF's own cookie: bound to one session and re-issued on every sign-in. */
const TRACE_COOKIE = "acw_tc"

/**
 * How long one exchange is reused. Short on purpose: signing in is cheap, the
 * site rotates sessions, and a stale cookie buys nothing worth waiting for.
 */
export const SESSION_TTL_MS = 30 * 60 * 1000

/**
 * One cache per login, not per account: the same e-mail on two sites is two
 * sessions, and a session must never be presented to a site it did not come
 * from. Keyed by "<baseUrl>\n<login name>".
 */
const CACHES = new Map()

function cacheKeyOf(account) {
  const base = nonEmptyString(account?.baseUrl)
  const name = nonEmptyString(account?.loginCheckin?.username)
  return `${base}\n${name}`
}

/** Forget every session this process holds (for tests; the plugin never needs it). */
export function clearSessionCookies() {
  CACHES.clear()
}

/** The session this process still holds for the account, or "". */
export function cachedSessionCookie(account, now = Date.now()) {
  const key = cacheKeyOf(account)
  const entry = CACHES.get(key)
  if (!entry) return ""
  if (entry.expiresAt <= now) {
    CACHES.delete(key)
    return ""
  }
  return entry.header
}

/** Keep a session for the account; `header` is "session=…[; acw_tc=…]". */
export function rememberSessionCookie(account, header) {
  const key = cacheKeyOf(account)
  const value = nonEmptyString(header)
  if (!value || !nonEmptyString(account?.loginCheckin?.username)) return ""
  CACHES.set(key, { header: value, expiresAt: Date.now() + SESSION_TTL_MS })
  return key
}

/** Forget the account's session: its password was refused, or the site dropped it. */
export function forgetSessionCookie(account) {
  CACHES.delete(cacheKeyOf(account))
}

/**
 * The cookies one login reply set, as a Cookie header value:
 * "session=…; acw_tc=…", or "" when no session came back. acw_tc comes along
 * because the site's session guard rejects a session presented without its
 * matching guard cookie.
 */
export function sessionCookieFrom(headers) {
  let session = ""
  let trace = ""
  let lines = []
  if (typeof headers?.getSetCookie === "function") {
    const all = headers.getSetCookie()
    if (Array.isArray(all) && all.length > 0) lines = all.map(String)
  }
  if (!lines.length && typeof headers?.get === "function") {
    const single = headers.get("set-cookie")
    if (nonEmptyString(single)) lines = [String(single)]
  }
  for (const line of lines) {
    const pair = String(line).split(";")[0]
    const eq = pair.indexOf("=")
    if (eq < 1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!value) continue
    if (name === SESSION_COOKIE) session = `${name}=${value}`
    else if (name === TRACE_COOKIE) trace = `${name}=${value}`
  }
  if (!session) return ""
  return trace ? `${session}; ${trace}` : session
}

/**
 * One sign-in, returning only the Cookie header value for it. `post` is the
 * caller's own request helper — it knows the account's fetchImpl, timeout and
 * error wording — so this module never grows a second way to talk to a site.
 * The reply object keeps the raw `Headers` under `response`.
 */
/**
 * The account's Cookie header value for this moment: the cached session while it
 * is fresh, otherwise one earned by signing in now and kept for the next call.
 */
export async function sessionCookie(account, post) {
  const held = cachedSessionCookie(account)
  if (held) return held
  const header = await exchangeSessionCookie(account, post)
  rememberSessionCookie(account, header)
  return header
}

/** Does this account carry the name and password it signs in with? */
export function hasLogin(account) {
  return Boolean(
    nonEmptyString(account?.loginCheckin?.username) &&
      nonEmptyString(account?.loginCheckin?.password),
  )
}

/**
 * GET /api/user/self with the account's session cookie, through the account's
 * own fetchImpl (so a test's fake serves this too). Mirrors how
 * lib/platforms.mjs reads that reply: a site without the path answers 404/405,
 * a dropped session 401/403 or success:false, a WAF wall HTML. Those stay
 * distinct errors; telling them apart is the caller's job.
 */
export async function sessionSelf(account, header, post) {
  const res = await post("/api/user/self", {
    // The site serves /api/user/self only to a signed-in session, but it also
    // keys the reply to the user id: without the New-API-User header this fork
    // answers with the WAF/HTML page or a 401 even for a good session cookie.
    headers: appendUserIds({ Cookie: header, Accept: "application/json" }, account.userId),
    timeout: 10_000,
  })
  const site = hostOf(account.baseUrl)
  const status = Number(res?.status) || 0
  if (status === 404 || status === 405) {
    throw new PlatformError(`${site} 没有 /api/user/self：不像 new-api 站点`, {
      kind: "unsupported",
      status,
    })
  }
  if (status === 401 || status === 403) {
    throw new PlatformError(`会话 Cookie 被站点拒绝（HTTP ${status}）`, { kind: "auth", status })
  }
  const body = record(res?.json)
  if (!body) {
    throw new PlatformError(`${site} 返回了网页而不是 JSON`, { kind: "unsupported", status })
  }
  if (body.success === false) {
    const why = messageOf(body)
    throw new PlatformError(why || "站点没有返回用户信息", { kind: "auth", status, reason: why })
  }
  return record(body.data)
}

export async function exchangeSessionCookie(account, post) {
  const name = nonEmptyString(account?.loginCheckin?.username)
  const password = nonEmptyString(account?.loginCheckin?.password)
  if (!name || !password) {
    throw new PlatformError("登录式签到缺少用户名或密码", { kind: "unsupported" })
  }
  const res = await post("/api/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: name, password }),
    timeout: 15_000,
  })
  const body = record(res?.json)
  const status = Number(res?.status) || 0
  const header = sessionCookieFrom(res?.headers)
  // A refusal is about the password, not about the cookie we did not get: say
  // so plainly, so the caller reports "密码错了" instead of a mystery.
  if (status === 401 || status === 403 || (body && body.success === false)) {
    const why = body ? messageOf(body) : ""
    throw new PlatformError(
      `站点拒绝登录${why ? `：${why}` : `（HTTP ${status}）`}`,
      { kind: "auth", status },
    )
  }
  if (!header) {
    const why = body ? messageOf(body) : ""
    throw new PlatformError(
      `站点登录没有返回会话 Cookie（HTTP ${res?.status ?? 0}）${why ? `：${why}` : ""}`,
      { kind: "unsupported", status: res?.status },
    )
  }
  return header
}
