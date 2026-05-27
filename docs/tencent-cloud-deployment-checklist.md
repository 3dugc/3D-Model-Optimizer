# 腾讯云部署清单

本文档是弹性优化服务上线前的部署检查表。详细设计见 `docs/tencent-cloud-architecture.md`、`docs/heavy-task-platform-runbook.md` 和 `.kiro/specs/tencent-cloud-elastic-optimizer`。

## 1. 基础资源

- [x] 创建专用 COS bucket：`model-optimizer-1251022382`，南京 `ap-nanjing`，私有读写，单 AZ。
- [x] 确认 input/output 共用专用 bucket；当前实现使用 `tenants/{tenantId}/jobs/{jobId}/...` 前缀隔离输入、输出和报告。
- [x] 配置 COS CORS，允许 `https://*.7dgame.com`、`http://localhost:3000`、`http://localhost:5173` 直传；Methods：`PUT/GET/POST/HEAD`，Allow-Headers：`*`，Max-Age：`3600`。
- [x] 创建 TDMQ/CMQ 队列：`optimizer-jobs`，南京地域。
- [x] 配置死信队列：`optimizer-jobs-dlq`，并关联主队列。
- [x] 记录 CMQ API 地址：公网 `https://cmq-nj.public.tencenttdmq.com`；腾讯云内网 `http://nj.mqadapter.cmq.tencentyun.com`。
- [x] 复用 TDSQL-C MySQL 8.0 集群 `cynosdbmysql-o6c4ezij`，用于 tenants、jobs、orders、workers、callbacks。
- [x] 创建通用任务平台数据库：`async_task_platform`。
- [x] 创建运行时数据库账号：`async_task_runtime@%`，密码只配置在部署环境中，不写入仓库。
- [x] 确认云内网数据库地址：`10.206.0.5:3306`。
- [x] 代码支持 MySQL/Postgres 共享状态库，自动建表 `optimizer_jobs`、`optimizer_orders`、`optimizer_workers`、`optimizer_callback_deliveries`。
- [ ] 创建 CLS 日志主题和必要监控告警。

## 2. 权限与密钥

- [x] 创建运行时 CAM 子账号或角色，并绑定最小化 COS/CMQ 访问策略。
- [ ] 授权 Control API 签发限定 COS 前缀的临时密钥。
- [x] 授权运行时读取 input bucket、写入 output bucket。
- [x] 准备 Dispatcher AS 最小权限策略文件：`infra/tencent-cloud/cam/model-optimizer-dispatcher-as-policy.json`。
- [x] 在 CAM 绑定 Dispatcher AS 最小权限策略，并验证移除 `QcloudASFullAccess` 后仍可自动扩缩 Spot CVM：`jobId=5dd794c5-83eb-4870-8182-c365b5855cdb`，`workerId=worker-cvm-ins-m6q6mezk`。
- [x] 从运行时 CAM 子账号移除 `QcloudTATFullAccess`；TAT 排障权限只保留给人工运维账号或按需临时授权。
- [ ] 准备微信支付商户号、AppID、商户私钥、证书序列号、API v3 key。
- [ ] 准备客户回调密钥管理方式。
- [ ] 确认所有永久密钥只进入密钥管理或部署环境变量，不写入仓库。

## 3. 镜像仓库与 CI

- [x] GitHub Actions 构建 Docker 镜像。
- [x] Portainer 入口栈使用腾讯云镜像仓库镜像。
- [x] 在腾讯云镜像仓库创建 `plugins/3d-model-optimizer`。
- [x] 在 GitHub Secrets 配置 `TENCENT_REGISTRY_USERNAME`。
- [x] 在 GitHub Secrets 配置 `TENCENT_REGISTRY_PASSWORD`。
- [x] 确认 GitHub Actions 推送 `hkccr.ccs.tencentyun.com/plugins/3d-model-optimizer:latest` 成功；CI 不再生成短哈希镜像 tag，并会自动清理腾讯仓库中的 `sha-*` 旧 tag。
- [x] 已执行腾讯镜像仓库清理，删除 13 个历史 `sha-*` tag。
- [x] 确认 Portainer 能从腾讯云镜像仓库拉取入口镜像。
- [x] 入口 Stack 已切为 API-only，并部署 `hkccr.ccs.tencentyun.com/plugins/3d-model-optimizer:sha-121dbaf`，健康检查通过。
- [x] 入口 Stack 已热修到 `hkccr.ccs.tencentyun.com/plugins/3d-model-optimizer:sha-d465f02`，健康检查通过。
- [x] 入口 Stack 已切回滚动镜像 `hkccr.ccs.tencentyun.com/plugins/3d-model-optimizer:latest`，健康检查通过。
- [x] 入口域名 `https://optimizer.7dgame.com` 可访问。

默认入口镜像：

```text
hkccr.ccs.tencentyun.com/plugins/3d-model-optimizer:latest
```

## 4. Control API 环境变量

本仓库已提供 `.env.cloud.example`，部署时复制为真实环境变量并替换密钥。

```text
NODE_ENV=production
PORT=3000
API_BASE_URL=https://optimizer.example.com

DATABASE_URL=mysql://user:password@mysql-host:3306/optimizer
STATE_STORE_PROVIDER=mysql
DATABASE_SSL=false

TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_TOKEN=
TENCENT_REGION=ap-nanjing

COS_INPUT_BUCKET=model-optimizer-1251022382
COS_OUTPUT_BUCKET=model-optimizer-1251022382
COS_UPLOAD_CREDENTIAL_TTL_SECONDS=1800

QUEUE_PROVIDER=tdmq-cmq
QUEUE_ENDPOINT=https://cmq-nj.public.tencenttdmq.com
QUEUE_NAME=optimizer-jobs
QUEUE_POLLING_WAIT_SECONDS=10

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

## 5. Worker 环境变量

```text
WORKER_ID=
WORKER_CONCURRENCY=1
WORKER_HEARTBEAT_INTERVAL_MS=10000
WORKER_JOB_TIMEOUT_MS=1800000
JOB_LEASE_SECONDS=300
EXPIRED_JOB_RECOVERY_INTERVAL_SECONDS=30
WORKER_SPOT_TERMINATION_CHECK_URL=http://metadata.tencentyun.com/latest/meta-data/spot/termination-time
WORKER_SPOT_TERMINATION_POLL_MS=5000

DATABASE_URL=mysql://user:password@mysql-host:3306/optimizer
STATE_STORE_PROVIDER=mysql
DATABASE_SSL=false

QUEUE_PROVIDER=tdmq-cmq
QUEUE_ENDPOINT=http://nj.mqadapter.cmq.tencentyun.com
QUEUE_NAME=optimizer-jobs

COS_INPUT_BUCKET=model-optimizer-1251022382
COS_OUTPUT_BUCKET=model-optimizer-1251022382
TENCENT_REGION=ap-nanjing
TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_TOKEN=

CALLBACK_TIMEOUT_SECONDS=10
CALLBACK_MAX_ATTEMPTS=6
```

## 6. 弹性计算

- [x] 构建并推送 Docker Worker 镜像。
- [x] 本地联调用 `docker compose -f docker-compose.cloud.yml up --build` 验证 API + Worker。
- [x] 当前选择 TDMQ/CMQ + Spot CVM Worker 池模式，Batch 保留为后续调度后端。
- [x] 新建 Worker 基准机 `model-optimizer-worker-base` / `ins-big9dirk`，规格 `4C8G`，内网 `10.206.0.21`。
- [x] 基准机安装 Docker，并配置腾讯云镜像仓库拉取权限。
- [x] 基准机配置 systemd 服务 `model-optimizer-worker.service`。
- [x] 远程 Worker 真实 smoke test 成功：`jobId=9fbd477f-62e6-4044-9c2c-5f7cc6f97b79`，`workerId=worker-cvm-ins-big9dirk`。
- [x] 已手动停止入口服务器上的 `optimizer-worker` 容器，避免入口机处理重任务。
- [x] 从 Portainer 入口 Stack 中永久移除 `optimizer-worker` 服务，入口只保留 `optimizer-api`。
- [x] 基准机启动脚本改为按腾讯云 metadata 自动生成唯一 `WORKER_ID`。
- [x] 已发起从基准机创建自定义镜像：`model-optimizer-worker-base-20260527` / `img-rxjo5rca`。
- [x] 自定义镜像 `img-rxjo5rca` 状态已变为正常。
- [x] 已保存 CVM 竞价启动模板：`lt-model-optimizer-worker-spot`，使用自定义镜像 `img-rxjo5rca`，无公网 IP。
- [x] 已创建 AS 启动配置：`asc-model-optimizer-worker-spot` / `asc-lwvidj3l`。
- [x] 已创建 AS 伸缩组：`asg-model-optimizer-worker-spot` / `asg-pj6qaput`。
- [x] 已停止 Worker 基准机 `ins-big9dirk`，等待最终确认后释放。
- [x] 已用 AS 伸缩组从 `0` 扩到 `1` 跑通真实弹性 Worker smoke test：`jobId=c7d3a25c-bd9a-4df0-aa90-b573c684b09d`。
- [x] 已修复首版 Worker 镜像启动问题：shell 变量错误转义、无公网实例 `--pull always` 拉仓库超时。
- [x] 已创建修复后 Worker 镜像：`model-optimizer-worker-elastic-20260527-fix1` / `img-hmvlx5n2`。
- [x] 已创建并切换 AS 启动配置：`asc-model-optimizer-worker-spot-fix1` / `asc-rkmzzkyj`。
- [x] 已验证新镜像冷启动实例 `ins-fss90ts4` 自动启动 `model-optimizer-worker.service`。
- [x] 发现并修复 TDSQL-C MySQL 对 `LIMIT ?` 的兼容问题，提交 `d465f02`，CI 已推送 `sha-d465f02`。
- [x] 基准机已拉取 `sha-d465f02`，并创建新版 Worker 镜像：`model-optimizer-worker-elastic-20260527-fix2` / `img-d9cslozu`。
- [x] 已创建 SA9 兜底启动配置：`asc-model-optimizer-worker-spot-fix2-sa9` / `asc-onk753cj`。
- [x] 已用 SA9 兜底配置跑通新版弹性 Worker smoke test：`jobId=8f68c9d7-95ed-4fee-9da4-c4e2e2fe5fa4`，`workerId=worker-cvm-ins-5q8pdmoy`。
- [x] 已创建蜂驰 `BF1.LARGE8` Worker 池：`asg-model-optimizer-worker-bf1-large8` / `asg-ov9ndzql`，启动配置 `asc-pf6hemad`。
- [x] 已创建蜂驰 `BF1.MEDIUM4` Worker 池：`asg-model-optimizer-worker-bf1-medium4` / `asg-o7ii5sub`，启动配置 `asc-4clszyux`。
- [x] 已创建蜂驰 `BF1.MEDIUM2` Worker 池：`asg-model-optimizer-worker-bf1-medium2` / `asg-9f3nd5an`，启动配置 `asc-idd0xj6b`。
- [x] Worker 基准机已拉取 `latest` 并启动验证成功，随后创建 `latest` 版 Worker 镜像：`model-optimizer-worker-elastic-20260527-latest1` / `img-om8cggg4`。
- [x] 已切换 SA9 兜底 Worker 池到启动配置：`asc-model-optimizer-worker-spot-latest1-sa9` / `asc-jhcn98fp`。
- [x] 已切换蜂驰 `BF1.LARGE8` Worker 池到启动配置：`asc-model-optimizer-worker-spot-latest1-bf1-large8` / `asc-58tnbry1`。
- [x] 已切换蜂驰 `BF1.MEDIUM4` Worker 池到启动配置：`asc-model-optimizer-worker-spot-latest1-bf1-medium4` / `asc-g810xf8d`。
- [x] 已切换蜂驰 `BF1.MEDIUM2` Worker 池到启动配置：`asc-model-optimizer-worker-spot-latest1-bf1-medium2` / `asc-aigxhst7`。
- [x] 已用 `latest1` SA9 兜底 Worker `ins-c72wkhws` 跑通真实 smoke test：`jobId=682a51b8-67c9-429d-9815-7dbb6d09b4e2`，`workerId=worker-cvm-ins-c72wkhws`。
- [x] 记录当前 `BF1.LARGE8` 在南京一区竞价库存返回 `SpotSoldOut`，调度器需要规格 fallback。
- [x] 伸缩组容量已设为 `min=0`、`desired=0`、`max=3`，当前不会自动拉起 Worker。
- [ ] 从 `4C8G / WORKER_CONCURRENCY=1` 开始压测，再评估 `8C16G / WORKER_CONCURRENCY=2`。
- [x] 配置最大实例数，避免成本失控。
- [ ] 配置缩容 drain 时间，让 Worker 停止领取新任务。
- [x] Worker 已支持 job 租约、续租、过期恢复和 CMQ watchdog 消息。
- [x] Worker 已支持轮询腾讯云 Spot 回收 Metadata，收到回收通知后进入 draining。
- [x] 已实现独立 `optimizer-dispatcher` 进程，可按 Job backlog 调整腾讯云 AS desired capacity。
- [x] 将 `optimizer-dispatcher` 部署到 Portainer，先配置 SA9 兜底组 `asg-pj6qaput`，验证自动扩容到 `1`、任务完成后自动缩容到 `0`：`jobId=0c7928e0-e155-46ba-a7c7-96405e9ce893`，`workerId=worker-cvm-ins-3fv5utu4`。
- [ ] 在真实 Spot 回收或强杀 Worker 场景验证任务会重新投递并被新 Worker 接手。

## 7. API 验收

- [x] `POST /api/v1/jobs` 创建 `model.optimize` 任务并返回上传授权。
- [x] Job 记录包含 `taskType`，队列消息也包含 `taskType`。
- [x] `POST /api/v1/jobs` 使用真实 TDMQ/CMQ 入队 smoke test 通过，返回 `queued`。
- [ ] 未注册 task type 会被拒绝。
- [ ] 外部系统可用临时密钥上传模型到 COS。
- [ ] COS 事件或 `complete-upload` 可触发入队。
- [x] Worker 可通过 `TDMQ/CMQ` 消费任务并写回 output bucket。
- [x] `GET /api/v1/jobs/:jobId` 可查到 succeeded/failed。
- [ ] `GET /api/v1/jobs/:jobId/result-url` 返回短期下载 URL。
- [ ] 客户回调带 HMAC 签名且可被客户系统验签。

## 8. 支付验收

- [ ] 创建订单可返回微信 Native `code_url`。
- [ ] Web UI 可把 `code_url` 渲染成二维码。
- [ ] 微信支付回调验签失败时拒绝处理。
- [ ] 微信支付成功后订单幂等更新为 paid。
- [ ] 订单 paid 后关联 Job 自动进入 queued。
- [ ] 未支付、过期、取消订单不会触发处理。

## 9. 监控告警

- [ ] 队列可见消息数告警。
- [ ] 按 task type 统计队列积压、失败率和平均处理时长。
- [ ] Worker heartbeat 丢失告警。
- [ ] Job 失败率告警。
- [ ] Callback 失败率告警。
- [ ] 微信支付回调失败告警。
- [ ] COS 上传或下载错误告警。
- [ ] 单日成本或实例数异常告警。
