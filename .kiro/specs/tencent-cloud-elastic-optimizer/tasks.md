# Implementation Tasks: Tencent Cloud Elastic Optimizer

## Tasks

- [x] 1. 建立开发分支和架构文档
  - [x] 1.1 创建 `codex/tencent-cloud-elastic-optimizer` 开发分支
  - [x] 1.2 新增腾讯云弹性架构文档
  - [x] 1.3 明确 Docker Worker、slot 和单机并发策略
  - _Requirements: 3.1, 4.1-4.6, 5.1-5.6_

- [x] 2. 建立 spec 文件
  - [x] 2.1 新增 requirements 文档
  - [x] 2.2 新增 design 文档
  - [x] 2.3 新增 plan 文档
  - [x] 2.4 新增可勾选 tasks 文档
  - _Requirements: 10.3_

- [x] 3. 增加项目结构边界
  - [x] 3.1 新增 `src/cloud` 腾讯云适配层目录说明和类型
  - [x] 3.2 新增 `src/jobs` 任务状态与 repository 合约
  - [x] 3.3 新增 `src/tasks` 可扩展重后端任务类型目录说明和类型
  - [x] 3.4 新增 `src/worker` Docker Worker 运行时说明和类型
  - [x] 3.5 新增 `src/billing` 计费/微信支付说明和类型
  - [x] 3.6 新增 `src/callbacks` 回调说明和类型
  - _Requirements: 1.1-1.5, 1A.1-1A.7, 4.1-4.6, 8.1-8.6_

- [x] 4. 抽象核心 Job 模型
  - [x] 4.1 定义 Job、Order、Worker、CallbackDelivery、TaskType 的实体模型
  - [x] 4.2 实现 Job 状态机和非法状态转换保护
  - [x] 4.3 实现 Order 状态机和幂等支付更新
  - [x] 4.4 增加本地内存 repository 用于开发测试
  - [x] 4.5 设计并实现 MySQL/Postgres 数据库 migration
  - [x] 4.6 实现 MySQL/Postgres Job/Order 共享状态库
  - _Requirements: 1.1-1.5, 1A.1-1A.7, 8.1-8.6, 9.3, 9.4_

- [x] 5. 新增异步任务 API
  - [x] 5.1 实现 `POST /api/v1/jobs`
  - [x] 5.2 实现 `GET /api/v1/jobs/:jobId`
  - [x] 5.3 实现 `POST /api/v1/jobs/:jobId/complete-upload`
  - [x] 5.4 实现 `GET /api/v1/jobs/:jobId/result-url`
  - [x] 5.5 实现 API Key 鉴权和 scope 校验
  - [x] 5.6 添加 OpenAPI 文档和测试
  - _Requirements: 1.1-1.5, 2.1, 6.6_

- [x] 6. 实现 COS 上传和事件处理
  - [x] 6.1 定义 StorageProvider 接口
  - [x] 6.2 实现 LocalStorageProvider
  - [x] 6.3 实现 TencentCosStorageProvider
  - [x] 6.4 实现 COS 临时密钥签发
  - [x] 6.5 实现 `POST /api/v1/cos/events`
  - [x] 6.6 实现 COS-only manifest 解析和校验
  - [x] 6.7 测试重复 COS 事件幂等处理
  - _Requirements: 2.1-2.5, 9.3_

- [ ] 7. 抽取优化 Job Runner
  - [ ] 7.1 从 `routes/optimize.ts` 抽取 ZIP 解压、主模型查找和转换逻辑
  - [x] 7.2 增加安全解压限制：路径穿越、文件数量、总大小
  - [x] 7.3 抽取 `model.optimize` Task_Handler 复用 `executePipeline`
  - [x] 7.4 保持现有同步 API 行为不变
  - [ ] 7.5 为 ZIP 和多格式转换增加回归测试
  - _Requirements: 1A.1-1A.5, 6.1-6.5, 9.2_

- [x] 8. 实现 Docker Worker
  - [x] 8.1 新增 Worker CLI 入口
  - [x] 8.2 支持 `WORKER_CONCURRENCY`
  - [x] 8.3 实现 Worker heartbeat
  - [x] 8.4 实现 draining 模式
  - [x] 8.5 Worker 根据 `taskType` 选择 Task_Handler
  - [x] 8.6 Worker 成功时上传结果和报告到 COS
  - [x] 8.7 Worker 失败时写入结构化错误
  - [x] 8.8 添加 worker Docker/Compose 示例
  - [x] 8.9 Worker heartbeat 支持写入 MySQL/Postgres 共享状态库
  - _Requirements: 1A.1-1A.5, 4.1-4.6, 6.1-6.5, 10.1_

- [ ] 9. 实现队列和调度
  - [x] 9.1 定义 QueueProvider 接口
  - [x] 9.2 实现 LocalQueueProvider
  - [x] 9.3 实现 TDMQ/CMQ provider
  - [x] 9.4 实现消息 ACK、重试、死信策略
  - [x] 9.5 实现 Dispatcher slot 计算
  - [ ] 9.6 实现 Batch submit backend
  - [x] 9.7 实现 Spot CVM scaling backend 或伸缩组对接
  - _Requirements: 3.1-3.6, 5.1-5.6_

- [ ] 10. 接入微信 Native 支付
  - [ ] 10.1 定义 PaymentProvider 接口
  - [ ] 10.2 实现 Wechat Native 下单
  - [ ] 10.3 Web UI 展示二维码
  - [ ] 10.4 实现微信支付回调验签和解密
  - [x] 10.5 支付成功后触发 Job 入队
  - [ ] 10.6 实现订单过期、关闭和退款状态处理
  - [ ] 10.7 增加支付回调幂等测试
  - _Requirements: 8.1-8.6, 9.3, 9.5_

- [ ] 11. 实现客户回调
  - [x] 11.1 定义 callback payload 和签名协议
  - [x] 11.2 实现 HMAC 签名
  - [x] 11.3 实现回调发送和超时控制
  - [ ] 11.4 实现指数退避重试
  - [ ] 11.5 实现回调查询和重放接口
  - [x] 11.6 增加签名和重试测试
  - _Requirements: 7.1-7.5_

- [ ] 12. 增加租户限额和成本保护
  - [ ] 12.1 增加租户并发限制
  - [ ] 12.2 增加每日任务数和总处理时长限制
  - [ ] 12.3 增加全局最大 slot 和最大实例数限制
  - [ ] 12.4 增加任务超时取消
  - [ ] 12.5 增加成本告警指标
  - [ ] 12.6 支持按 `taskType` 配置不同限额和价格
  - _Requirements: 1A.6-1A.7, 5.5, 9.1, 10.2_

- [ ] 13. 可观测性和部署资料
  - [ ] 13.1 增加结构化日志字段
  - [ ] 13.2 暴露队列深度、slot 使用率、失败率指标
  - [x] 13.3 新增部署环境变量模板
  - [x] 13.4 新增腾讯云资源创建清单
  - [x] 13.5 新增生产演练 checklist
  - [x] 13.6 配置 GitHub Actions 推送腾讯云镜像仓库，并让 Portainer 入口栈拉取腾讯云镜像
  - [x] 13.7 新增可复用重后端任务平台部署 runbook
  - _Requirements: 10.1-10.5_

- [ ] 14. 集成验证
  - [ ] 14.1 本地 fake queue + local storage 端到端测试
  - [ ] 14.2 COS 上传到队列集成测试
  - [ ] 14.3 Worker 并发 slot 压测
  - [x] 14.4a 实现 job 租约、续租和过期恢复，避免 Worker 被回收后任务永久卡在 `processing`
  - [x] 14.4b 实现 CMQ watchdog 消息，处理队列消息提前重新可见和 Worker 消失后的重投递
  - [x] 14.4c 实现 Worker 轮询腾讯云 Spot 回收 Metadata 并进入 draining
  - [x] 14.4 Spot 回收或强杀 Worker 后任务重新投递的真实云上模拟测试：`jobId=41e5772e-10e1-4e02-9fe9-5297f32f8bcc`，`worker-cvm-ins-i7cslhse` 被释放后由 `worker-cvm-ins-a8k745rc` 以 attempts=2 完成
  - [ ] 14.5 微信支付沙箱或测试商户回调测试
  - [ ] 14.6 客户回调失败重试测试
  - _Requirements: 1.1-10.5_

- [ ] 15. 腾讯云真实部署落地
  - [x] 15.1 部署入口 Stack `model-optimizer` 到 `https://optimizer.7dgame.com`
  - [x] 15.2 创建并配置专用 COS bucket `model-optimizer-1251022382`
  - [x] 15.3 创建 CMQ 主队列 `optimizer-jobs` 和死信队列 `optimizer-jobs-dlq`
  - [x] 15.4 接入 TDSQL-C MySQL 集群 `cynosdbmysql-o6c4ezij`
  - [x] 15.5 创建通用数据库 `async_task_platform` 和运行时账号 `async_task_runtime@%`
  - [x] 15.6 新建 Worker 基准机 `model-optimizer-worker-base` / `ins-big9dirk`
  - [x] 15.7 在 Worker 基准机安装 Docker、配置镜像仓库登录和 systemd Worker 服务
  - [x] 15.8 停止入口机本地 Worker，并用基准机跑通真实队列 smoke test
  - [x] 15.9 将 Worker 启动脚本改成按腾讯云 metadata 生成唯一 `WORKER_ID`
  - [x] 15.10 发起从 Worker 基准机创建自定义镜像 `model-optimizer-worker-base-20260527` / `img-rxjo5rca`
  - [x] 15.10a 等待自定义镜像 `img-rxjo5rca` 状态变为正常
  - [x] 15.11 保存 CVM 竞价启动模板 `lt-model-optimizer-worker-spot`
  - [x] 15.11a 创建 AS 启动配置 `asc-model-optimizer-worker-spot` / `asc-lwvidj3l`
  - [x] 15.11b 创建 AS 伸缩组 `asg-model-optimizer-worker-spot` / `asg-pj6qaput`，容量 `0/0`，范围 `0/3`
  - [x] 15.11c 停止 Worker 基准机 `ins-big9dirk`，用 AS 伸缩组扩容出弹性实例跑通真实 smoke test
  - [x] 15.11d 修复 Worker 镜像启动脚本问题：metadata 变量转义和无公网实例 `--pull always` 超时
  - [x] 15.11e 从热修弹性实例创建修复后镜像 `model-optimizer-worker-elastic-20260527-fix1` / `img-hmvlx5n2`
  - [x] 15.11f 创建并切换 AS 启动配置 `asc-model-optimizer-worker-spot-fix1` / `asc-rkmzzkyj`
  - [x] 15.11g 验证新镜像冷启动实例 `ins-fss90ts4` 自动启动 Worker，并将伸缩组缩回 `0/0`
  - [x] 15.11h 入口 Stack 切为 API-only，移除入口机本地 Worker
  - [x] 15.11i 修复 TDSQL-C MySQL 租约恢复 `LIMIT ?` 兼容问题，提交 `d465f02`
  - [x] 15.11j 创建新版 Worker 镜像 `model-optimizer-worker-elastic-20260527-fix2` / `img-d9cslozu`
  - [x] 15.11k 创建并切换 SA9 兜底启动配置 `asc-model-optimizer-worker-spot-fix2-sa9` / `asc-onk753cj`
  - [x] 15.11l 用 SA9 兜底 Worker `ins-5q8pdmoy` 跑通新版真实 smoke test `8f68c9d7-95ed-4fee-9da4-c4e2e2fe5fa4`
  - [x] 15.11m 创建蜂驰 `BF1.LARGE8`、`BF1.MEDIUM4`、`BF1.MEDIUM2` 三档 Worker 池，均保持 `0/0`
  - [x] 15.11n 记录 `BF1.LARGE8` 当前 `SpotSoldOut`，调度器需要多规格 fallback
  - [x] 15.11o 停止 Worker 基准机 `ins-big9dirk`
  - [x] 15.12 将入口 Stack 热修到 `sha-d465f02` 并确认健康检查
  - [x] 15.13 将 CI 镜像 tag 策略改为只推 `latest`，不再生成短哈希 tag
  - [x] 15.14 增加腾讯镜像仓库 `sha-*` tag 手动清理 workflow
  - [x] 15.15 将入口 Stack 和 Worker 基准镜像切到 `latest`
  - [x] 15.16 执行腾讯镜像仓库短哈希 tag 清理，已删除 13 个 `sha-*` tag
  - [x] 15.16a 从切到 `latest` 的基准机创建新版 Worker 镜像 `model-optimizer-worker-elastic-20260527-latest1` / `img-om8cggg4`
  - [x] 15.16b 将 SA9 和三档蜂驰 AS 伸缩组切到 `latest1` 镜像启动配置：`asc-jhcn98fp`、`asc-58tnbry1`、`asc-g810xf8d`、`asc-aigxhst7`
  - [x] 15.16c 确认四个 Worker 伸缩组容量均为 `0/0`，并再次停止 Worker 基准机 `ins-big9dirk`
  - [x] 15.16d 用 `latest1` SA9 兜底 Worker `ins-c72wkhws` 跑通真实 smoke test `682a51b8-67c9-429d-9815-7dbb6d09b4e2`，测试后缩回 `0/0`
  - [x] 15.16e 实现 `optimizer-dispatcher` 进程和 Portainer Compose 模板，可按 Job backlog 调整 AS desired capacity
  - [x] 15.16f 将 `optimizer-dispatcher` 部署到 Portainer，并用真实队列验证自动扩容到 `1`、任务完成后缩回 `0`：`jobId=0c7928e0-e155-46ba-a7c7-96405e9ce893`，`workerId=worker-cvm-ins-3fv5utu4`
  - [x] 15.17 将永久密钥从镜像内配置迁移到运行时 CAM 角色；停用旧 `modeloptimizer` API key，未创建新 key
  - [x] 15.18a 准备 Dispatcher AS 最小权限策略文件 `infra/tencent-cloud/cam/model-optimizer-dispatcher-as-policy.json`
  - [x] 15.18b 在 CAM 绑定最小权限策略，验证后移除临时 `QcloudASFullAccess`：`jobId=5dd794c5-83eb-4870-8182-c365b5855cdb`，`workerId=worker-cvm-ins-m6q6mezk`
  - [x] 15.19 将 CAM 子账号临时 `QcloudTATFullAccess` 移除，运行时账号仅保留 AS 最小权限和 runtime 策略
  - [x] 15.20 最终确认后释放 Worker 基准机 `ins-big9dirk`
  - [x] 15.21 完成真实强杀 Worker 恢复演练，并在演练后将 `asg-pj6qaput` 缩回 `0/0`：`jobId=41e5772e-10e1-4e02-9fe9-5297f32f8bcc`
  - [x] 15.22 创建 COS 告警策略 `model-optimizer-cos-errors-traffic` / `policy-5cncpgxg`
  - [x] 15.23 新增 `optimizer-monitor` 业务监控进程，覆盖队列积压、无 Worker 心跳和处理中 Worker 失联
  - [x] 15.24 创建并绑定运行时监控最小权限策略 `model-optimizer-monitor-alarm-minimal`，解除临时 `QcloudMonitorFullAccess`
  - _Requirements: 3.1-3.6, 4.1-4.6, 5.1-5.6, 10.3_

## Notes

- 勾选项代表可直接执行的工程任务。
- 真实腾讯云和微信支付接入需要部署环境提供凭证，默认本地开发应使用 fake/local provider。
- 每个阶段都应保持现有同步 API 可用，直到新异步 API 完成灰度。
- 云上部署过程必须同步更新 `docs/heavy-task-platform-runbook.md`，且不得把密钥写入仓库。
