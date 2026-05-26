# 腾讯云部署清单

本文档是弹性优化服务上线前的部署检查表。详细设计见 `docs/tencent-cloud-architecture.md` 和 `.kiro/specs/tencent-cloud-elastic-optimizer`。

## 1. 基础资源

- [ ] 创建 COS input bucket。
- [ ] 创建 COS output bucket，或确认与 input bucket 共用时有清晰前缀隔离。
- [ ] 配置 COS CORS，允许 Web UI 或外部系统直传。
- [ ] 创建 TDMQ/CMQ 队列。
- [ ] 配置死信队列或失败消息保留策略。
- [ ] 创建数据库实例，用于 tenants、jobs、orders、workers、callbacks。
- [ ] 创建 CLS 日志主题和必要监控告警。

## 2. 权限与密钥

- [ ] 创建 Control API 子账号或角色。
- [ ] 授权 Control API 签发限定 COS 前缀的临时密钥。
- [ ] 授权 Worker 读取 input bucket、写入 output bucket。
- [ ] 授权 Dispatcher 提交 Batch 作业或扩缩 Spot CVM。
- [ ] 准备微信支付商户号、AppID、商户私钥、证书序列号、API v3 key。
- [ ] 准备客户回调密钥管理方式。
- [ ] 确认所有永久密钥只进入密钥管理或部署环境变量，不写入仓库。

## 3. Control API 环境变量

本仓库已提供 `.env.cloud.example`，部署时复制为真实环境变量并替换密钥。

```text
NODE_ENV=production
PORT=3000
API_BASE_URL=https://optimizer.example.com

DATABASE_URL=

TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_REGION=ap-guangzhou

COS_INPUT_BUCKET=
COS_OUTPUT_BUCKET=
COS_UPLOAD_CREDENTIAL_TTL_SECONDS=1800

QUEUE_PROVIDER=tdmq-cmq
QUEUE_ENDPOINT=
QUEUE_NAME=

WECHAT_PAY_APP_ID=
WECHAT_PAY_MCH_ID=
WECHAT_PAY_PRIVATE_KEY_PATH=
WECHAT_PAY_CERT_SERIAL_NO=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_NOTIFY_URL=https://optimizer.example.com/api/v1/payments/wechat/notify

MAX_GLOBAL_SLOTS=20
MAX_SLOTS_PER_TENANT=2
JOB_MAX_ATTEMPTS=3
JOB_TIMEOUT_SECONDS=1800
DEFAULT_TASK_TYPE=model.optimize
```

## 4. Worker 环境变量

```text
WORKER_ID=
WORKER_CONCURRENCY=1
WORKER_HEARTBEAT_INTERVAL_MS=10000
WORKER_JOB_TIMEOUT_MS=1800000

DATABASE_URL=

QUEUE_PROVIDER=tdmq-cmq
QUEUE_ENDPOINT=
QUEUE_NAME=

COS_INPUT_BUCKET=
COS_OUTPUT_BUCKET=
TENCENT_REGION=ap-guangzhou
TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=

CALLBACK_TIMEOUT_SECONDS=10
CALLBACK_MAX_ATTEMPTS=6
```

## 5. 弹性计算

- [ ] 构建并推送 Docker Worker 镜像。
- [ ] 本地联调用 `docker compose -f docker-compose.cloud.yml up --build` 验证 API + Worker。
- [ ] 选择 Batch 作业模式或 Spot CVM Worker 池模式。
- [ ] 从 `8C16G / WORKER_CONCURRENCY=2` 开始压测。
- [ ] 配置最大实例数，避免成本失控。
- [ ] 配置缩容 drain 时间，让 Worker 停止领取新任务。
- [ ] 验证 Spot 回收或强杀 Worker 后任务会重新投递。

## 6. API 验收

- [ ] `POST /api/v1/jobs` 创建 `model.optimize` 任务并返回上传授权。
- [ ] Job 记录包含 `taskType`，队列消息也包含 `taskType`。
- [ ] 未注册 task type 会被拒绝。
- [ ] 外部系统可用临时密钥上传模型到 COS。
- [ ] COS 事件或 `complete-upload` 可触发入队。
- [ ] Worker 可消费任务并写回 output bucket。
- [ ] `GET /api/v1/jobs/:jobId` 可查到 succeeded/failed。
- [ ] `GET /api/v1/jobs/:jobId/result-url` 返回短期下载 URL。
- [ ] 客户回调带 HMAC 签名且可被客户系统验签。

## 7. 支付验收

- [ ] 创建订单可返回微信 Native `code_url`。
- [ ] Web UI 可把 `code_url` 渲染成二维码。
- [ ] 微信支付回调验签失败时拒绝处理。
- [ ] 微信支付成功后订单幂等更新为 paid。
- [ ] 订单 paid 后关联 Job 自动进入 queued。
- [ ] 未支付、过期、取消订单不会触发处理。

## 8. 监控告警

- [ ] 队列可见消息数告警。
- [ ] 按 task type 统计队列积压、失败率和平均处理时长。
- [ ] Worker heartbeat 丢失告警。
- [ ] Job 失败率告警。
- [ ] Callback 失败率告警。
- [ ] 微信支付回调失败告警。
- [ ] COS 上传或下载错误告警。
- [ ] 单日成本或实例数异常告警。
