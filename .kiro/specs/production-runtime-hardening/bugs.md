# Bug Inventory: Production Runtime Hardening

## Overview

本文档记录 2026-07-11 对当前工作树进行的生产运行时审计结果。清单只描述已经能从代码、部署文件或现有测试缺口中验证的问题，不把尚未实现的产品能力混入 Bug。

本轮实施范围为 `B001-B007`、`B009`，以及 `B010` 中直接影响安全和可复现验收的子集。`B008` 需要引入 durable outbox/投递状态，作为后续架构任务单独实施，避免与本轮安全修复混合上线。

## 2026-07-11 Implementation Update

- `B001-B003`、`B005`、`B009` 已完成代码和回归测试。
- `B004` 已完成协作式 deadline、AbortSignal 传播、外部转换进程终止和 `JOB_TIMEOUT` 状态映射；任意非协作 CPU handler 的进程隔离/强杀仍待 Task 6。
- `B006` 已启用 `CALLBACK_MAX_ATTEMPTS`、瞬时错误分类和有界指数退避；持久化 delivery、重启恢复和人工 replay 仍待 Task 8。
- `B007` 已对所有 Job API 使用 Public DTO，生产拒绝 inline secret，并通过 `CALLBACK_SIGNING_SECRETS` 按 `callbackSecretId` 解析；旧数据库中可能已存在的 inline secret 仍需迁移清理。
- `B010` 已修复 lockfile 安装、必需工具失败语义、Compose 文档和 PR Docker build；镜像 digest、下载校验和 Python hash lock 仍 deferred。

## Priority Summary

| ID | Severity | Status | Scope | Summary |
|---|---|---|---|---|
| B001 | P0 | Resolved | Current | 畸形 `API_KEYS` 会被解析为空并关闭鉴权 |
| B002 | P0 | Resolved | Current | wildcard scope 绕过 tenant/task 限制，API key schema 过宽 |
| B003 | P0 | Resolved | Current | 生产环境对 dev Web secret、query token、local state fail-open |
| B004 | P1 | Partial | Current | Worker 配置了 `jobTimeoutMs`，但执行链从未使用 |
| B005 | P0 | Resolved | Current | callback URL 未校验并自动跟随重定向，存在 SSRF |
| B006 | P1 | Partial | Current | `CALLBACK_MAX_ATTEMPTS` 和 delivery 表未接入，仅投递一次 |
| B007 | P0 | Partial | Current | `callbackSigningSecret` 明文进入 Job 并由 API 回显 |
| B008 | P1 | Confirmed | Deferred | DB 已变为 queued 后 publish 失败可永久卡住任务 |
| B009 | P0 | Resolved | Current | payment-service 生产环境无 key 时允许匿名调用 |
| B010 | P1 | Partial | Partial | Docker、README 与 CI 不能稳定复现同一运行能力 |

## Confirmed Bugs

### B001: 畸形 `API_KEYS` 导致鉴权关闭

**Evidence**

- `src/middleware/auth.ts` 的 `parseApiKeyDefinitions()` 在 JSON 解析失败或顶层不是数组时直接返回空数组。
- `isAuthEnabled()` 只检查 legacy `API_KEY` 或成功解析出的 definition 数量。
- 当 `API_KEY` 为空且 `API_KEYS` 畸形时，`authMiddleware` 把请求设置为 anonymous wildcard principal 并继续执行。

**Impact**

一次部署变量转义错误即可把 `/api/v1` 外部 API 从“需要 API key”变为“匿名拥有全部 scope”，属于 fail-open 鉴权绕过。

**Expected Fix**

生产启动时严格解析 `API_KEYS`；配置存在但无法完整验证时进程必须非零退出。运行时绝不能把“配置无效”解释为“未启用鉴权”。

### B002: wildcard scope 绕过 tenant/task 限制且 schema 过宽

**Evidence**

- `canAccessTenant()` 和 `canAccessTaskType()` 在 principal 包含 `*` scope 时直接返回 `true`，忽略同一 key 上的 `tenantIds` 和 `taskTypes` 限制。
- `isApiKeyDefinition()` 只验证 `key` 是非空字符串，没有验证 `name`、`scopes`、`tenantId(s)`、`taskTypes` 的类型、内容、重复项或未知字段。
- 缺少 `scopes` 时会自动赋予 `['*']`，错误配置会静默扩大权限。

**Impact**

原本限定 tenant 或 task type 的 partner key，只要需要 wildcard endpoint scope，就可以跨租户或提交未授权任务。宽松 schema 还会让字符串、混合数组或拼错字段进入权限计算。

**Expected Fix**

endpoint scope、tenant boundary 和 task boundary 必须彼此独立并全部满足；structured key schema 必须严格、可诊断、默认最小权限。只有明确的 legacy key 兼容模式可以拥有不受 tenant/task 限制的 wildcard 权限。

### B003: 生产配置对已知 secret、query token 和 local state fail-open

**Evidence**

- `src/config/web-auth.ts` 在未配置时使用 `API_KEY`，最后回退到公开常量 `dev-web-auth-secret`。
- `src/config/server.ts` 默认 `ALLOW_QUERY_AUTH_TOKENS=true`，API key 和 Web token 可出现在 URL、代理日志、浏览历史和 Referer 中。
- `src/config/database.ts` 在未配置 provider/URL 时回退到 local JSON store；弹性 API/Worker 进程因此可能读取彼此不可见的状态。
- `src/config/validation.ts` 只返回 warning；`src/index.ts` 在 `listen()` 成功后才记录 warning，不阻止服务接流量。Worker、Dispatcher、Monitor 入口也没有统一启动校验。

**Impact**

生产部署可能使用可预测签名密钥、泄漏 bearer token，或在多进程拓扑中静默使用本地状态，造成伪造登录、凭据泄漏和任务不可见。

**Expected Fix**

生产角色在监听或开始工作循环前执行统一 fail-fast 校验：显式强 Web secret、禁止 query token、云运行时禁止 local state，并拒绝未知枚举或缺失的必要依赖配置。

### B004: Worker job timeout 未进入执行链

**Evidence**

- `createWorkerRuntimeConfig()` 生成 `jobTimeoutMs`。
- `CloudWorker.processJob()` 直接等待 download、`registry.run()`、upload 和状态更新，没有 deadline、AbortSignal 或隔离子进程。
- Job 执行期间租约会持续续期，因此一个不返回的 handler 可以永久占用 slot 并保持 `processing`。

**Impact**

畸形模型、外部工具挂死或 handler promise 不结束时，Worker slot、余额冻结和弹性实例成本均无法按 `JOB_TIMEOUT_SECONDS` 收敛。

**Expected Fix**

从 claim 时刻计算硬 deadline；超时后终止实际执行、停止续租、清理 scratch，并以稳定 `JOB_TIMEOUT` 错误进入 retry/final-failure 路径。仅 `Promise.race` 而不终止底层工作不算完成修复。

### B005: callback SSRF 和重定向绕过

**Evidence**

- `callbackUrl` 从 API body 或 COS manifest 直接进入 Job，没有协议、主机、端口或解析后 IP 校验。
- `sendJobCallback()` 直接调用全局 `fetch(job.callbackUrl)`；默认会跟随 HTTP 重定向。

**Impact**

拥有创建 Job 权限的调用方可让 Worker 向 loopback、RFC1918、link-local、云 metadata 或内部管理服务发送 POST，并可通过公共 URL 的重定向绕过只做字符串级的检查。

**Expected Fix**

创建时和每次投递时都执行 callback target policy；生产只允许 HTTPS 公网目标，拒绝含凭据 URL、危险端口和所有非公网地址；禁止自动重定向并防止 DNS 解析与实际连接目标不一致。

### B006: callback 重试配置和 delivery 持久化未生效

**Evidence**

- `CALLBACK_MAX_ATTEMPTS` 已解析到 config，但没有消费点。
- `CallbackDelivery` 类型和 `optimizer_callback_deliveries` 表已经存在，却没有 store、调度器或 replay 实现。
- Worker 只在终态调用一次 `sendJobCallback()`，失败后仅写日志。
- 直接取消 Job 不会经过 Worker callback 路径。

**Impact**

短暂网络故障或客户 5xx 会永久丢失完成通知；进程重启后无法恢复，运营人员也无法查询或重放。取消事件与成功/失败事件行为不一致。

**Expected Fix**

终态转换幂等创建一条 delivery；持久化 attempts、状态和 next retry time；按 `CALLBACK_MAX_ATTEMPTS` 有界重试并支持重启恢复与受保护的人工 replay。

### B007: `callbackSigningSecret` 被 API 回显

**Evidence**

- `callbackSigningSecret` 是 `CloudJob` 的普通字段，并写入 `job_json`。
- create/get Job 和 Web Job 查询直接序列化完整 Job，没有 public DTO 或敏感字段过滤。
- COS manifest 也可以提交 inline secret。

**Impact**

回调签名密钥会出现在 API 响应、调试记录、浏览器状态或下游日志中；读取 Job 的权限被意外提升为读取 webhook 密钥的权限。

**Expected Fix**

所有外部 Job 响应统一经过 allowlist DTO；生产仅保存 `callbackSecretId`，由服务端 secret resolver 获取实际密钥；inline secret 在生产被拒绝，任何响应和日志都不得包含原始 secret。

### B008: queued 状态与消息 publish 非原子导致卡死

**Evidence**

- `CloudJobService.createJob()`、`completeUpload()`、`markPaid()` 和 `markWalletChargeHeld()` 先持久化 queued 状态，再调用 `queue.publish()`。
- 当 publish 失败时，Job 已是 queued，但 CMQ 中可能没有消息。
- 使用相同 idempotency key 重试 create 会直接返回已有 Job，不会补发消息。

**Impact**

一次 DB/CMQ 之间的瞬时失败即可产生永久 queued 且没有消费者可见消息的任务；用户余额可能保持冻结，Dispatcher 还可能持续按积压扩容。

**Disposition**

本轮不采用内存重试或“再调用一次 publish”的局部补丁。后续架构任务必须用 transactional outbox/显式投递状态解决：Job 状态变化与 enqueue intent 在同一数据库事务提交，独立 publisher 至少一次投递，consumer 继续幂等去重，并提供 pending/stuck 指标与修复工具。

### B009: payment-service 在生产缺少 key 时匿名开放

**Evidence**

- `services/payment-service/src/index.ts` 的 `requireServiceKey()` 在 `PAYMENT_SERVICE_API_KEY` 为空时直接 `next()`。
- Compose 文件允许 `${PAYMENT_SERVICE_API_KEY:-}` 为空，同时以 `NODE_ENV=production` 启动。
- Native order、订单查询、通知解析和发票管理端点共用这一 fail-open middleware。

**Impact**

同一容器网络中的任意调用方可访问支付和发票敏感能力；一旦网络或反向代理配置漂移，风险会扩大到公网。

**Expected Fix**

payment-service 生产启动必须要求强 service key，缺失时非零退出；比较使用 timing-safe 逻辑；只有 `/health` 和明确的 readiness endpoint 可以不带 key。

### B010: Docker、文档与 CI 的可复现性和安全验收不一致

**Evidence**

- 根 `Dockerfile` 有 lockfile 却执行 `npm install`，不能保证与 CI 的 `npm ci` 使用同一依赖图。
- KTX/FBX 工具下载失败会被 `|| echo` 吞掉，同一镜像定义可产出不同格式能力；多个下载缺少完整性校验，Python 包也未固定版本。
- README 首选命令是 `docker compose up -d`，但默认 Compose 没有 Worker；同时服务使用 production mode，README 却声明默认可访问生产中关闭的 `/api-docs`。
- `docker-compose.cloud.yml` 直接加载示例 env；CI 没有验证 Compose 渲染、生产负向配置或 callback/payment 安全边界。

**Impact**

开发、CI 和部署产物可能依赖不同版本、暴露不同端点或拥有不同转换能力；README 的“启动成功”不能证明异步闭环和安全配置可用。

**Current Scope**

本轮只处理安全相关子集：使用 lockfile 安装、让必需工具缺失显式失败、纠正默认/完整栈文档、增加生产配置与 Compose 的 CI 静态验收。外部二进制 checksum、Python 完整锁定和基础镜像 digest 固定作为后续供应链加固任务。

## Non-Bug Follow-ups

- Batch backend、更多 Task Type、完整发票管理和端到端云环境测试仍是产品/平台能力，不在本 Bug spec 中冒充缺陷修复。
- 普通 `docker-compose.yml` 可以继续作为轻量 UI/API 栈，但文档必须清楚说明它不提供异步 Worker 闭环。
- 本 spec 不重新定义 GLB 优化算法、压缩参数或格式兼容性。
