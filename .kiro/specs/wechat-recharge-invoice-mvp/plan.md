# Spec Plan: WeChat Recharge Invoice MVP

## Goal

用最小范围实现可上线的微信电子发票链路：

- 用户充值成功后，可从微信支付凭证页或账单页申请发票。
- 系统收到微信抬头通知后，按充值订单金额创建发票申请。
- 系统完成开票、保存状态和下载信息。
- 已开票充值订单退款前必须先冲红或人工处理。

## Non-goals

- 不实现完整站内发票中心。
- 不按实际消费金额计算可开票余额。
- 不处理赠送余额、优惠券、企业月结、批量开票。
- 不在功能验收前打开生产 `WECHAT_PAY_SUPPORT_FAPIAO=true`。

## Delivery Phases

### Phase 0: Spec and Readiness

输出 requirements、design、plan、tasks，并确认微信支付商户平台已开通电子发票能力。

### Phase 1: Invoice Domain Model

新增 `src/invoices` 模块，定义 InvoiceRequest、InvoiceItem、ProviderEvent、状态机和 store 接口。实现 local store 和 MySQL store。

### Phase 2: WeChat Notification Intake

新增微信发票通知路由。复用 `wechat-pay` 服务或 payment provider 完成微信签名验证和 resource 解密。实现通知幂等。

### Phase 3: Recharge Invoice Creation

根据微信抬头事件匹配 paid recharge order，创建充值订单发票申请和明细，提交 provider 开票。MVP 可先实现 manual provider，再切到 wechat provider。

### Phase 4: Query, Download and Admin Recovery

新增用户查询充值订单发票状态和下载链接接口。新增管理员重试、标记开票、冲红入口。

### Phase 5: Refund Guard

在充值退款流程中加入发票状态检查。已开票或开票中的订单阻止自动退款。

### Phase 6: Enable WeChat Invoice Entry

所有验收通过后，在 Portainer 设置 `WECHAT_PAY_SUPPORT_FAPIAO=true` 并重部署。用小额真实充值验证微信凭证页“开发票”入口。

## Rollout Strategy

1. 代码先上线但发票入口开关保持关闭。
2. 申请并开通微信支付服务商电子发票能力，完成子商户邀请、授权和开票模式配置。
3. 设置 `WECHAT_PAY_MODE=partner` 和服务商/子商户商户号，调用子商户开票状态检查接口确认通过。
4. 在生产回调 URL 和服务商开发选项配置完成后，使用微信平台测试或小额真实交易验证通知。
5. 先让 provider 使用 manual 模式，确认抬头通知和订单匹配正确。
6. 接通 wechat_fapiao provider 后进行小额真实开票。
7. 开启 `support_fapiao`。
8. 观察失败率和人工处理队列。

## Initial Defaults

```text
INVOICE_PROVIDER=manual
WECHAT_FAPIAO_ENABLED=true
WECHAT_PAY_SUPPORT_FAPIAO=false
INVOICE_ITEM_NAME=3D模型优化服务
INVOICE_SUPPORT_SPECIAL=false
```

## Acceptance Gates

- 未登录用户不能读取他人的发票状态。
- 微信通知验签失败不会创建发票。
- 重复通知不会重复开票。
- 发票金额等于充值订单金额。
- 已开票充值订单不能自动退款。
- 开票成功后可查询发票号和下载链接。
- 打开 `WECHAT_PAY_SUPPORT_FAPIAO=true` 前，至少完成一笔受控小额开票演练。
