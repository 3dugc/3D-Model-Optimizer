# Requirements Document

## Introduction

本文档定义 3D Model Optimizer 的生产运行时加固需求。目标是修复已确认的 fail-open 鉴权、生产默认值、Worker 超时、客户回调、支付服务鉴权和构建验收问题，同时保持现有模型优化算法、Web 业务流程和腾讯云拓扑不变。

本轮实现覆盖 `bugs.md` 中的 `B001-B007`、`B009` 和 `B010` 的安全子集。`B008` 的可靠消息投递需要 transactional outbox，作为后续架构里程碑；本轮不得用无法跨进程恢复的内存标记伪装成最终修复。

## Glossary

- **Production_Runtime**: `NODE_ENV=production` 下运行的 API、Worker、Dispatcher、Monitor 或 payment-service 进程。
- **Startup_Validator**: 在进程监听端口或开始工作循环前验证角色相关配置的组件。
- **Structured_API_Key**: 由 `API_KEYS` JSON 配置的、带 scope、tenant 和 task type 边界的 API key。
- **Legacy_API_Key**: 由单个 `API_KEY` 配置的兼容 key。
- **Public_Job_View**: 可返回给外部 API 或 Web 用户的 Job allowlist DTO。
- **Execution_Deadline**: 从 Worker claim Job 开始计算的最大实际执行时长。
- **Callback_Target_Policy**: 对 webhook URL、DNS 结果、连接地址、端口和重定向实施的 SSRF 防护规则。
- **Callback_Delivery**: 一次终态 Job webhook 的持久化投递记录。
- **Callback_Secret_Resolver**: 根据 `callbackSecretId` 获取签名密钥且不向 Job/API 暴露原文的服务端组件。
- **Delivery_Outbox**: 将数据库状态变化与待发布消息意图原子保存的事务型发件箱。

## Requirements

### Requirement 1: 生产启动配置必须 fail closed

**User Story:** 作为平台运维者，我希望错误或不安全的生产配置在接收流量前被拒绝，以便部署变量错误不会静默扩大权限或切换到本地状态。

#### Acceptance Criteria

1. WHEN any Production_Runtime starts THEN THE Startup_Validator SHALL run before `listen()` or the first Worker/Dispatcher/Monitor loop.
2. WHEN `API_KEYS` is present but is invalid JSON, not an array, or contains any invalid definition THEN THE Control_API SHALL exit non-zero and SHALL NOT disable authentication.
3. WHEN the production Control_API exposes external `/api/v1` routes without a valid Legacy_API_Key or Structured_API_Key THEN THE Startup_Validator SHALL reject startup with a sanitized configuration error.
4. WHEN production Web authentication is enabled THEN THE Startup_Validator SHALL require an explicit strong `WEB_AUTH_SECRET` and SHALL reject `dev-web-auth-secret` or reuse of a public/default credential.
5. WHEN a production cloud role uses Tencent queue/compute topology THEN THE Startup_Validator SHALL reject `STATE_STORE_PROVIDER=local` and SHALL require the role's database and queue dependencies.
6. WHEN a production enum configuration contains an unknown value THEN THE Startup_Validator SHALL reject it rather than silently select `local`, `mock`, or another fallback.
7. THE Startup_Validator SHALL report invalid environment variable names and reasons without logging secret values.
8. THE System SHALL preserve permissive local-development defaults only when `NODE_ENV` is not `production`.

### Requirement 2: API key schema and authorization boundaries

**User Story:** 作为外部 API 租户管理员，我希望 endpoint scope、tenant 和 task type 限制都被执行，以便一个合法 key 不能越过其业务边界。

#### Acceptance Criteria

1. THE Structured_API_Key schema SHALL validate every supported field type, non-empty string, array member, duplicate and unknown field.
2. WHEN a Structured_API_Key omits `scopes` THEN THE parser SHALL reject the definition or apply an explicitly documented least-privilege default; it SHALL NOT silently grant `*`.
3. WHEN a principal has endpoint scope `*` and also has `tenantIds` THEN THE authorization layer SHALL still deny every tenant not listed in `tenantIds`.
4. WHEN a principal has endpoint scope `*` and also has `taskTypes` THEN THE authorization layer SHALL still deny every task type not listed in `taskTypes`.
5. WHEN a key lacks the requested endpoint scope THEN THE API SHALL return 403 even if tenant and task constraints match.
6. THE Legacy_API_Key SHALL remain compatible as an explicit unrestricted principal, and its behavior SHALL be distinguishable from a malformed Structured_API_Key.
7. THE System SHALL compare presented API keys without data-dependent string comparison after candidate lengths match.

### Requirement 3: Token transport and secret redaction

**User Story:** 作为安全负责人，我希望 bearer token 和 callback secret 不进入 URL 或普通 Job 响应，以便代理、浏览器和下游日志不会保存长期凭据。

#### Acceptance Criteria

1. THE production default for `ALLOW_QUERY_AUTH_TOKENS` SHALL be `false`.
2. WHEN query auth tokens are disabled THEN THE API SHALL ignore or reject `api_key` and `web_token` query parameters and SHALL accept credentials only through approved headers or the dedicated login exchange.
3. EVERY external Job response SHALL use Public_Job_View rather than serializing the internal `CloudJob` object.
4. THE Public_Job_View SHALL NOT contain `callbackSigningSecret`, resolved callback secrets, payment service keys, temporary cloud credentials or other credential material.
5. WHEN a production caller or COS manifest submits an inline `callbackSigningSecret` THEN THE API SHALL reject the request with a stable validation error.
6. WHEN a caller supplies `callbackSecretId` THEN THE System SHALL store only that reference on the Job and SHALL resolve the signing secret server-side at delivery time.
7. THE System SHALL NOT log raw bearer tokens, API keys, callback signing secrets or rejected secret values.

### Requirement 4: Worker hard execution deadline

**User Story:** 作为平台运营者，我希望每个 Worker Job 在配置的最大时长内结束，以便损坏输入或挂死工具不会永久占用 slot、租约和余额。

#### Acceptance Criteria

1. WHEN a Worker claims a Job THEN THE Worker SHALL start the Execution_Deadline using `jobTimeoutMs` from runtime configuration.
2. WHEN download, task execution, result upload or report upload exceeds the Execution_Deadline THEN THE Worker SHALL terminate the active execution and record error code `JOB_TIMEOUT`.
3. WHEN a Job times out and attempts remain THEN THE Worker SHALL stop lease renewal, clean scratch data and move the Job through the existing retry path exactly once.
4. WHEN a Job times out on its final attempt THEN THE Worker SHALL mark it failed, release any held wallet charge and schedule its failed callback delivery.
5. THE Worker SHALL propagate cancellation to external child processes and SHALL force-kill non-cooperative execution after a bounded grace period.
6. A timed-out execution SHALL NOT later upload an authoritative result, settle a charge, ACK another attempt's message or change a terminal Job.
7. WHEN the configured timeout is invalid THEN THE Startup_Validator SHALL reject production startup instead of replacing it with an unrelated default.

### Requirement 5: Callback target SSRF protection

**User Story:** 作为平台安全负责人，我希望客户 callback 只能连接到经过验证的公网 HTTPS 目标，以便 Worker 不能被当作内网请求代理。

#### Acceptance Criteria

1. WHEN a callback URL is submitted through API or manifest THEN THE Callback_Target_Policy SHALL require a valid absolute HTTPS URL in production.
2. THE Callback_Target_Policy SHALL reject URL credentials, fragments, disallowed ports, loopback, private, link-local, multicast, unspecified and cloud metadata addresses for IPv4 and IPv6.
3. WHEN a hostname resolves THEN THE Callback_Target_Policy SHALL reject the target if any selected connection address is non-public.
4. BEFORE every delivery attempt THE Callback_Target_Policy SHALL resolve and validate the target again and SHALL bind the outbound connection to an approved address.
5. THE callback HTTP client SHALL NOT automatically follow redirects.
6. WHEN a callback responds with any redirect THEN THE delivery SHALL fail with a sanitized target-policy error and SHALL NOT contact the redirect destination.
7. THE local development runtime MAY allow an explicit loopback callback opt-in, but the opt-in SHALL be rejected in production.

### Requirement 6: Durable callback delivery and retry

**User Story:** 作为外部系统开发者，我希望成功、失败或取消通知可重试、可查询、可恢复，以便短暂故障不会永久丢失任务结果。

#### Acceptance Criteria

1. WHEN a Job first enters `succeeded`, `failed` or `cancelled` THEN THE System SHALL idempotently create one Callback_Delivery for that Job and event type when a callback URL exists.
2. THE Callback_Delivery SHALL persist status, attempts, last status/error summary, next retry time and timestamps in the configured shared state store.
3. WHEN a callback returns 2xx THEN THE delivery service SHALL mark the record `delivered` and SHALL NOT retry it automatically.
4. WHEN a callback has a retryable network error, timeout, 408, 429 or 5xx response THEN THE delivery service SHALL schedule bounded exponential backoff.
5. WHEN attempts reach `CALLBACK_MAX_ATTEMPTS` THEN THE delivery service SHALL mark the record `failed` and SHALL stop automatic retries.
6. WHEN the process restarts THEN THE delivery service SHALL resume due `pending` and `retry_wait` deliveries from durable state.
7. WHEN duplicate terminal processing occurs THEN THE System SHALL NOT create duplicate logical callback deliveries.
8. THE Control_API SHALL expose protected delivery inspection and manual replay capability, and manual replay SHALL create an auditable new attempt without weakening target validation.
9. THE callback signature SHALL cover the exact transmitted body and timestamp using a secret obtained from Callback_Secret_Resolver.

### Requirement 7: payment-service production authentication

**User Story:** 作为支付系统负责人，我希望 payment-service 的内部业务端点在生产环境始终需要 service key，以便容器网络或代理配置错误不会暴露支付能力。

#### Acceptance Criteria

1. WHEN payment-service starts in production without `PAYMENT_SERVICE_API_KEY` THEN THE process SHALL exit non-zero before listening.
2. WHEN `PAYMENT_SERVICE_API_KEY` is weak, blank or equal to a documented placeholder THEN THE Startup_Validator SHALL reject production startup.
3. EVERY payment and invoice business endpoint SHALL require `x-payment-service-key` and SHALL return 401 for missing or invalid credentials.
4. THE payment-service SHALL compare service keys using a timing-safe comparison after checking byte length.
5. ONLY liveness/readiness endpoints MAY remain unauthenticated, and those endpoints SHALL NOT return credentials or merchant secrets.
6. THE main Control_API SHALL require the same configured payment service key when `PAYMENT_SERVICE_URL` is enabled in production.

### Requirement 8: Reproducible security build and deployment guidance

**User Story:** 作为发布工程师，我希望 Docker、README 和 CI 对同一依赖图、运行拓扑和安全门禁达成一致，以便一次通过验收的构建能够被重复部署。

#### Acceptance Criteria

1. THE main Docker build SHALL install Node dependencies from the committed lockfile with `npm ci`.
2. WHEN a conversion tool declared as available in the produced image cannot be installed or verified THEN THE Docker build SHALL fail instead of silently publishing a reduced-capability image.
3. THE README SHALL distinguish the lightweight API/UI Compose stack from the complete async cloud Compose stack and SHALL provide the exact Worker-capable command.
4. THE README SHALL NOT claim production-disabled API documentation is available by default.
5. THE cloud Compose workflow SHALL require an operator-created environment file or explicit variables and SHALL NOT present placeholder credentials as a production-ready configuration.
6. THE CI SHALL run production configuration negative tests for malformed API keys, insecure Web secret, local cloud state and missing payment service key.
7. THE CI SHALL validate both Compose files render successfully and SHALL run main and payment-service build/test gates.
8. THE deployment documentation SHALL include a preflight checklist for auth enabled, shared state, query token disabled, callback policy enabled and payment service authentication.

## Deferred Architecture Requirement

### Requirement 9: Transactional queue delivery outbox

**Status:** Deferred to the next architecture milestone (`B008`); it is documented here so current fixes do not create an incompatible local workaround.

#### Acceptance Criteria

1. WHEN a Job becomes ready to queue or retry THEN THE database transaction SHALL persist the Job state and one Delivery_Outbox intent atomically.
2. THE outbox publisher SHALL deliver intents at least once and SHALL persist publish attempts and completion state.
3. WHEN publish succeeds but marking the intent fails THEN duplicate publication SHALL be safe because Job claim remains idempotent.
4. WHEN publish fails or a process restarts THEN due outbox intents SHALL remain discoverable and retryable.
5. THE System SHALL expose pending, retrying and stuck outbox metrics plus an audited repair operation.
6. Repeating a create request with the same tenant/idempotency key SHALL return the same Job and SHALL ensure its required enqueue intent exists.
