// Account handles: URL normalising, credential shapes, JWT hints, and the
// metadata an account keeps in Magpie's plugin-auth.json.

import { finiteNumber, hostOf, nonEmptyString, record } from "./http.mjs"
import { normalizeCustomConfig } from "./config.mjs"
import { round2 } from "./values.mjs"

export const PLATFORM_IDS = ["auto", "new-api", "sub2api", "sub2api-pro", "custom"]

export const PLATFORM_LABELS = {
  "new-api": "new-api / one-api",
  sub2api: "sub2api",
  "sub2api-pro": "sub2api Pro",
  custom: "自定义接口",
  auto: "自动检测",
}

// The credential Magpie keeps for a custom account that needs no token at
// all (its auth is in the custom headers). It must not look like a token.
export const NO_TOKEN_KEY = "custom:no-token"
export const LOGIN_KEY_PREFIX = "login:"

// new-api keeps its user id in a few headers across forks; sending all of them
// is what metapi and all-api-hub do, and harmless where they are ignored.
const USER_ID_HEADERS = [
  "New-API-User",
  "Veloera-User",
  "voapi-user",
  "User-id",
  "X-User-Id",
  "Rix-Api-User",
  "neo-api-user",
]

const COOKIE_RE =
  /(^|;\s*)(session|token|auth_token|access_token|jwt|jwt_token|sessionid)=/i

export function isValidPlatform(value) {
  return PLATFORM_IDS.includes(value)
}

/**
 * A site URL as the adapters use it: scheme and host, no trailing slash, and
 * no API suffix a browser address bar might have picked up.
 */
export function normalizeBaseUrl(input) {
  let text = nonEmptyString(input)
  if (!text) throw new Error("请填写站点地址，例如 https://api.example.com")
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`站点地址无法解析：${text}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("站点地址必须以 http:// 或 https:// 开头")
  }
  let path = url.pathname.replace(/\/+$/, "")
  path = path
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/api$/i, "")
  const base = `${url.origin}${path}`
  if (!hostOf(base)) throw new Error(`站点地址无法解析：${text}`)
  return base
}

export function isCookieCredential(token) {
  return COOKIE_RE.test(String(token || ""))
}

function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  if (typeof atob === "function") {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8")
  }
  throw new Error("no base64 decoder")
}

/** A JWT's payload, or null for an opaque token. */
export function decodeJwt(token) {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    return record(payload)
  } catch {
    return null
  }
}

export function jwtUserId(token) {
  const payload = decodeJwt(token)
  if (!payload) return undefined
  for (const key of ["id", "user_id", "uid", "sub", "userId"]) {
    const n = finiteNumber(payload[key])
    if (n !== undefined && n > 0) return Math.trunc(n)
  }
  return undefined
}

/** A display name a JWT carries, or "" for an opaque token. */
export function jwtUsername(token) {
  const payload = decodeJwt(token)
  if (!payload) return ""
  for (const key of ["username", "name", "preferred_username", "nickname", "email"]) {
    const text = nonEmptyString(payload[key])
    if (text) return text
  }
  return ""
}

/** Whether a JWT says it has expired (30s of leeway for clock drift). */
export function jwtExpired(token) {
  const payload = decodeJwt(token)
  const exp = finiteNumber(payload?.exp)
  if (exp === undefined) return false
  return exp * 1000 <= Date.now() + 30_000
}
/** The user-id headers new-api's forks read, added to `headers` in place. */
export function appendUserIds(headers, userId) {
  const n = finiteNumber(userId)
  if (n === undefined || n <= 0) return headers
  const value = String(Math.trunc(n))
  for (const name of USER_ID_HEADERS) headers[name] = value
  return headers
}

/** Headers new-api, one-api and their forks accept. */
export function newApiHeaders(token, userId) {
  const raw = String(token || "").trim()
  if (isCookieCredential(raw)) {
    return appendUserIds(
      {
        Cookie: raw,
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      userId,
    )
  }
  const clean = raw.replace(/^Bearer\s+/i, "").trim()
  const headers = { Authorization: `Bearer ${clean}`, Accept: "application/json" }
  return appendUserIds(headers, userId)
}

/** Headers sub2api and its forks accept (JWT in the Authorization header). */
export function sub2ApiHeaders(token) {
  const raw = String(token || "").trim()
  if (isCookieCredential(raw)) {
    return { Cookie: raw, Accept: "application/json" }
  }
  const clean = raw.replace(/^Bearer\s+/i, "").trim()
  return { Authorization: `Bearer ${clean}`, Accept: "application/json" }
}

export function headersFor(platform, token, userId) {
  return platform === "new-api"
    ? newApiHeaders(token, userId)
    : sub2ApiHeaders(token)
}

/**
 * The name a site accepts at its password login. New API login takes either the
 * account name or its e-mail, and most people only know the e-mail, so an
 * e-mail wins over an internal OAuth handle such as github_100001. Magpie's
 * naming field (metadata.email) can carry a " · host" suffix, hence the strip.
 */
export function loginNameOf(metadata) {
  const md = record(metadata) || {}
  // What the user typed when adding the account always wins.
  const stated = nonEmptyString(md.loginUsername)
  if (stated) return stated
  const candidates = [
    nonEmptyString(md.label),
    stripHostSuffix(md.email),
    nonEmptyString(md.username),
  ].filter(Boolean)
  return candidates.find(isEmailLike) || candidates[0] || ""
}

function stripHostSuffix(value) {
  const text = nonEmptyString(value)
  const at = text.lastIndexOf(" · ")
  return at > 0 ? text.slice(0, at).trim() : text
}

function isEmailLike(value) {
  const text = nonEmptyString(value)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
}

/**
 * An account as the adapters see it, from the auth object Magpie hands a hook
 * ({type: "api", key, metadata}) or from a plain object in the tests.
 */
export function accountOf(auth) {
  const md = record(auth?.metadata) || {}
  const custom = normalizeCustomConfig(md)
  const rawKey = nonEmptyString(auth?.key)
  // A login-style account is keyed by its login name, not by a token, so that
  // key must never be mistaken for one: no token is read from metadata for it.
  const loginKeyed = rawKey.startsWith(LOGIN_KEY_PREFIX)
  const noToken = custom.noToken || rawKey === NO_TOKEN_KEY || loginKeyed
  // No token is read from a login-style account: it signs in with the login name
  // and password in metadata and reads its balance with the session cookie that
  // sign-in earns (lib/session-cookie.mjs). `token` is that name, for the label.
  const token =
    custom.noToken || rawKey === NO_TOKEN_KEY
      ? ""
      : loginKeyed
        ? loginNameOf(md) || rawKey.slice(LOGIN_KEY_PREFIX.length)
        : rawKey
  const platform = isValidPlatform(md.platform) ? md.platform : "auto"
  return {
    token,
    baseUrl: md.baseUrl || md.url ? normalizeBaseUrl(md.baseUrl || md.url) : "",
    platform,
    // A custom account may still have had new-api/sub2api detected at
    // sign-in; its balance and site name are read from there.
    detectedPlatform: ["new-api", "sub2api", "sub2api-pro"].includes(md.detectedPlatform)
      ? md.detectedPlatform
      : "",
    userId: finiteNumber(md.userId) ?? jwtUserId(token),
    username: nonEmptyString(md.username),
    label: nonEmptyString(md.label),
    apiKey: nonEmptyString(md.apiKey) || nonEmptyString(md.apikey),
    quotaPerUnit: finiteNumber(md.quotaPerUnit) || 500_000,
    siteName: nonEmptyString(md.siteName),
    custom,
    noToken,
    cookie: isCookieCredential(token),
    // Login-style check-in: some New API forks award the daily quota as a side
    // effect of a password login instead of exposing /api/user/checkin. The
    // credentials sit in metadata next to the token, which Magpie already
    // stores in the same protected file.
    loginCheckin: {
      mode: nonEmptyString(md.checkinMode),
      username: loginNameOf(md),
      password: nonEmptyString(md.loginPassword),
    },
    checkinMode: nonEmptyString(md.checkinMode),
  }
}

/** True when this account checks in by logging in rather than by an endpoint. */
export function isLoginCheckin(account) {
  return account?.checkinMode === "login" && Boolean(account?.loginCheckin?.password)
}

/** The name Magpie shows for the account (metadata.email is its naming field). */
export function displayLabel({ label, baseUrl, username, userId, token }) {
  const host = hostOf(baseUrl)
  const stated = nonEmptyString(label) || nonEmptyString(username)
  const id = finiteNumber(userId)
  const tail = nonEmptyString(token) ? String(token).slice(-4) : ""
  const who = stated || (id ? `#${Math.trunc(id)}` : tail || host)
  return (who === host ? host : `${who} · ${host}`).slice(0, 80)
}

/** A dollar amount for a balance line: $0.00, <$0.01, $1.23, $1,234.56. */
export function usd(value) {
  const n = finiteNumber(value)
  if (n === undefined) return ""
  if (n === 0) return "$0.00"
  if (n > 0 && n < 0.01) return "<$0.01"
  const text = Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : n.toFixed(2)
  return `${n < 0 ? "-" : ""}$${text.replace("-", "")}`
}


// ---------------------------------------------------------------- editing
//
// An edit rewrites an account's metadata only; the key stays as it is, because a
// login-style account is keyed by its login name and a custom one by its request
// config, so neither holds a token that an edit could rotate.
//
// A login-style account keeps no token at all: it signs in with its password and
// reads its balance with the session cookie that sign-in earns
// (lib/session-cookie.mjs), which lives in this process's memory for 30 minutes
// and is never written to plugin-auth.json.

/**
 * The fields the edit tool may overwrite. Every other field of metadata is either
 * derived from a fetch or describes the account's shape.
 */
export const EDITABLE_FIELDS = ["label", "userId", "apiKey", "loginUsername", "loginPassword"]

/**
 * The fields the last fetch derived from the site. An edit drops them: the site
 * was not re-read, so a value kept here is the old answer to a new question.
 * The next check-in or balance read fills them in again.
 */
export const DERIVED_FIELDS = [
  "username",
  "email",
  "siteName",
  "detectedPlatform",
  "hasBalance",
  "detectedAt",
]

/** Values typed into a password field to mean "it is set", not a password. */
const EMPTY_PASSWORD_HINTS = ["password", "密码", "凭证"]

function sameValue(a, b) {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * True when the key is a site address rather than a credential the site issued.
 * An account keyed that way already says where it goes.
 */
function keyCarriesAddress(key) {
  const text = nonEmptyString(key)
  if (!text) return false
  if (text === NO_TOKEN_KEY || text.startsWith(LOGIN_KEY_PREFIX)) return false
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
}

/**
 * The metadata an edit leaves behind. Pure: `current` is never mutated.
 *
 * @param current     the account's metadata as stored now
 * @param changes     what the person typed; null/undefined means "leave it alone"
 * @param frozenToken the account's key, which an edit cannot change (see applyEdit)
 * @param now         the moment of the edit, stored as `detectedAt`
 * @returns {ok, errors, metadata, changed}: `changed` names the fields that differ
 *   from `current`, so a caller can show exactly what a save would touch.
 */
export function mergeAccount({ current, changes, frozenToken, now } = {}) {
  const next = { ...(record(current) || {}) }
  const input = record(changes) || {}
  const token = frozenToken === undefined ? next.token : frozenToken
  const changed = []
  const errors = []

  for (const field of EDITABLE_FIELDS) {
    const value = input[field]
    if (value === undefined || value === null) continue
    if (field === "loginPassword") {
      const password = String(value)
      if (!password.trim()) {
        delete next.loginPassword
        continue
      }
      if (!sameValue(password, next.loginPassword)) changed.push(field)
      next.loginPassword = password
      continue
    }
    const text = nonEmptyString(value)
    const held = field === "userId" ? finiteNumber(next.userId) : nonEmptyString(next[field])
    const clean = field === "userId" ? finiteNumber(value) : text
    if (!sameValue(clean, held)) changed.push(field)
    if (clean === undefined) delete next[field]
    else next[field] = clean
  }

  if (Object.prototype.hasOwnProperty.call(input, "baseUrl")) {
    if (keyCarriesAddress(token)) {
      errors.push("这个账号的地址写在账号标识里，改站点地址请重新添加账号")
    } else {
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      if (!baseUrl) errors.push("站点地址要像 https://example.com")
      else if (!sameValue(baseUrl, nonEmptyString(next.baseUrl))) changed.push("baseUrl")
      if (baseUrl) next.baseUrl = baseUrl
      if (baseUrl) delete next.url
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "platform")) {
    const platform = nonEmptyString(input.platform)
    if (!platform) {
      delete next.platform
    } else if (platform === "custom") {
      errors.push("自定义接口账号的请求配置请重新添加账号来修改")
    } else if (!isValidPlatform(platform)) {
      errors.push(`未知的站点类型：${platform}`)
    } else {
      if (!sameValue(platform, nonEmptyString(next.platform))) changed.push("platform")
      next.platform = platform
    }
  }

  // A custom account's request config lives in its `custom` object, which a
  // generic edit tool cannot rewrite, so editing it is refused outright.
  if (next.platform === "custom") {
    errors.push("自定义接口账号的请求配置请重新添加账号来修改")
  }

  if (next.checkinMode === "login") {
    const name = nonEmptyString(next.loginUsername)
    const password = nonEmptyString(next.loginPassword)
    const hint = password && EMPTY_PASSWORD_HINTS.includes(password.toLowerCase())
    if (!password || hint) errors.push("登录式签到需要填写站点登录密码")
    if (!name) errors.push("登录式签到需要填写站点登录邮箱或用户名")
  }

  // Everything else in metadata describes a site read that this edit invalidates.
  for (const field of DERIVED_FIELDS) delete next[field]

  // quotaPerUnit is the exception: the rate a site reports can change, and a
  // stale one would misprice every balance shown, but a missing one breaks the
  // amount too. Keep a usable number and let the next read replace it.
  next.quotaPerUnit = finiteNumber(current?.quotaPerUnit) || 500_000

  if (now) next.detectedAt = now

  return { ok: errors.length === 0, errors, metadata: next, changed }
}

export { round2 }
