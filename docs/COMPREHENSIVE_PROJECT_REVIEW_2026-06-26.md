# Amaduse Imagebot 全面复核与整改基线

- 复核日期：2026-06-26
- 基线分支：`main`
- 基线提交：`f7bb38c4f21a3e3526830dc4f58d0c2fed1f6acd`（`Add Mars visual similarity review`）
- 仓库：`HayOMO/amadeus-openclaw-lab`
- 复核方式：GitHub 当前源码静态复核；未在目标 Windows 主机上执行 `npm run test:all` 或启动 Gateway。

本文给后续实现者用作整改基线。不要只改提示词、手册或字符串断言；高风险安全属性必须落到运行时代码、可信上下文和可重复测试里。

## 总体结论

项目不是一堆随手堆的脚本。它已经有集中配置、运行态数据与 Git 分离、插件手册、能力契约、运行时补丁 manifest、replay/测试和较完整的本地工具层。

但当前实现的安全边界仍明显弱于文档和契约描述：用户授权、跨群隔离、账号浏览、贴纸远端写入、知识持久化、Mars 视觉复核等关键路径，仍有不少地方依赖模型参数或提示词配合。作为少量互信群、本机私用 Bot 可以继续用；如果两个群不完全互信，或浏览器 profile 登录重要账号，P1 必须先修。

## P1：必须优先处理

### F-01 本地控制服务器无认证

相关文件：`imagebot-control-server.js`。

2026-06-26 进展：已加启动时高熵控制 token、`Host` 白名单、`Origin`
校验、JSON POST 限制、静态路径 `path.relative()` 边界和 `/api/status`
脱敏；覆盖测试见 `scripts/TEST_CONTROL_SERVER_AUTH.mjs`。后续若要继续
收紧，可把 HTTP 管理面迁到命名管道或父子进程 IPC。

基线时控制面板监听 `127.0.0.1:18788`，但 API 没有认证、没有 Host/Origin/Referer 校验、没有 CSRF token、没有强制 JSON content type。它能读状态、日志尾部、模型配置、插件状态，也能改模型、启动/停止/重启 Gateway、打开本地目录、退出控制服务器。

仅绑定 loopback 不能当授权。本机其他进程可直接调用；浏览器侧还要考虑跨站请求和 DNS rebinding。静态文件边界也不应使用 `startsWith(APP_DIR)`，应改为 `path.relative()` 检查。

整改要求：

- 启动时生成高熵本地控制令牌，所有 `/api/*` 必须校验。
- 严格验证 `Host` 为预期 loopback 主机和端口。
- POST 校验 `Origin`，拒绝非预期来源和非 JSON 请求。
- `/api/status` 默认不返回绝对路径和原始日志。
- 静态文件使用 `path.relative(APP_DIR, filePath)` 判断是否逃逸。
- 中期考虑命名管道、父子进程 IPC 或 Windows 本地 IPC，减少 HTTP 管理面暴露。

验收：无令牌、错误 Host、跨站 Origin、`text/plain` POST、编码路径穿越都必须失败；状态响应不含 root/logPath/token/session/raw log。

### F-02 审批计划没有绑定真实用户、群、消息和会话

2026-06-26 进展：新增 `plugins/imagebot-shared/mutation-authorization.mjs`。
`script_action` 和 `model_config` 的审批计划已绑定 scope/actor/request message，
执行时校验同一发起人在后续可信运行时消息中重复审批码。`approval_text` 仅保留为
legacy 字段，不再作为授权来源。后台脚本入队前会先消费 plan，避免同一 plan 在同一
进程内重复入队。

相关文件：`plugins/imagebot-creative-ops/index.js`。

`script_action` 和 `model_config` 的审批计划只保存 plan id、动作、过期时间、审批码和 used 状态。执行时只检查模型传入的 `approval_text` 是否包含审批码。审批码又会先作为工具结果返回给模型，所以代码不能证明批准来自“同一用户之后发送的一条明确批准消息”。

整改要求：

- 新建共享 `MutationAuthorization` 组件。
- 创建计划时绑定 accountId、chatId、threadId、senderId、sessionKey、requestMessageId、动作和目标 fingerprint。
- 批准必须由运行时从后续 Telegram 原始消息确认，不能只信模型参数。
- 批准消息必须晚于计划，来自同一 actor/scope，并匹配目标摘要。
- 审批码用 `crypto.randomBytes`，存 hash。
- 消费计划必须用 SQLite 事务或等价原子 CAS，保证一次计划只执行一次。

验收：模型自行回填审批码失败；另一用户/另一群/另一 window/旧消息重放失败；并发双执行只成功一次；缺少可信 ctx 的写操作全部 fail closed。

### F-03 Sticker 远端副作用依赖模型布尔值，缺上下文时放行

2026-06-26 进展：Sticker 的 Telegram 远端 mutation 在 `dryRun:false` 时已改为缺
requester context fail closed，并支持 `sticker_pack action=plan` 的一次性审批闭环；
也可接收 runtime 注入的可信 mutation approval。模型参数里的
`directUploadApproved`、`directImportApproved`、`directManagementApproved` 等 legacy
布尔字段会被拒绝，不再能授权真实写入。测试覆盖缺 ctx、无可信批准、legacy flag
自批、owner mismatch、plan 重放。

相关文件：`plugins/imagebot-sticker-pack/index.js`、`scripts/TEST_STICKER_PACK_PLUGIN.mjs`。

当前 `assertOwnerMatchesContext` 在 `dryRun:false` 且拿不到 requester 时直接返回，不拒绝。也就是说真实写入路径中，ctx 缺失不是 fail closed，而是 fail open。

另外，`directUploadApproved`、`directImportApproved`、`directManagementApproved`、`explicitUserApproval` 这类字段只是工具参数布尔值，本质上由模型生成，不能独立证明用户批准。

整改要求：

- 所有 Telegram 远端写动作必须接入 F-02 的统一授权中间层。
- `dryRun:false` 且缺可信 ctx 时必须失败。
- schema 中移除模型可直接声称“已批准”的布尔字段。
- `dryRun:false` 只能来自已消费的授权计划，而不是模型参数。
- 创建、添加、删除、上传、复制、关键词/emoji 修改都绑定目标 fingerprint。
- 本地 registry 写入和 Telegram 远端写入分开分级；本地写入也要按 actor/scope 隔离。

验收：每个远端动作覆盖无 ctx、actor 不匹配、scope 不匹配、无批准、重放、并发双执行；owner 匹配但没有批准时仍保持 dry-run。

### F-04 跨群、跨 window 的状态和能力缺少强制作用域

2026-06-26 progress: `background_job` now stores normalized runtime context
with `scopeKey`/`actorKey`; list/get/cancel default to the current
chat/session/window scope, and open-job dedupe keys include scope. Practical
tool artifacts now persist the same context and `artifact_recent`,
`artifact_search`, and `artifact_get` default to the current scope. Legacy
records without provenance remain available only to no-context local/admin
maintenance calls. `generated_gallery_*` is intentionally left as a migration
item because existing archive manifest rows may not contain trustworthy
chat/session provenance.

当前配置有两个 Telegram 群。若两个群完全互信，这是架构债；若不完全互信，就是 P1 数据隔离问题。

需要重点隔离的共享面：

- `background_job`：list/get/cancel 没有强制按当前 chat/session 过滤；默认 dedupe key 不含 scope。
- `generated_gallery_*`：共享 archive；recent/search/resend 不使用调用者上下文。
- `artifact_*`：共享 artifact 日志和媒体路径。
- `memory_search`：可遍历 users/group/windows 全部记忆，执行时不强制当前群 scope。
- `knowledge_*`：persona、manual、memory、user_docs 在统一注册表中。
- `web_snapshot`：共享持久 Playwright profile 和 artifact store。
- sticker managed-set、feature state、运营日志等也有全局目录。

整改要求：

- 统一 `scope_key = accountId + chatId + threadId`，`actor_key = scope_key + senderId`。
- 所有持久记录保存 scope 和 owner。
- 默认查询只允许当前 scope；用户私有记录再叠加 actor。
- `background_job get/cancel` 验证 job context。
- gallery/artifact 补来源 chat/window；历史无来源数据进入 legacy/admin 域，不默认暴露。
- 跨 scope 管理另设管理员接口，不复用普通群工具。
- dedupe key 默认包含 scope。

验收：群 A 无法 list/get/cancel 群 B 的 job，无法 recent/search/resend 群 B 的 gallery/artifact，无法通过 memory/knowledge 拿到群 B 数据；相同 payload 在不同群生成独立后台任务。

### F-05 公开浏览和账号浏览共享持久 Playwright profile

2026-06-26 progress: `web_snapshot` / `web_card` now route ordinary public
pages through an ephemeral Playwright context per call, while known
account-backed platforms use platform-specific persistent bot profiles under
`practical-tools/browser-profiles/account/<platform>`. Navigations and
subresources are checked by a shared public-network request guard. The visible
login helper and login verification script now target the platform-specific
profiles.

2026-07-10 superseding decision: the platform-specific profile design was
retired as permission-workaround debt. The active contract has one Bot-owned
`bot` profile plus one explicit `isolated` profile; ordinary Chrome
`profile=user` is prohibited. `web_snapshot` / `web_card` are always ephemeral
and login-free. The older text below is retained only as review history.

相关文件：`plugins/imagebot-practical-tools/index.js`、`plugins/imagebot-shared/browser-context-pool.js`。

`web_snapshot` 使用固定 `browser-profiles/web-snapshot-pool` 和 `launchPersistentContext`。关闭 pool 不删除 userDataDir，因此 cookie/localStorage/登录态可能跨用户、跨群、跨时间保留。工具又支持 click、fill、press 等动作。若该 profile 登录微博、Bilibili、知乎等账号，普通群消息可能间接使用该账号。

生成配置里 OpenClaw 内置 browser 已有私网禁用和 hostname allowlist；这里的问题主要是自定义 `web_snapshot` 链路、子资源拦截、动作后的导航和账号态边界。

整改要求：

- 拆成 `web_snapshot_public` 和 `account_browser`。
- public 使用真正临时无 cookie context，禁止表单写入。
- account browser 使用独立 profile、明确 owner、仅暴露命名动作。
- 账号写动作接入统一授权和后置校验。
- Playwright route 拦截所有 request/navigation，逐跳拒绝私网、环回、链路本地、保留地址和 IPv4-mapped IPv6。

验收：public 两次调用间无 cookie/localStorage 延续；私网子资源和重定向被拦截；未授权群不能用账号 profile；账号工具不再暴露任意 selector/fill/press。

### F-06 `knowledge_ingest` 可导致长期知识投毒和无界增长

2026-06-26 progress: `knowledge_ingest` now defaults to scoped draft plans.
Persisting into `user_docs` requires `action=commit` with the original
requester's later approval-code message in the same trusted scope. New
ingested docs are stored under `user-docs/scopes/<scopeHash>`, and
`knowledge_search` / `knowledge_recent` filter `user_docs` by current runtime
scope. `knowledge_ingest action=list` and `action=delete` provide scoped
management; delete is dry-run by default.

相关文件：`plugins/imagebot-knowledge-library/index.js`。

`knowledge_ingest` 可以把模型提供文本或允许目录文本文件直接写入共享 `user_docs`。单文件有大小限制，但缺少 scope、批准、总配额、TTL、删除/撤销、来源身份和可信等级。之后 `knowledge_search` 会把这些内容重新送入模型上下文。

整改要求：

- 默认只生成草稿；持久落盘需要同一 actor 明确批准。
- 保存 scope、actor、sourceMessageId、hash、createdAt、可信等级和过期策略。
- 每 scope 设置总字节、文档数、单日写入数和单用户速率限制。
- 增加 list/delete/expire。
- 检索结果使用 data envelope，除 prompt/manual 外全部标为 untrusted data。

验收：未批准不落盘；群 A 无法搜群 B user_docs；达配额拒绝写入；文档中的“忽略系统提示”等内容只作为数据，不改变策略。

### F-07 Mars 视觉复核在提及门槛前执行高成本工作

2026-06-26 progress: Mars channel-forward handling now runs a light exact
fingerprint pass before the unaddressed group-message drop gate. That pass only
uses forwarded channel source, canonical URL, and Telegram `file_unique_id`.
Media download, local cache writes, and visual hash computation are moved to an
in-process background index queue. Exact duplicates still dispatch immediately;
addressed messages can run foreground media evidence; visual-only duplicates
found by background indexing can re-enter Mars review. Store pruning is
time-throttled so normal messages do not trigger a full prune walk every time.

2026-06-26 follow-up: Mars duplicate state now defaults to SQLite
(`mars-forward-detector.sqlite`) with one-time JSON import. The interaction
lookup tool reads SQLite first and keeps JSON as a legacy fallback, so
`mars_forward_lookup` can retrieve the first same-group message from the same
state backend the runtime writes.

相关文件：`patches/openclaw-2026.6.10-runtime/02-bot-Dxj27QDQ.js.patch`、
`scripts/TEST_TELEGRAM_MARS_FORWARD_DETECTOR.mjs`。

基线提交新增 Mars 视觉相似度。它的优点是：Telegram fetch 有超时，单文件仍限制约 20 MiB，相似哈希只作为 LLM review candidate，不直接脚本定罪。

但调用顺序有可用性风险：`maybeHandleTelegramMarsForwardCandidate` 在 `shouldDropUnaddressedImagebotGroupMessage` 前运行。未 @ Bot 的 channel forward 也可能触发 Telegram getFile、下载、Buffer 读入、落盘、Sharp/DCT 哈希、同步 JSON 读写、同步目录扫描和线性状态遍历。配置还允许 100,000 entries 与 100 GiB Mars 媒体缓存。

整改要求：

- 提及门槛前只做廉价常数级 fingerprint：forward source、canonical URL、file_unique_id。
- 媒体下载与视觉哈希进入受限后台队列；当前已做全局队列、并发和队列长度预算，后续可按 chat/user 拆分。
- 第一次出现可异步建索引，不能阻塞 Telegram handler。已完成。
- Mars state 迁移 SQLite 或增量 KV。已完成 SQLite 主存储；仍待做专用视觉索引。
- 视觉检索使用专用索引，不线性扫描 100k key。
- LRU 使用增量字节计数，后台清理，不每次全目录同步扫描。
- 100 GiB 媒体缓存按用户要求保留；后续应加增量字节计数、文件数和 per-scope 可观测预算，而不是靠小缓存掩盖索引问题。

验收：10k/100k 历史记录下单条 forward handler 延迟有上限；未提及 forward 不执行全量 JSON/目录/视觉扫描；突发转发被限流且不影响其他群窗口。

## P2：工程与可靠性

### F-08 JSON 状态并发丢更新

审批计划、feature state、cooldown、sticker registry、watch state、部分 runtime patch state 仍大量使用 read-modify-write JSON。原子 rename 只能防半截文件，不能防并发覆盖。审批、任务、签到、cooldown、图库元数据、知识文档、Mars 索引应迁移 SQLite；过渡期至少按 state path 加 mutex/lock/CAS。

2026-06-26 progress: Mars forward detector state moved to SQLite. Other JSON
state families listed above remain open.

### F-09 依赖安装不可复现

`.gitignore` 忽略 lockfile，hygiene 禁止跟踪 lockfile，安装脚本用 `npm install --omit=dev`，且发现 `node_modules` 就跳过。建议改 root workspace 或提交插件 lockfile，使用 `npm ci --omit=dev`，安装状态记录 lock hash。

2026-06-26 progress: root and dependency-plugin `package-lock.json` files are
tracked, hygiene requires them, and plugin dependency setup uses `npm ci
--omit=dev` when a lockfile exists.

### F-10 测试很多，但没有 CI 和攻击场景

`TEST_IMAGEBOT_ALL.mjs` 的枚举入口是好的；问题是没有 GitHub Actions/commit status，且架构契约测试很多只是字符串证据，例如源码里出现 `assertOwnerMatchesContext`。应新增：

```text
TEST_MUTATION_AUTHORIZATION.mjs
TEST_STICKER_FAIL_CLOSED.mjs
TEST_CROSS_SCOPE_ISOLATION.mjs
TEST_CONTROL_SERVER_AUTH.mjs
TEST_WEB_SNAPSHOT_NETWORK_BOUNDARY.mjs
TEST_KNOWLEDGE_INGEST_GOVERNANCE.mjs
TEST_STATE_CONCURRENCY.mjs
TEST_MARS_FORWARD_RESOURCE_BUDGET.mjs
```

并给 `main` 加 branch protection。

2026-06-26 progress: added a GitHub Actions Windows test workflow covering
config lint, feature health, full local tests, and runtime patch verification.
Branch protection remains a repository setting to enable outside code.

### F-11 运行时补丁强耦合 OpenClaw dist

manifest 固定 OpenClaw `2026.6.10`、Node `24.15.0` WinGet 路径和多个带 hash 的 dist 文件。apply/verify 做得认真，但升级成本高。建议增加目标 hash、来源 package integrity、最后验证时间；能转为插件 hook 或上游 PR 的逐步移出 dist patch。

### F-12 Secret scan 覆盖不足

`TEST_REPO_HYGIENE.mjs` 主要扫 `gho_` 与 OpenAI `sk-`，覆盖不足。建议引入 gitleaks/trufflehog，覆盖 Telegram token、GitHub PAT、OpenAI/Google/Slack/AWS key、私钥、cookie、connection string 和高熵 token，并放入 pre-commit 与 CI。

2026-06-26 progress: CI now runs Gitleaks and TruffleHog on full checkout
history. Local pre-commit integration is still optional/not installed.

## 已确认优点

- 运行态秘密、session、日志、生成媒体和二进制与 Git 分离。
- 配置来源集中，`settings.json`、prompt segments、config builder 分工清楚。
- 工具普遍有尺寸、数量、超时、允许目录和 dry-run 概念。
- OpenClaw patch 有版本化 manifest、行为说明、apply/verify 脚本和测试映射。
- capability surface、tool manuals、architecture contract、trace/replay、memory taxonomy 已存在。
- 最新 Mars 相似图保持“视觉候选交给 LLM review”的保守语义，这点应保留。

## 第一轮结论的修正

1. 不能说内置 browser 完全无 SSRF 防护；生成配置已有 OpenClaw browser 私网禁用和 allowlist。问题集中在自定义 `web_snapshot`、子资源拦截和 yt-dlp。
2. 跨群问题严重度取决于两个群是否互信；代码事实确定，但部署风险有条件。
3. 控制服务器无认证事实确定；网页利用条件依浏览器而异，但 loopback 不等于授权。
4. 最新 Mars 提交改善了超时和判定保守性；本轮又把未提及路径的媒体下载/视觉哈希后台化，并把 Mars state 迁移到 SQLite。专用视觉索引和增量 LRU 还未完成。
5. 现有测试数量不少；CI 已补 Windows 本地测试和 secret scan，攻击场景 fixture 仍需继续补。

## 实施顺序

### 阶段 A：硬授权边界

- 新建共享 authz 组件。
- 写操作必须获得可信 actor/scope。
- 事务化批准计划。
- Sticker、script、model、account browser 接入。
- 控制服务器加令牌、Host/Origin 检查。

### 阶段 B：作用域与持久层

- 定义 `scope_key` / `actor_key`。
- background job、gallery、artifact、memory、knowledge、browser profile 按 scope 隔离。
- 关键 JSON 状态迁移 SQLite；Mars 已迁移，其他状态继续分批处理。
- legacy 数据进入管理员域。

### 阶段 C：网络和资源预算

- 拆分公开浏览与账号浏览。
- Playwright 全请求拦截。
- yt-dlp 沙箱化并限制 playlist 总量。
- Mars 下载/哈希/LRU/相似检索后台化、索引化、限流化。
- knowledge ingest 加配额、审批、删除和来源。

### 阶段 D：可复现与 CI

- 引入 lockfile 与 `npm ci`。已完成 root/plugin lockfile。
- 新建 GitHub Actions/Windows CI。已完成。
- 加 gitleaks。已完成；同时加入 TruffleHog。
- 设置 branch protection。
- 建立 OpenClaw 升级矩阵和 patch 迁移流程。

## 临时缓解

- 控制面板不用时不启动，不要代理或端口转发 18788。
- 账号平台登录只使用平台独立 profile；旧 `web-snapshot-pool` 仅作历史检查，不再作为普通 `web_snapshot` 登录态。
- 暂时从普通群 allowlist 移除 `knowledge_ingest`，或仅允许管理员调用。
- Sticker 远端 mutation 暂时只允许 dry-run；真实发布走本地脚本。
- Mars 保留 100,000 entries、100 GiB 媒体缓存和视觉哈希；如果后续出现实际卡顿，优先迁移 SQLite/专用视觉索引和增量 LRU，而不是缩掉功能。
- 两个群若不互信，先禁用其中一个群的 gallery/memory/knowledge/artifact 共享状态工具。

## P1 完成定义

- 缺少可信 ctx 的写操作全部 fail closed。
- 模型参数不能自行声明用户已批准。
- 批准绑定 actor、scope、消息、动作和目标，并原子消费。
- 普通群工具无法跨 scope 查询、重发、取消或修改状态。
- 公开浏览无持久登录态；账号浏览有明确 owner 和授权动作。
- 未提及 Mars forward 不在主 handler 执行全量 JSON/目录/视觉线性扫描。
- knowledge ingest 有审批、来源、scope、配额和删除能力。
- 干净 checkout 可通过 lockfile 和 `npm ci` 重建。
- CI 自动执行核心测试、攻击场景测试、patch 检查和 secret scan。
- `main` 分支要求上述检查通过。

## 推荐验证命令

```powershell
npm ci
npm run build:config
npm run lint:config
npm run health:features
npm run test:core
npm run test:all
npm run audit:plugins
npm run test:patches
git diff --check
git status --short
```

仅现有命令全过不足以关闭本文 P1；还必须补授权、跨 scope、控制面板、浏览器网络边界、并发和 Mars 资源预算测试。
