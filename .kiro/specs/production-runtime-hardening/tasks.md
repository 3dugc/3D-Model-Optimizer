# Implementation Tasks: Production Runtime Hardening

## Tasks

- [x] 1. 建立生产运行时 Bug spec
  - [x] 1.1 新增已验证 Bug 清单 `bugs.md`
  - [x] 1.2 新增 `requirements.md`
  - [x] 1.3 新增 `design.md`
  - [x] 1.4 新增可追踪的 `tasks.md`
  - [x] 1.5 明确当前安全修复与 deferred outbox 边界
  - _Requirements: 1.1-1.8, 9.1-9.6_

- [ ] 2. 为已确认 Bug 增加失败回归测试
  - [x] 2.1 复现 malformed `API_KEYS` 关闭鉴权（B001）
  - [x] 2.2 复现 wildcard scope 越过 tenant/task boundary（B002）
  - [x] 2.3 复现 production dev secret、query token 和 local state fallback（B003）
  - [ ] 2.4 使用永不结束的 fake executor 复现 Worker timeout 不生效（B004）
  - [x] 2.5 复现 callback loopback/private target 和 redirect（B005）
  - [ ] 2.6 复现 callback 失败后无持久重试（B006）
  - [x] 2.7 复现 Job API 回显 `callbackSigningSecret`（B007）
  - [x] 2.8 复现 payment-service 无 key 匿名访问（B009）
  - _Requirements: 1.1-1.8, 2.1-2.7, 3.1-3.7, 4.1-4.7, 5.1-5.7, 6.1-6.9, 7.1-7.6_

- [ ] 3. 实现统一生产启动门禁
  - [x] 3.1 将配置结果拆分为 errors 和 warnings
  - [x] 3.2 增加 role-aware `assertRuntimeConfig`
  - [x] 3.3 在 API listen 前执行校验
  - [x] 3.4 在 Worker、Dispatcher、Monitor 工作循环前执行校验
  - [x] 3.5 严格验证 production Web secret 和 query token 策略
  - [ ] 3.6 严格验证 Tencent/shared-state 和未知 enum 配置
  - [ ] 3.7 确保错误日志不包含 secret 或完整数据库凭据
  - _Requirements: 1.1-1.8, 3.1-3.2_

- [x] 4. 收紧 API key schema 和授权交集
  - [x] 4.1 为 `API_KEYS` 实现严格 schema parser
  - [x] 4.2 严格处理空 scope、未知字段、错误数组成员和重复 key
  - [x] 4.3 让 wildcard 只作用于 endpoint scope
  - [x] 4.4 独立执行 tenant constraint
  - [x] 4.5 独立执行 task type constraint
  - [x] 4.6 保留显式 Legacy_API_Key 兼容行为
  - [x] 4.7 保持 timing-safe key 比较并覆盖不同长度 key
  - _Requirements: 1.2-1.3, 2.1-2.7_

- [ ] 5. 建立 Public Job DTO 和 callback secret reference
  - [x] 5.1 新增 allowlist Public Job serializer
  - [x] 5.2 替换 cloud create/get/cancel/complete API 的内部 Job 序列化
  - [x] 5.3 替换 Web account Job API 的内部 Job 序列化
  - [x] 5.4 生产 API 和 COS manifest 拒绝 inline `callbackSigningSecret`
  - [x] 5.5 新增服务端 callback secret resolver 并只持久化 `callbackSecretId`
  - [ ] 5.6 审计日志和错误详情中的 callback/token secret
  - [x] 5.7 将 production query token 默认关闭并验证 header 路径
  - _Requirements: 3.1-3.7, 6.9_

- [ ] 6. 实现 Worker 硬 deadline
  - [ ] 6.1 抽象可注入 `JobExecutor`
  - [ ] 6.2 增加单次 attempt 的隔离执行入口
  - [x] 6.3 从领取后的处理入口启动 `jobTimeoutMs` deadline
  - [ ] 6.4 将 AbortSignal 传递到下载、上传和外部进程 helper
  - [ ] 6.5 超时先 TERM、宽限期后 KILL 非协作子进程
  - [x] 6.6 用 `JOB_TIMEOUT` 进入既有 retry/final failure 状态机
  - [ ] 6.7 保证 timeout 后停止续租、清理 scratch 且不晚到提交
  - [ ] 6.8 验证最终 timeout 会释放钱包冻结并安排失败 callback
  - _Requirements: 4.1-4.7_

- [x] 7. 实现 callback SSRF 防护
  - [x] 7.1 新增 URL 语法、协议、凭据、端口校验
  - [x] 7.2 增加完整 IPv4/IPv6 非公网地址分类
  - [x] 7.3 创建 Job 和解析 manifest 时执行 target policy
  - [x] 7.4 每次投递前重新解析 DNS 并验证地址
  - [x] 7.5 将实际连接固定到已批准地址并保留正确 TLS servername
  - [x] 7.6 禁止自动跟随重定向
  - [x] 7.7 增加仅非生产可用的 loopback 显式开关
  - _Requirements: 5.1-5.7_

- [ ] 8. 实现持久化 callback delivery
  - [ ] 8.1 实现 Local/MySQL/Postgres `CallbackDeliveryStore`
  - [ ] 8.2 增加 `(jobId, eventType)` 幂等约束和 claim lease
  - [ ] 8.3 统一 succeeded/failed/cancelled 的 delivery 创建入口
  - [ ] 8.4 实现 2xx、retryable 和 permanent failure 分类
  - [ ] 8.5 接入 `CALLBACK_MAX_ATTEMPTS` 和有界退避
  - [ ] 8.6 启动时恢复 pending/retry_wait delivery
  - [ ] 8.7 增加受 scope 保护的查询和人工 replay API
  - [ ] 8.8 验证签名使用实际发送的原始 JSON bytes
  - _Requirements: 6.1-6.9_

- [x] 9. 收紧 payment-service 生产鉴权
  - [x] 9.1 增加 payment-service role startup validator
  - [x] 9.2 生产缺失/占位 service key 时非零退出
  - [x] 9.3 将 service key 比较改为 timing-safe
  - [x] 9.4 确认所有支付和发票业务端点使用鉴权 middleware
  - [x] 9.5 主 API 校验 `PAYMENT_SERVICE_URL` 与 key 成对配置
  - [x] 9.6 确认 health/readiness 不泄漏商户或密钥信息
  - _Requirements: 1.1, 1.7, 7.1-7.6_

- [ ] 10. 修复 Docker、文档和 CI 的安全可复现子集
  - [x] 10.1 根 Dockerfile 改用 `npm ci`
  - [x] 10.2 必需转换工具安装/验证失败时让镜像构建失败
  - [x] 10.3 README 区分轻量 Compose 与完整异步 cloud Compose
  - [x] 10.4 修正 production API docs 的默认可用性描述
  - [x] 10.5 文档禁止直接把示例 env 当作 production credentials
  - [x] 10.6 CI 增加生产配置负向测试
  - [x] 10.7 CI 增加 default/cloud `docker compose config` 验证
  - [ ] 10.8 更新部署 preflight checklist
  - _Requirements: 8.1-8.8_

- [ ] 11. 完成当前里程碑验证
  - [x] 11.1 主项目 `npm run build` 通过
  - [x] 11.2 主项目 `npm run lint` 通过
  - [ ] 11.3 主项目 `npm test` 通过，包括 MySQL integration gate
  - [x] 11.4 payment-service build/test 通过
  - [x] 11.5 malformed production fixtures 均在监听前失败
  - [ ] 11.6 callback SSRF、redirect、retry/restart 集成测试通过
  - [ ] 11.7 Worker hard-timeout 集成测试通过且无残留子进程/scratch
  - [x] 11.8 记录仍 deferred 的 B008 和供应链工作，不误标完成
  - _Requirements: 1.1-8.8_

## Deferred Architecture Tasks

- [ ] 12. 使用 transactional outbox 解决 DB/CMQ 双写（后续里程碑，不在本轮实施）
  - [ ] 12.1 新增 durable Delivery_Outbox 数据模型和 migration
  - [ ] 12.2 在 Job queued/retry transition 同一事务写 enqueue intent
  - [ ] 12.3 实现带 claim lease 的 outbox publisher
  - [ ] 12.4 保证 publish 后 DB 更新失败导致的重复消息可安全去重
  - [ ] 12.5 幂等 create 命中旧 Job 时修复缺失 enqueue intent
  - [ ] 12.6 增加 pending/retrying/stuck 指标和审计修复命令
  - [ ] 12.7 增加 DB commit、CMQ publish 和进程崩溃窗口集成测试
  - _Requirements: 9.1-9.6_

- [ ] 13. 完整供应链可复现加固（后续里程碑）
  - [ ] 13.1 固定基础镜像 digest
  - [ ] 13.2 校验外部二进制 SHA-256
  - [ ] 13.3 锁定 Python 依赖版本和 hash
  - [ ] 13.4 生成 SBOM 并签名发布镜像
  - _Requirements: 8.1-8.8_

## Notes

- 2026-07-11 已完成 API 鉴权、生产启动门禁、Public Job DTO、服务端 callback secret reference、callback SSRF 防护、有界进程内重试、payment-service 鉴权和 Docker/CI 安全子集。
- B004 已加入协作式 deadline、AbortSignal 传播和外部子进程终止；真正可强杀任意非协作 CPU handler 的隔离执行仍未完成，因此 Task 6 保持未完成。
- B006 当前只完成单进程内有界重试；持久化 delivery、重启恢复、查询和 replay 仍由 Task 8 跟踪，因此不得标记为完整解决。
- B008 不得通过进程内 boolean、仅日志重试或调整 `publish()` 调用顺序宣称解决；这些方案都保留崩溃窗口。
- 所有实施应保留当前工作树中的用户修改，按小批次运行相关测试后再进入下一任务。
