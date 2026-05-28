# 重后端任务平台后续任务清单

本文档记录模型优化服务上线后的剩余工作。勾选规则：任务真正落地、经过验证并写入相关文档后，才改为 `[x]`。

## P0 立即处理

- [x] 释放 Worker 基准机 `ins-big9dirk`。
  - 前置确认：`img-om8cggg4` 可用，`asg-pj6qaput` 可冷启动 Worker，强杀恢复演练已通过。
  - 结果：2026-05-28 在 CVM 控制台释放成功，实例列表已不再显示 `ins-big9dirk`。
- [x] 将永久 CAM Secret 迁移到角色、STS、密钥管理或用户数据注入。
  - 约束：不要创建新的 `modeloptimizer` API key。
  - 约束：密钥不得写入仓库、镜像或可复用文档。
  - [x] 代码已支持 CVM/AS 实例角色 metadata STS 临时凭证，兼容现有永久密钥兜底。
  - [x] GitHub Actions 已验证并推送支持角色凭证的 `latest` 镜像。
  - [x] 创建或复用运行时 CAM 角色，绑定 COS/CMQ runtime 权限和 Dispatcher AS 最小权限。
  - [x] 将入口 CVM 绑定运行时 CAM 角色。
  - [x] 更新 Worker AS 启动配置或实例模板，让弹性 Worker 绑定运行时 CAM 角色。
  - [x] 从 Portainer Stack 移除永久 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_TOKEN`。
  - [x] 跑一次真实任务验证全链路使用实例角色临时凭证。
  - [x] 验证通过后停用旧永久密钥。
    - 结果：2026-05-28 已在 CAM 用户 `modeloptimizer` 的 API 密钥页停用旧密钥；未创建新的 `modeloptimizer` API key。
- [x] 创建 CLS 日志主题。
  - 结果：`model-optimizer` / `model-optimizer-runtime`，南京 `ap-nanjing`，30 天标准存储。
- [x] 领取 CLS 新手免费资源包。
  - 结果：`CLS预付费包` `10U` `3个月`，订单实付 `0.00`，交易成功。
- [x] 配置基础监控告警。
  - [x] 盘点现有基础告警：TDSQL-C 已有系统通知模板；CVM 基础监控策略存在但缺通知模板。
  - [x] 为 CVM 基础监控策略 `policy-u79zubvx` 绑定通知模板。
  - [x] 为 `model-optimizer-1251022382` 创建 COS 上传/下载错误或流量异常告警。
    - 结果：Cloud Monitor 策略 `model-optimizer-cos-errors-traffic` / `policy-5cncpgxg`，已绑定系统通知模板。
  - [x] 为队列积压和 Worker heartbeat 配置业务指标告警。
    - 结果：新增 `optimizer-monitor` 进程，读取 CMQ 属性、TDSQL-C Job backlog 和 Worker heartbeat；创建并绑定 `model-optimizer-monitor-alarm-minimal`，只允许发送自定义告警消息。

## P1 外部系统接入

- [x] 实现 COS 临时密钥签发接口。
  - 限定只能上传到租户自己的 COS 前缀。
  - 限定有效期和操作权限。
- [x] 支持外部系统用临时密钥上传模型到 COS。
- [x] 支持 COS-only manifest 接入。
  - manifest 需要声明 `tenantId`、`taskType`、输入文件、回调地址和幂等键。
- [x] 实现 COS-only manifest 解析和校验。
- [x] 验证 COS 事件可触发入队。
- [x] 验证 `POST /api/v1/jobs/:jobId/complete-upload` 可触发入队。
- [x] 测试重复 COS 事件幂等处理。
- [x] 实现 API Key scope 校验。
- [x] 添加 OpenAPI 文档。
- [x] 添加异步任务 API 测试。
- [x] 验证未注册 `taskType` 会被拒绝。
- [x] 验证 `GET /api/v1/jobs/:jobId/result-url` 返回短期下载链接。
  - 备注：代码和本地自动化测试已完成；2026-05-28 域名接入时已恢复 Portainer Stack 的 `DATABASE_URL`，入口 API 已恢复 healthy。

## P1 站点域名接入

- [x] 确认 `3dugc.com` 已在腾讯云 DNSPod 管理。
- [x] 在腾讯云 DNSPod 为 `3dugc.com` 创建或修改解析，指向现有入口 `port.7dgame.com`。
  - 优先方案：`@` 记录使用 CNAME 指向 `port.7dgame.com`。
  - 如果根域 CNAME 受限，则改用腾讯云支持的等效方案，并在文档记录。
  - 结果：根域 `@` 使用 A 记录指向 `175.27.169.6`，与 `port.7dgame.com` 当前入口 IP 一致。
- [x] 评估是否同时接入 `www.3dugc.com`。
  - 结果：通配符 `*` A 记录指向 `175.27.169.6`，覆盖 `www.3dugc.com`。
- [x] 更新 Portainer / Traefik 入口规则，允许 `Host(3dugc.com)` 访问 `model-optimizer` 服务。
- [x] 为 `3dugc.com` 配置 HTTPS 证书签发或自动签发。
- [x] 验证 `https://3dugc.com/health` 返回健康状态。
- [x] 验证 `https://3dugc.com/api-docs` 或异步 API 可访问。
- [x] 将最终 DNS 记录、Traefik 规则和验证结果写入 runbook。
  - 结果：2026-05-28 已完成，入口 Stack 已恢复 `DATABASE_URL` 环境变量并强制重拉 `latest` 镜像到 revision `6c60ac5`。

## P1 微信支付

- [ ] 准备微信支付商户号。
- [ ] 准备微信支付 AppID。
- [ ] 准备微信支付商户私钥。
- [ ] 准备微信支付证书序列号。
- [ ] 准备微信支付 API v3 key。
- [ ] 定义 `PaymentProvider` 接口。
- [ ] 实现微信 Native 下单。
- [ ] 创建订单时返回微信 Native `code_url`。
- [ ] Web UI 将 `code_url` 渲染成扫码二维码。
- [ ] 实现微信支付回调验签。
- [ ] 实现微信支付回调解密。
- [ ] 微信支付回调验签失败时拒绝处理。
- [ ] 微信支付成功后订单幂等更新为 `paid`。
- [ ] 订单 `paid` 后关联 Job 自动进入 `queued`。
- [ ] 未支付订单不会触发处理。
- [ ] 过期订单不会触发处理。
- [ ] 取消订单不会触发处理。
- [ ] 实现订单关闭状态处理。
- [ ] 实现退款状态处理。
- [ ] 增加支付回调幂等测试。
- [ ] 完成微信支付沙箱或测试商户回调测试。

## P1 客户回调

- [ ] 准备客户回调密钥管理方式。
- [ ] 客户回调带 HMAC 签名，并可被客户系统验签。
- [ ] 实现客户回调指数退避重试。
- [ ] 实现回调查询接口。
- [ ] 实现回调手动重放接口。
- [ ] 测试客户回调失败重试。

## P1 弹性 Worker 和成本保护

- [ ] 从 `4C8G / WORKER_CONCURRENCY=1` 开始压测。
- [ ] 评估 `8C16G / WORKER_CONCURRENCY=2`。
- [ ] 配置缩容 drain 时间，让 Worker 缩容前停止领取新任务。
- [ ] 评估把 `BF1.LARGE8` Worker 池加入 Dispatcher fallback。
- [ ] 评估把 `BF1.MEDIUM4` Worker 池加入 Dispatcher fallback。
- [ ] 评估把 `BF1.MEDIUM2` Worker 池加入 Dispatcher fallback。
- [ ] 增加租户并发限制。
- [ ] 增加每日任务数限制。
- [ ] 增加总处理时长限制。
- [ ] 增加全局最大 slot 限制。
- [ ] 增加全局最大实例数限制。
- [ ] 增加任务超时取消。
- [ ] 增加成本告警指标。
- [ ] 支持按 `taskType` 配置不同限额。
- [ ] 支持按 `taskType` 配置不同价格。

## P1 可观测性

- [ ] 增加结构化日志字段。
- [ ] 暴露队列深度指标。
- [ ] 暴露 slot 使用率指标。
- [ ] 暴露任务失败率指标。
- [ ] 暴露平均处理时长指标。
- [ ] 配置队列可见消息数告警。
- [ ] 配置按 `taskType` 统计队列积压告警。
- [ ] 配置 Worker heartbeat 丢失告警。
- [ ] 配置 Job 失败率告警。
- [ ] 配置 Callback 失败率告警。
- [ ] 配置微信支付回调失败告警。
- [ ] 配置 COS 上传错误告警。
- [ ] 配置 COS 下载错误告警。
- [ ] 配置单日成本异常告警。
- [ ] 配置实例数异常告警。

## P2 代码和测试补强

- [ ] 从 `routes/optimize.ts` 抽取 ZIP 解压逻辑。
- [ ] 从 `routes/optimize.ts` 抽取主模型查找逻辑。
- [ ] 从 `routes/optimize.ts` 抽取格式转换逻辑。
- [ ] 抽取后的 Job Runner 继续复用 `model.optimize` task handler。
- [ ] 为 ZIP 输入增加回归测试。
- [ ] 为多格式转换增加回归测试。
- [ ] 实现 Batch submit backend。
- [ ] 做本地 fake queue + local storage 端到端测试。
- [ ] 做 COS 上传到队列集成测试。
- [ ] 做 Worker 并发 slot 压测。

## P2 平台扩展

- [ ] 建立新增 `taskType` 的接入模板。
- [ ] 为每类重后端任务定义输入 manifest schema。
- [ ] 为每类重后端任务定义资源规格建议。
- [ ] 为每类重后端任务定义价格和限额。
- [ ] 为每类重后端任务定义结果文件和报告格式。
- [ ] 更新重后端任务平台 runbook，让其他服务可以复用这套结构。
