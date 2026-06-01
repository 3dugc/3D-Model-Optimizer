# Implementation Tasks: WeChat Recharge Invoice MVP

## Tasks

- [x] 1. 建立 spec 文件
  - [x] 1.1 新增 `requirements.md`
  - [x] 1.2 新增 `design.md`
  - [x] 1.3 新增 `plan.md`
  - [x] 1.4 新增 `tasks.md`
  - _Requirements: 8.1-8.3_

- [ ] 2. 建立发票领域模型
  - [x] 2.1 新增 `src/invoices/types.ts`
  - [x] 2.2 定义 `InvoiceRequest`、`InvoiceItem`、`InvoiceProviderEvent`
  - [ ] 2.3 定义发票状态机：`submitted/issuing/issued/failed/reverse_pending/reversed/cancelled/manual_review`
  - [x] 2.4 定义 `InvoiceStore` 接口
  - [x] 2.5 实现 `LocalInvoiceStore`
  - [x] 2.6 实现 MySQL/Postgres 发票表初始化或 migration
  - [x] 2.7 实现 `MysqlInvoiceStore` 或当前 state store 对应实现
  - _Requirements: 3.1-3.5, 4.1-4.6_

- [x] 3. 实现 InvoiceService
  - [x] 3.1 新增 `src/invoices/invoice-service.ts`
  - [x] 3.2 实现按 `outTradeNo` / `rechargeOrderId` 查找 paid recharge order
  - [x] 3.3 实现同一充值订单只能有一个未冲红发票申请
  - [x] 3.4 实现创建 `InvoiceRequest` 和 `InvoiceItem`
  - [x] 3.5 实现开票成功状态更新
  - [x] 3.6 实现失败状态和可重试状态更新
  - [x] 3.7 实现用户查询充值订单发票状态
  - [x] 3.8 实现下载链接查询
  - _Requirements: 3.1-3.5, 4.1-4.6, 5.1-5.4_

- [ ] 4. 实现 InvoiceProvider 抽象
  - [x] 4.1 新增 `InvoiceProvider` 接口
  - [x] 4.2 实现 `ManualInvoiceProvider`，用于先打通记录和人工回填
  - [x] 4.3 预留 `WechatFapiaoProvider`
  - [x] 4.4 provider 错误返回需脱敏并映射为稳定错误码
  - [ ] 4.5 增加 provider 单元测试
  - _Requirements: 4.1-4.6, 7.1-7.4_

- [x] 5. 接入微信发票通知
  - [x] 5.1 新增 `src/routes/invoices.ts`
  - [x] 5.2 实现 `POST /api/v1/invoices/wechat/title-notify`
  - [x] 5.3 实现 `POST /api/v1/invoices/wechat/issued-notify`
  - [x] 5.4 实现 `POST /api/v1/invoices/wechat/reverse-notify`
  - [x] 5.4a 实现统一 `POST /api/v1/invoices/wechat/notify`
  - [x] 5.5 复用 `wechat-pay` 服务解析/验签/解密通知
  - [x] 5.6 实现 provider event 幂等写入
  - [x] 5.7 验签失败时拒绝处理且不创建记录
  - [x] 5.8 重复通知返回成功且不重复开票
  - _Requirements: 2.1-2.5, 4.4, 6.3, 7.3_

- [x] 6. 支持充值订单发票查询和下载
  - [x] 6.1 实现 `GET /api/v1/account/wallet/recharge-orders/:orderId/invoice`
  - [x] 6.2 实现 `GET /api/v1/account/wallet/recharge-orders/:orderId/invoice/download-url`
  - [x] 6.3 查询接口必须使用 `requireWebUser`
  - [x] 6.4 用户只能访问自己的充值订单发票
  - [x] 6.5 未开票或开票中下载返回 `INVOICE_NOT_READY`
  - _Requirements: 5.1-5.4_

- [ ] 7. 增加管理恢复能力
  - [ ] 7.1 实现管理员发票列表服务方法
  - [ ] 7.2 实现管理员发票详情服务方法
  - [ ] 7.3 实现 failed/stuck 发票重试服务方法
  - [ ] 7.4 实现人工标记开票成功服务方法
  - [ ] 7.5 实现冲红/红字发票标记服务方法
  - [ ] 7.6 HTTP 管理接口必须受 admin 或 API-key scope 保护
  - _Requirements: 6.1-6.4, 7.1-7.4_

- [ ] 8. 增加已开票充值订单退款保护
  - [ ] 8.1 梳理现有充值退款入口；若未实现退款，则新增 service guard 供后续退款调用
  - [ ] 8.2 当充值订单存在 `submitted/issuing/issued/reverse_pending` 发票时阻止自动退款
  - [ ] 8.3 当发票状态为 `reversed/cancelled/failed` 时允许进入原退款流程
  - [ ] 8.4 返回明确错误码 `INVOICE_REVERSE_REQUIRED`
  - [ ] 8.5 增加退款保护单元测试
  - _Requirements: 6.1-6.4_

- [ ] 9. 配置和部署开关
  - [x] 9.1 增加 `INVOICE_PROVIDER`
  - [x] 9.2 增加 `WECHAT_FAPIAO_ENABLED`
  - [x] 9.3 增加 `INVOICE_ITEM_NAME`
  - [x] 9.4 确认 `WECHAT_PAY_SUPPORT_FAPIAO` 默认仍为 `false`
  - [x] 9.5 更新 `.env.cloud.example`
  - [x] 9.6 更新 `docker-compose.portainer.yml`
  - [x] 9.7 更新部署检查文档
  - [x] 9.8 增加微信支付服务商模式配置：`WECHAT_PAY_MODE=partner`、`WECHAT_PAY_SP_*`、`WECHAT_PAY_SUB_MCH_ID`
  - [x] 9.9 增加子商户开票状态检查接口
  - _Requirements: 1.1-1.4, 8.1-8.3_

- [ ] 10. 测试
  - [ ] 10.1 通知验签失败不创建发票
  - [x] 10.2 重复通知不重复创建发票
  - [x] 10.3 未支付充值订单不自动开票
  - [x] 10.4 发票金额等于充值订单金额
  - [ ] 10.5 用户不能读取他人的发票
  - [ ] 10.6 开票成功后能返回下载链接
  - [ ] 10.7 已开票订单退款被拦截
  - [x] 10.8 现有 `npm test` 通过
  - _Requirements: 2.1-2.5, 3.1-3.5, 5.1-5.4, 6.1-6.4_

- [ ] 11. 生产启用流程
  - [ ] 11.1 在微信支付商户平台配置发票通知 URL
  - [ ] 11.2 先部署代码且保持 `WECHAT_PAY_SUPPORT_FAPIAO=false`
  - [ ] 11.3 使用受控小额订单验证发票通知和记录创建
  - [ ] 11.4 验证 provider 开票、查询、下载
  - [ ] 11.5 在 Portainer 设置 `WECHAT_PAY_SUPPORT_FAPIAO=true`
  - [ ] 11.6 重部署 `model-optimizer` Stack
  - [ ] 11.7 验证微信支付凭证页/账单页出现“开发票”
  - [ ] 11.8 更新 runbook 和最终验证记录
  - _Requirements: 1.1-1.4, 8.1-8.3_
