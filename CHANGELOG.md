# 版本更新记录

本文件的三个小节按方向分开写，方便对照：

- **插件功能**（登录、签到、余额、编辑账号）——面向使用插件的用户
- **工程**（测试、文档、目录约定）——面向维护者
- **站点兼容性**——面向 new-api / sub2api 站点自身的接口变化

版本号取自 `package.json` 的 `version`，未单独打 git tag。

## 0.5.0 — 2026-11-25

### 插件功能

- **编辑已保存账号**：新增 `tools/edit-account.mjs`（逻辑在 `lib/edit-account.mjs`、合并规则在 `lib/auth.mjs` 的 `mergeAccount`）。
  - `node tools/edit-account.mjs` 列出本插件的所有账号：备注、站点、登录式/自定义、密码是否已设置；**不读取、不打印、不显示长度**任何密钥。
  - `node tools/edit-account.mjs "<关键字>"` 按 key / 备注 / 用户名 / 邮箱 / 站点登录名匹配一个账号，逐项提示修改；**回车 = 保持原值**，只有真正填了内容的项才覆盖。
  - `--dir <配置目录>` 指定 magpie 配置目录（默认 `%USERPROFILE%\.config\magpie`）。
  - 站点地址会做规范化；若该账号的地址写在**账号标识（key）里**、改地址会与之打架，则拒绝改地址并提示「重新添加账号」，不会写出一个自相矛盾的条目。
  - 站点类型只接受已知值；自定义接口账号的请求配置不能在这里改（提示重新添加）。
  - 登录式账号：密码空/占位（如 `password`、`密码`、`凭证`）会被拒；站点登录名与令牌都空也会被拒。
  - 派生字段（用户名、邮箱、站点名、识别出的平台、余额、识别时间、`quotaPerUnit`）在编辑时**删除**，下次刷新 / 签到重新探测；其中 `quotaPerUnit` 读取时回退缺省 500000。
  - 保存前打印「已修改：N 项（字段名）」并要求 `y` 确认；确认后先把旧文件备份成 `plugin-auth.json.bak-<时间戳>`，再写 2 空格缩进 + 结尾换行，写后回读校验。
  - 密码输入不回显（TTY 原始模式），管道输入也可用；密码只在本进程内存里出现，不打印、不写日志。
- **余额改走登录会话 Cookie**（登录式账号不再需要令牌）：
  - 新增 `lib/session-cookie.mjs`：用保存的站点用户名 + 密码 `POST /api/user/login`，从响应的 `Set-Cookie` 里取出 `session`，再带 `Cookie: session=…` 请求 `GET /api/user/self` 读余额。
  - Cookie 只在**进程内存**缓存，TTL **30 分钟**；过期、或站点以 401/403 拒绝时，自动重新登录再取一次（`newApiSelf` 内最多重试一轮），用户无感。Cookie **从不落盘**，**不写进 `plugin-auth.json`**。
  - 触发时机：Magpie 用量页的**刷新按钮**（`usage` 钩子）→ `profileOf` → `newApiSelf`；以及登录式签到算奖励前后的余额读取。
  - 令牌账号行为不变：仍走 `Authorization: Bearer <token>`；仅当站点拒绝该令牌（401/403、`success:false`、或返回 HTML 而非 JSON）且账号存有登录凭据时，才回退到会话 Cookie 路径。
  - 会话 Cookie 请求会同时带上 `New-Api-User` 头（`lib/auth.mjs` 的 `appendUserIds`，现已导出），很多 one-api 分支缺这个头会直接 401。

### 修复

- **登录式账号的令牌字段彻底移除**：`/api/user/login` 不等同于取令牌接口，部分分支的 `data.access_token` 是 `null` 甚至对象形态。
  - `authorize` 的登录式分支不再读取、不再写入 `inputs.token`，metadata **不再存 `token`**；账号 key 固定为 `login:<登录名>`。
  - `accountOf`：key 以 `login:` 开头的账号 `token` 恒为 `""`、`noToken` 恒为 `true`，即便旧 metadata 里残留 `token` 也不读（兼容升级前添加的账号）。
  - `usage` 不再因为「登录式账号没有令牌」提前返回空余额；改为只有「既无令牌、也没有登录凭据」才报『账号缺少登录凭据』。
  - 登录式签到的「登录前/登录后余额差」改用会话 Cookie 读两次余额算差值，不再依赖令牌。
  - 删掉「站点下发了新的访问令牌，请重新添加该账号以更新令牌」的提示（该路径已不存在）。
- 自定义接口的占位符里移除 `{token}`、`{bearer}`、`{cookie}`（置空以兼容旧模板），`buildCustomRequest` 不再自动注入 `Authorization: Bearer` / `Cookie` 头：自定义账号的鉴权写在自己的 Header 里。
- `lib/http.mjs` 的 `USER_AGENT` 版本号同步到 `0.4.0`。

### 工程

- `.gitignore` 新增 `/tmp/`、`.verify-tmp/`：临时脚本、临时配置目录不入库。
- 新增 `lib/session-cookie.mjs`、`lib/edit-account.mjs`、`tools/edit-account.mjs`、`test/session-cookie.test.mjs`、`test/edit-account.test.mjs`。
- 测试数量从 **89** 增加到 **122**，全部通过（`test/*.test.mjs` 逐个 `node` 直跑；本沙箱里 `node --test` 会 spawn EPERM）。
- README 补充登录式签到、余额获取、会话 Cookie 自动获取与刷新按钮更新余额的说明；新增目录清单中的 `lib/session-cookie.mjs`。

### 站点兼容性（`https://ps.air-outer.com`，new-api 二次开发）

- 该站 **`/api/user/self` 只认会话 Cookie**：带系统令牌请求稳定返回 `{"success":false,"message":"无权进行此操作，access token 无效"}`；带登录下发的 `session` Cookie + `New-Api-User: <用户 ID>` 才返回 `success:true` 与 `data.quota`。
- 该站 `/api/user/login` 的 `data.access_token` 为 `null`，登录响应本身已含 `quota` / `used_quota` / `checked_in`。
- 该站 `/v1/*`（模型列表、对话）在鉴权前先做**客户端识别**：任何 HTTP 头组合（含完全不带 `Authorization`）都返回同一份 `401 unauthorized_client_error`（`{"error":{"message":"unauthorized client detected, …"},"message":"UNAUTHENTICATED","success":false,"type":"unauthorized_client_error"}`），故 Magpie 里该供应商显示「0 个模型」、点「重新获取模型」报 `HTTP 401` 属**站点侧闸门**，与 API Key 是否有效无关；签到与余额都不经过 `/v1/*`，不受影响。
- 诊断证据：`GET /api/status` 正常（`data.version = init-20261016-861e4557`），`/v1/models` 响应头带 `x-oneapi-request-id`（one-api/new-api 网关特征）但不是 WAF 滑块页；`/api/user/self` 在探测频率升高时会被阿里云 WAF 人机验证页（滑块）整条拦截，与令牌 / Cookie 位置无关，低频率使用可恢复。


## 0.4.0 — 2026-11-24

### 修复 / 改进

- **新增账号默认走新站点**：登录第一步改为「添加新账号（默认）」/「重新登录已有账号」。新增时不显示已有站点；只有选择「重新登录已有账号」才会列出 `plugin-auth.json` 中保存的站点。
- **重新登录新增「逐项确认/修改全部（预填上次值）」**：URL、令牌、API Key、Header、Body、备注、用户 ID 等全部逐项显示；保存的值作为 placeholder 展示，留空或选「保持上次」即沿用。
- **令牌 + 用户 ID 校验**：内置或自动识别为 new-api/sub2api 时，会核对填写的用户 ID 与令牌实际用户；不一致时拒绝并提示「令牌属于 #x，你填写的是 #y」。
- **同一站点多个用户**：同一个站点地址可以分别用各自的令牌和用户 ID 添加多个账号；账号名按用户名/用户 ID/备注区分。
- 说明：Magpie 当前版本不会把「点击的是新增还是重新登录」传给插件，因此第一步必须先问一次；默认是新增账号。
- 测试数量从 85 增加到 **89**，全部通过。

### 验证

- 真实 Magpie **0.1.4685**（隔离配置目录 + 本地 mock 站点）：
  - 第一步显示「要新增账号，还是重新登录已有账号？」，默认项是「添加新账号」。
  - 选择新增后直接进入站点地址，不显示已有站点。
  - 选择「重新登录已有账号」→ 选账号 →「逐项确认/修改全部」：URL、站点类型「保持上次」、令牌（••••oken）、备注（tester）、用户 ID（7）、API Key（••••-old）逐项出现；全部留空后登录成功，请求使用旧令牌和旧 API Key。

## 0.3.0 — 2026-11-24

### 新增

- **重新登录自动沿用上次配置**：账号失效后重新登录时，插件会读取 Magpie 的 `plugin-auth.json` 中本插件（`api-checkin` / `api-checkin#...`）已有账号，先问要沿用哪个账号，再问沿用方式。
  - **只更新访问令牌（推荐）**：URL、站点类型、Header、Body、备注、用户 ID、API Key 全部保留，只重新输入令牌；令牌留空则继续使用上次的令牌。
  - **沿用上次令牌，重新填写请求配置**：URL、站点类型、Header、Body 等可以改，令牌保留；留空的项继续使用上次的值。
  - **完全沿用上次配置（包括令牌）**：不再询问其他问题，直接用上次的配置重新登录。
  - **重新填写全部**：回到原来的逐项提问流程，用于新增账号或彻底改配置。
- 沿用后仍使用原账号名（备注/用户名 · 域名），因此会**覆盖原账号**，不会新增重复账号。
- 重新登录成功时同时更新 `key` 与 `metadata.token`，两处令牌保持一致。
- 新增 `lib/saved.mjs`：只读取本插件自己的账号条目，不复制令牌到新文件，不向任何第三方发送。
- 新增 `test/reuse.test.mjs`：覆盖账号读取、选择流程、只更新令牌、只改请求但保留令牌、完全沿用、无令牌自定义账号、账号消失等场景。
- 请求模式（保留令牌，修改 URL/平台/Header/Body）逐项留空即沿用上次值；平台和请求方法提供「保持上次」按钮。

### 修复

- URL / 自定义接口地址的输入校验允许留空，这样重新登录时留空会沿用上次值；必填校验改到合并旧配置后的 `authorize` 阶段执行。

### 文档

- README 新增「账号失效 / 重新登录」章节。
- 新增本 `CHANGELOG.md`，记录各版本更新列表。
- 测试数量从 75 增加到 **85**，全部通过。

### 验证

- 真实 Magpie **0.1.4685**（隔离配置目录 + 本地 mock 站点）：
  - `magpie plugin login api-checkin` 首先显示「检测到之前登录过的 API 签到账号，要沿用上次配置吗？」
  - 选择「只更新访问令牌」并输入新令牌 → 登录成功，请求使用 `Bearer new-token`，`key` 与 `metadata.token` 都是新令牌，仍然只有一个账号。
  - 选择「完全沿用上次配置（包括令牌）」→ 不再询问令牌，直接使用旧令牌登录成功。
  - 选择「沿用上次令牌，重新填写请求配置」，URL 留空、平台选「保持上次」、其余留空 → 登录成功，请求仍使用旧令牌。

## 0.2.0 — 2026-10-26

### 新增

- **自定义接口签到**：站点类型新增「自定义接口」，可配置请求方法、URL、Header、Body、成功/已签到关键词、奖励字段/除数、连续天数字段、余额地址/字段/除数。
- URL、Header 值、Body 支持占位符：`{token}`、`{bearer}`、`{cookie}`、`{userId}`、`{username}`、`{apiKey}`、`{baseUrl}`、`{host}`、`{label}`、`{date}`、`{month}`、`{timestamp}`、`{iso}`。
- 自定义响应判断：已签到标记、验证码、签到关闭、权限、令牌失效、限流、404/405、5xx、Cloudflare HTML、常见 JSON `success`/`ok`/`code`/`ret`/`status`/`error` 信封。
- 自定义余额读取；也可在自定义签到之外沿用自动识别出的 new-api/sub2api 余额。
- 无令牌自定义账号支持：令牌留空，把认证写进自定义 Header。
- 内置 new-api/sub2api 签到结果增加连续天数（`streak`）。

### 改进

- 抽出 `lib/messages.mjs`、`lib/results.mjs`、`lib/values.mjs`、`lib/config.mjs`、`lib/custom.mjs`。
- new-api 的「今日已签到」判断优先于 `success: true`，避免魔改站点误报为本次领取。
- 文档补充自动签到开关、结果展示、自定义接口示例和故障排查。
- 测试数量从 41 增加到 75。

### 验证

- 真实 Magpie **0.1.1560** + 本地 mock 自定义站点：
  - `magpie accounts checkin` → `checked in today +0.2 · a 4-day streak`
  - 同日再次执行 → `already`，不再发请求
  - `magpie quota` → 自定义余额按字段/除数显示
  - 打开插件自动签到后，网关约 105 秒自动签到成功

## 0.1.0 — 2026-10-25

### 新增

- new-api / one-api / sub2api / sub2api Pro 的每日签到适配。
- 余额读取：new-api 按 `quota_per_unit` 换算美元，sub2api 直接 USD。
- 通过 Magpie 的 `auth.checkin` 钩子自动签到，结果在用量页和 `magpie accounts checkin` 中显示。
- 可选 `sk-` API Key：把站点当作普通模型供应商使用。
- 41 个单元测试和本地 HTTP mock 测试。
