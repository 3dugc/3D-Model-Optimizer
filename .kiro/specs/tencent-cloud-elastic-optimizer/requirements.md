# Requirements Document

## Introduction

本文档定义“腾讯云弹性重后端任务平台”的需求。目标是把现有同步优化服务改造成可被其他系统调用的异步服务：外部系统上传输入到腾讯云 COS，系统自动排队、按需拉起 Docker Worker 处理重后端任务、将结果写回 COS，并通过回调通知调用方。模型优化是第一个任务类型，后续应能扩展视频转码、文件转换、CAD 预览、AI 批处理等任务。平台还需要支持微信 Native 扫码支付，用于 Web 单次任务付费和后续 API 租户充值/扣费。

现有优化能力继续复用本项目中的转换和优化流水线，不在本 spec 中重新定义 GLB 优化算法本身。

## Glossary

- **Control_API**: 对外提供任务、支付、状态、上传授权和回调管理的 API 服务。
- **Tenant**: 调用本服务的外部系统或客户账号。
- **Job**: 一次重后端异步任务。
- **Task_Type**: Job 的业务类型，例如 `model.optimize`、`video.transcode`。
- **Task_Handler**: 某个 Task_Type 的校验、估价、资源选择、执行和报告解析逻辑。
- **Order**: 与 Job 或租户充值相关的支付订单。
- **COS_Input_Object**: 外部系统上传到 COS 的源模型文件。
- **COS_Output_Object**: Worker 优化完成后写入 COS 的结果文件。
- **Worker_Slot**: 一个可同时处理一个 Job 的执行槽位。
- **Elastic_Worker**: 运行 Docker Worker 镜像的临时 CVM/Batch 节点。
- **Queue_Message**: 投递到 TDMQ/CMQ 的待处理任务消息。
- **Callback_Delivery**: 向外部系统发送任务完成通知的一次投递记录。
- **Wechat_Native_Payment**: 微信支付 Native 扫码支付流程。

## Requirements

### Requirement 1: 外部系统 API 接入

**User Story:** 作为外部系统开发者，我希望通过 API 创建模型优化任务并获取上传授权，以便我的系统只负责把模型上传到 COS。

#### Acceptance Criteria

1. WHEN Tenant 调用 `POST /api/v1/jobs` 且鉴权通过 THEN THE Control_API SHALL 根据 `taskType` 创建 Job 并返回 `jobId`、COS 上传位置和临时上传凭证。
2. WHEN Tenant 提供 `callbackUrl` THEN THE Control_API SHALL 将回调地址和回调密钥引用保存到 Job。
3. WHEN Tenant 重复提交相同 `idempotencyKey` THEN THE Control_API SHALL 返回已有 Job 而不是创建重复任务。
4. WHEN API Key 无效、停用或超出 scope THEN THE Control_API SHALL 拒绝请求并返回 401 或 403。
5. THE Control_API SHALL 支持查询 Job 状态、结果下载 URL 和失败原因。

### Requirement 1A: 可扩展重后端任务类型

**User Story:** 作为平台开发者，我希望模型优化只是一个可插拔任务类型，以便以后扩展更多重后端任务。

#### Acceptance Criteria

1. THE System SHALL 保存并传递每个 Job 的 `taskType`。
2. THE System SHALL 提供 Task_Type registry，用于注册不同 Task_Handler。
3. WHEN `taskType` 未注册 THEN THE Control_API SHALL 拒绝创建 Job。
4. EACH Task_Handler SHALL 提供输入校验、成本估算、资源类型选择、Worker 执行入口和结果报告解析能力。
5. THE Queue_Message SHALL 包含 `taskType`，使 Worker 能选择正确 Task_Handler。
6. THE Billing_Service SHALL 支持按 Task_Type 配置不同计费策略。
7. THE Metrics SHALL 支持按 Task_Type 统计积压、处理时长、失败率和成本。

### Requirement 2: COS 直传和 COS-only 接入

**User Story:** 作为外部系统开发者，我希望将模型文件直接上传到 COS，上传后系统能自动开始处理。

#### Acceptance Criteria

1. THE Control_API SHALL 只签发限定 bucket、key 前缀、有效期和操作范围的 COS 临时密钥。
2. WHEN COS 上传事件到达 THEN THE COS_Event_Handler SHALL 校验对象 key、etag、大小、租户归属和 Job 状态。
3. WHEN COS 事件重复到达 THEN THE COS_Event_Handler SHALL 保证 Job 只入队一次。
4. WHEN 使用 COS-only 接入 THEN THE COS_Event_Handler SHALL 要求同目录存在 `job.json` manifest 并完成租户鉴权。
5. IF 模型文件或 manifest 缺失 THEN THE COS_Event_Handler SHALL 保持 Job 在等待上传或等待 manifest 状态。

### Requirement 3: 队列削峰和任务调度

**User Story:** 作为平台运营者，我希望任务进入队列并按可用算力处理，以便多人使用时不会阻塞 Web API。

#### Acceptance Criteria

1. WHEN Job 已上传且满足计费条件 THEN THE Control_API SHALL 将 Job 投递到任务队列。
2. THE Queue_Message SHALL 包含 `jobId` 和 `taskType`，不直接包含大文件内容。
3. THE Dispatcher SHALL 根据队列积压、可用 Worker_Slot 和租户并发限制决定是否拉起新算力。
4. WHEN Worker 成功完成 Job THEN THE Queue_Consumer SHALL ACK 对应消息。
5. IF Worker 崩溃、超时或 Spot 被回收 THEN THE Queue_Message SHALL 在可见性超时后重新投递。
6. THE System SHALL 支持死信队列或失败状态，用于超过最大重试次数的 Job。

### Requirement 4: Docker Worker 和单机并发

**User Story:** 作为平台运营者，我希望每台弹性服务器运行 Docker Worker，并能配置一台服务器同时处理几个优化任务。

#### Acceptance Criteria

1. THE Elastic_Worker SHALL 使用 Docker 镜像部署，镜像包含 Node 服务、模型转换工具和优化依赖。
2. THE Elastic_Worker SHALL 通过 `WORKER_CONCURRENCY` 或等效配置声明本机 Worker_Slot 数。
3. THE Elastic_Worker SHALL 默认每个 Worker_Slot 同时只处理一个 Job。
4. THE Elastic_Worker SHALL 定期上报 `slots_total`、`slots_busy`、`instance_id`、`last_heartbeat`。
5. WHEN Worker 被标记为 draining THEN THE Elastic_Worker SHALL 停止领取新任务，并尽量完成已领取任务。
6. THE Dispatcher SHALL 按缺失 Worker_Slot 数扩容，而不是只按机器数扩容。

### Requirement 5: 弹性计算和低成本实例

**User Story:** 作为平台运营者，我希望使用便宜的临时算力处理模型，任务多时自动增加服务器，处理完自动释放。

#### Acceptance Criteria

1. THE System SHALL 支持腾讯云 Batch 作业模式作为优先计算调度方式。
2. THE System SHALL 支持 TDMQ/CMQ + CVM Spot Worker 池作为备选计算方式。
3. WHEN 队列积压超过当前 Worker_Slot 容量 THEN THE Dispatcher SHALL 申请新的 Batch 作业或 Spot CVM。
4. WHEN 队列为空且 Worker 空闲超过配置时间 THEN THE Dispatcher SHALL 释放或缩容临时 Worker。
5. THE System SHALL 保留可配置的最大实例数、最大 Worker_Slot 数和租户级并发上限。
6. THE System SHALL 不依赖临时服务器本地磁盘保存长期状态或结果。

### Requirement 6: 任务执行和 COS 结果存储

**User Story:** 作为调用方，我希望模型处理完成后结果保存在 COS，并能通过短期 URL 下载。

#### Acceptance Criteria

1. WHEN Worker 领取 Job THEN THE Worker SHALL 从 COS 下载输入对象到本地临时目录。
2. WHEN 输入是 ZIP THEN THE Worker SHALL 安全解压并寻找主模型文件。
3. THE Worker SHALL 复用现有格式转换和优化流水线生成优化结果。
4. WHEN 处理成功 THEN THE Worker SHALL 上传优化后的 GLB、报告和必要日志摘要到 COS。
5. WHEN 处理失败 THEN THE Worker SHALL 记录结构化错误码、错误消息和可重试标记。
6. THE Control_API SHALL 为已成功 Job 生成短时下载 URL 或代理下载。

### Requirement 7: 客户回调

**User Story:** 作为外部系统开发者，我希望任务完成或失败后收到可信回调，以便自动更新我自己的业务状态。

#### Acceptance Criteria

1. WHEN Job 进入 succeeded 或 failed 终态 THEN THE Callback_Service SHALL 向 Job 的 `callbackUrl` 发送回调。
2. THE Callback_Service SHALL 在请求头中包含事件类型、Job ID、时间戳和 HMAC 签名。
3. WHEN 客户回调返回 2xx THEN THE Callback_Service SHALL 标记投递成功。
4. WHEN 客户回调失败或超时 THEN THE Callback_Service SHALL 按指数退避重试。
5. THE Control_API SHALL 提供查询和人工重放 Callback_Delivery 的能力。

### Requirement 8: 微信 Native 扫码支付

**User Story:** 作为 Web 用户，我希望扫码支付后再处理模型，以便平台按任务收费。

#### Acceptance Criteria

1. WHEN Web 用户创建付费 Job THEN THE Billing_Service SHALL 创建 Order 并调用微信 Native 下单接口获取 `code_url`。
2. THE Web_UI SHALL 使用 `code_url` 生成二维码供微信扫码支付。
3. WHEN 微信支付回调到达 THEN THE Billing_Service SHALL 验签、解密并幂等更新 Order。
4. WHEN Order 支付成功 THEN THE Billing_Service SHALL 允许关联 Job 入队。
5. WHEN Order 过期、关闭或退款 THEN THE Billing_Service SHALL 阻止未授权 Job 继续处理。
6. THE Billing_Service SHALL 支持后续 API 租户余额或套餐模式，不要求每个 API Job 都人工扫码。

### Requirement 9: 安全、限额和幂等

**User Story:** 作为平台运营者，我希望控制成本和安全风险，避免恶意上传、重复处理或无限扩容。

#### Acceptance Criteria

1. THE System SHALL 对租户配置单文件大小、每日任务数、并发数和最大处理时长。
2. THE Worker SHALL 限制 ZIP 文件数量、解压后总大小和路径穿越。
3. THE System SHALL 对所有外部 API、COS 事件、支付回调和客户回调做幂等处理。
4. THE System SHALL 记录完整 Job 事件流，便于审计。
5. THE System SHALL 不在日志中输出永久密钥、临时密钥、微信支付私钥或回调密钥。

### Requirement 10: 可观测性和部署

**User Story:** 作为平台运维者，我希望清楚看到队列、Worker、任务和成本状态，以便部署后能排查问题和控制费用。

#### Acceptance Criteria

1. THE System SHALL 输出结构化日志，包含 `jobId`、`tenantId`、`workerId` 和阶段信息。
2. THE System SHALL 暴露任务状态、队列积压、Worker_Slot 使用率、失败率和回调失败率指标。
3. THE System SHALL 提供部署清单，列出必须配置的 COS、队列、数据库、微信支付和 Worker 环境变量。
4. THE System SHALL 支持本地开发模式，不依赖真实腾讯云资源即可运行核心优化测试。
5. THE System SHALL 保留现有同步 API 作为本地开发和兼容模式，直到新异步 API 稳定替代。
