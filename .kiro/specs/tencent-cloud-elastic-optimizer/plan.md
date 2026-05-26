# Spec Plan: Tencent Cloud Elastic Optimizer

## Goal

把当前模型优化服务演进成可商用的异步重后端任务平台：

- 外部系统只需要创建任务、上传 COS、等待回调。
- Web 用户可以微信扫码付费后提交任务。
- 多人同时使用时，由队列和弹性 Worker 消化任务，不阻塞 API。
- 每台弹性服务器通过 Docker 部署 Worker，并按 slot 配置单机并发。
- 模型优化是第一个 `taskType`，后续可扩展其他重后端任务。

## Non-goals

- 不在本阶段重写优化算法。
- 不在没有腾讯云账号和微信商户配置的情况下强行接入真实云资源。
- 不移除现有 `/api/optimize` 同步接口，先保持兼容。

## Delivery Phases

### Phase 0: Spec and Structure

输出架构文档、spec、任务清单和源码边界目录。此阶段不改变现有运行路径。

### Phase 1: Core Job Model

引入 Job、Order、Worker、Callback 和 Task_Type 的类型和状态机，实现数据库 repository 接口，保留内存实现用于本地开发。

### Phase 2: API and COS Upload

实现 `POST /api/v1/jobs`、任务查询、COS 临时密钥签发、手动上传完成确认。真实 COS provider 和 local provider 使用同一接口。

### Phase 3: Worker Extraction

把 `routes/optimize.ts` 中解压、转换、优化逻辑抽成 `model.optimize` task handler。新增 Docker Worker CLI，支持从本地路径或 COS 拉取输入。

### Phase 4: Queue and Elastic Dispatch

引入队列抽象，支持本地 fake queue 和 TDMQ/CMQ provider。实现 Dispatcher slot 计算和 Worker 心跳。

### Phase 5: Tencent Cloud Runtime

接入 COS、TDMQ/CMQ、Batch 或 Spot CVM。提供部署环境变量模板和最小部署清单。

### Phase 6: Wechat Payment

接入微信 Native 下单、二维码展示、支付回调验签解密、订单幂等更新。支付成功后 Job 才入队。

### Phase 7: Callback and Operations

实现客户回调签名、重试、查询、重放。补齐监控指标、告警和成本保护。

## Rollout Strategy

1. 本地保留现有同步 API。
2. 新增 `/api/v1/jobs` 异步 API，先用 local queue/local storage 验证。
3. 在测试环境接入 COS 和队列，Worker 仍固定 1 台。
4. 开启 slot 并发，压测不同 CVM 规格。
5. 接入 Batch/Spot 弹性扩容。
6. 接入微信支付。
7. 给外部系统开放 API Key 和回调。

## Initial Defaults

```text
WORKER_CONCURRENCY=1
JOB_MAX_ATTEMPTS=3
JOB_TIMEOUT_SECONDS=1800
DEFAULT_TASK_TYPE=model.optimize
CALLBACK_TIMEOUT_SECONDS=10
CALLBACK_MAX_ATTEMPTS=6
COS_UPLOAD_CREDENTIAL_TTL_SECONDS=1800
MAX_SLOTS_PER_TENANT=2
MAX_GLOBAL_SLOTS=20
```

## Tencent Cloud Resources

```text
COS_BUCKET=model-optimizer-1251022382
TENCENT_REGION=ap-nanjing
QUEUE_NAME=optimizer-jobs
DLQ_NAME=optimizer-jobs-dlq
QUEUE_PUBLIC_ENDPOINT=https://cmq-nj.public.tencenttdmq.com
QUEUE_PRIVATE_ENDPOINT=http://nj.mqadapter.cmq.tencentyun.com
```

## Slot Sizing Guidance

| CVM Spec | Default Slots | Notes |
|---|---:|---|
| 2C4G | 1 | Small files only |
| 4C8G | 1 | Safe default |
| 8C16G | 2 | Recommended starting point |
| 16C32G | 4 | Queue burst capacity |
| 32C64G | 6-8 | Requires load testing |

## Acceptance Gates

- Existing tests still pass before cloud features are enabled.
- New async API can run locally without Tencent credentials.
- Worker can process a local Job using the current optimization pipeline.
- Worker chooses execution logic through `taskType`.
- COS provider is covered by integration smoke tests with real credentials only in deployment environment.
- Queue messages are idempotent under duplicate delivery.
- Wechat payment notification handler rejects invalid signatures.
- Callback delivery is signed and retryable.
