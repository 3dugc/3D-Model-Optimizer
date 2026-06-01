# Requirements Document

## Introduction

本文档定义“微信充值订单电子发票 MVP”的需求。目标是在已开通微信支付电子发票能力后，先实现最简单可用的开票链路：用户充值成功后，从微信支付凭证页或账单页点击“开发票”，微信通知本系统用户已填写抬头，本系统按对应充值订单金额完成电子发票开具、保存发票状态，并限制已开票充值订单退款。

本 spec 只覆盖第一阶段“按充值订单开票”。第二阶段“站内按实际消费金额开票”另行实现，不阻塞本 MVP。

## Glossary

- **Web_User**: 通过真实登录进入 3dugc.com 的用户。
- **Recharge_Order**: 用户钱包充值订单，金额为 `800`、`1800`、`3800`、`8800` 分之一。
- **Wechat_Pay_Order**: 微信支付订单，使用 `out_trade_no` 与 Recharge_Order 关联。
- **Invoice_Request**: 本系统内部发票申请记录。
- **Invoice_Item**: 发票申请对应的业务明细；MVP 绑定 Recharge_Order。
- **Wechat_Fapiao**: 微信支付电子发票能力。
- **Title_Notify**: 微信通知商户用户已填写发票抬头。
- **Issued_Notify**: 微信通知商户发票开具成功。
- **Reverse_Invoice**: 已开票后退款前需要执行的冲红或红字发票流程。

## Requirements

### Requirement 1: 充值订单支持微信支付发票入口

**User Story:** 作为已支付充值订单的用户，我希望能在微信支付凭证页或账单页点击“开发票”，以便按充值金额索取电子发票。

#### Acceptance Criteria

1. WHEN 发票 MVP 未完成或未开启 THEN THE System SHALL keep `WECHAT_PAY_SUPPORT_FAPIAO=false`。
2. WHEN 发票 MVP 验收通过并开启 THEN THE Recharge_Order creation SHALL pass `support_fapiao=true` to the payment provider.
3. WHEN 用户完成微信充值支付 THEN THE Wechat_Pay_Order SHALL expose the WeChat invoice entry in supported WeChat surfaces.
4. THE System SHALL NOT expose mock or manual auto-paid invoice behavior in production.

### Requirement 2: 微信发票抬头通知

**User Story:** 作为系统，我希望收到并验证微信“用户填写抬头完成”通知，以便按用户填写的信息创建发票申请。

#### Acceptance Criteria

1. WHEN WeChat calls `POST /api/v1/invoices/wechat/notify` or its compatibility aliases THEN THE System SHALL verify signature and decrypt the notification payload.
2. IF signature verification or decrypt fails THEN THE System SHALL reject the notification and SHALL NOT create invoice records.
3. THE System SHALL persist a dedupe record for each WeChat notification.
4. WHEN the same notification is delivered more than once THEN THE System SHALL return success without creating duplicate Invoice_Request records.
5. THE System SHALL use WeChat identifiers such as `fapiao_apply_id` and/or `out_trade_no` to locate the paid Recharge_Order.

### Requirement 3: 按充值订单创建发票申请

**User Story:** 作为系统，我希望把微信发票申请与充值订单绑定，以便发票金额、退款限制和用户查询都有准确来源。

#### Acceptance Criteria

1. WHEN Title_Notify references a paid Recharge_Order THEN THE System SHALL create one Invoice_Request for that Recharge_Order.
2. THE Invoice_Request amount SHALL equal `recharge_orders.amount_cents`.
3. THE Invoice_Item SHALL reference `recharge_order_id`.
4. THE System SHALL prevent more than one active, non-reversed Invoice_Request for the same Recharge_Order.
5. IF the Recharge_Order is not paid, cancelled, expired, refunded, or belongs to another user THEN THE System SHALL reject or hold the invoice request for manual review.

### Requirement 4: 开具电子发票并保存结果

**User Story:** 作为用户，我希望填写抬头后系统能自动完成开票并保存发票信息，以便后续下载或查看。

#### Acceptance Criteria

1. WHEN an Invoice_Request is created THEN THE Invoice_Provider SHALL submit an electronic invoice request using the recharge amount and title info.
2. THE invoice line item SHALL use a configurable item name, defaulting to `3D模型优化服务`.
3. WHEN provider submission succeeds THEN THE Invoice_Request SHALL move to `issuing`.
4. WHEN WeChat sends issued notification THEN THE System SHALL verify/decrypt it, update Invoice_Request to `issued`, and save invoice number/provider invoice id.
5. WHEN the provider returns a downloadable file URL or file token THEN THE System SHALL save it or make it queryable.
6. IF provider submission fails THEN THE Invoice_Request SHALL move to `failed` with a sanitized failure reason.

### Requirement 5: 用户查询和下载发票

**User Story:** 作为用户，我希望能查看充值订单的发票状态并下载已开具的发票，以便保存报销材料。

#### Acceptance Criteria

1. WHEN a logged-in user calls `GET /api/v1/account/wallet/recharge-orders/:orderId/invoice` THEN THE System SHALL return only that user's invoice status for the order.
2. WHEN a logged-in user calls `GET /api/v1/account/wallet/recharge-orders/:orderId/invoice/download-url` for an issued invoice THEN THE System SHALL return a short-lived download URL or proxy URL.
3. IF the invoice is not issued THEN THE download endpoint SHALL return a clear non-ready error.
4. IF the Recharge_Order belongs to another user THEN THE System SHALL return 404 or 403 without leaking invoice data.

### Requirement 6: 已开票充值订单退款保护

**User Story:** 作为财务和运营者，我希望已开票充值订单不能直接退款，以避免票款不一致。

#### Acceptance Criteria

1. WHEN a Recharge_Order has an `issued` Invoice_Request THEN THE System SHALL block automatic refund.
2. THE System SHALL mark such refunds as requiring Reverse_Invoice/manual review.
3. WHEN an invoice is reversed successfully THEN THE System SHALL allow the refund workflow to proceed.
4. THE System SHALL record reverse status and timestamps in Invoice_Request.

### Requirement 7: 管理和可观测性

**User Story:** 作为管理员，我希望能查看失败的发票申请并手动重试或标记处理结果，以便排查微信或税控异常。

#### Acceptance Criteria

1. THE System SHALL provide admin-only list/detail APIs for invoice requests.
2. THE System SHALL provide admin-only retry API for failed or stuck invoice requests.
3. THE System SHALL log invoice events with `invoiceRequestId`, `rechargeOrderId`, `outTradeNo`, and sanitized provider status.
4. THE System SHALL NOT log tax numbers, full phone numbers, API v3 keys, private keys, or raw decrypted notification bodies.

### Requirement 8: 部署开关

**User Story:** 作为运维者，我希望能在功能验收后再打开微信支付发票入口，以便避免用户提前进入断链流程。

#### Acceptance Criteria

1. THE production Portainer stack SHALL keep `WECHAT_PAY_SUPPORT_FAPIAO=false` until all MVP acceptance tests pass.
2. WHEN MVP acceptance tests pass THEN THE operator MAY set `WECHAT_PAY_SUPPORT_FAPIAO=true` and redeploy the stack.
3. THE System SHALL provide a smoke test checklist before and after enabling the switch.
