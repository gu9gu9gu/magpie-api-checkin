// Editing a saved api-checkin account: read the store, merge one account's
// changes, and write it back without touching the other entries.
//
// The CLI in tools/edit-account.mjs is a thin prompt layer over these
// functions; keeping the merge and the write here makes them testable without
// spawning a child process (this sandbox forbids that).

import { copyFile, readFile, writeFile } from "node:fs/promises"

import { accountOf, mergeAccount } from "./auth.mjs"

export const PROVIDER = "api-checkin"

export function isProviderKey(key) {
  return key === PROVIDER || key.startsWith(`${PROVIDER}#`)
}

export function accountKeys(store) {
  return Object.keys(store || {}).filter(isProviderKey)
}

/** A summary with no secret values, safe to print. */
export function summaryOf(storeKey, entry) {
  const md = entry?.metadata || {}
  return {
    key: storeKey,
    label: md.label || md.username || "",
    baseUrl: md.baseUrl || "",
    platform: md.platform || "auto",
    login: md.checkinMode === "login",
    // A login-style account is verified by its saved password; a custom one by
    // its own request config. Neither keeps an access token any more.
    passwordSet: Boolean(md.loginPassword),
  }
}

export function formatSummary(s) {
  const flags = [
    s.login ? "登录式" : "自定义接口",
    `密码${s.passwordSet ? "已设置" : "未设置"}`,
  ].join(" · ")
  return `  ${String(s.key).padEnd(22)} ${String(s.label).padEnd(24)} ${s.baseUrl}  [${flags}]`
}

/**
 * Merge `changes` into one account. Returns a new store; the input is never
 * mutated. An edit never touches `entry.key`: a login-style account is keyed by
 * its login name, a custom one by its request config, and neither holds a token
 * that an edit could rotate.
 */
export function applyEdit(store, storeKey, changes, now) {
  const entry = store?.[storeKey]
  if (!entry) {
    return { ok: false, errors: [`没有账号：${storeKey}`], store, changed: [], metadata: null }
  }
  const merged = mergeAccount({
    current: entry.metadata || {},
    changes,
    frozenToken: entry.key,
    now,
  })
  if (!merged.ok) return { ...merged, store }
  const nextStore = structuredClone(store)
  const nextEntry = nextStore[storeKey]
  nextEntry.metadata = merged.metadata
  return {
    ok: true,
    errors: [],
    store: nextStore,
    changed: merged.changed,
    metadata: merged.metadata,
  }
}

/** Read a store file. */
export async function readStore(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

/**
 * Write only when the user confirmed. On cancel the file is left untouched,
 * which is the "取消编辑" contract.
 */
export async function commitEdit({ file, store, confirmed, stamp }) {
  if (!confirmed) return { saved: false }
  const suffix = stamp || new Date().toISOString().replace(/[:.]/g, "-")
  const backup = `${file}.bak-${suffix}`
  await copyFile(file, backup)
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  const reread = await readStore(file)
  return { saved: true, backup, store: reread }
}

/** The account as the plugin will see it after a save (for the final check). */
export function accountAfter(store, storeKey) {
  const entry = store?.[storeKey] || {}
  return accountOf({ key: entry.key, metadata: entry.metadata })
}

