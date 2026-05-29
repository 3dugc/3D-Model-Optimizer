# 微信支付电子发票接入实施文档

更新时间：2026-05-29

本文档面向 `3D-Model-Optimizer` 后续实现发票能力使用。当前系统已经完成真实登录、微信充值、钱包余额、每次优化 `1.00` 元扣费。产品决策为：第一阶段先走“微信支付凭证页开发票入口”，按充值订单金额开票；第二阶段再补“站内按实际消费金额开票”。

## 1. 结论

微信支付电子发票能力可以接入，但它不是“微信支付自动替商户开票”。微信支付主要提供支付后开票入口、抬头填写、通知回调、发票查询/下载、插入微信卡包等通道；开票主体、税控/数电发票能力、发票内容和合规责任仍属于商户。

本项目现在分两步走。

第一阶段，微信支付凭证页按充值订单开票：

- 微信 Native 充值下单传 `support_fapiao=true`。
- 用户在微信支付凭证页/账单页点击“开发票”。
- 微信通知商户用户已填写发票抬头。
- 本系统按充值订单金额调用微信电子发票或第三方发票平台完成开票。
- 开票成功后保存发票号、下载链接，并可插入微信卡包。

第二阶段，再按实际消费金额开票：

- 用户充值只是余额入账，不立刻开票。
- 模型优化成功后扣费 `100` 分，这笔 `charge` 流水进入可开票金额。
- 可开票金额 = 已消费现金金额 - 已开票金额 - 已退款/冲红金额。
- 未消费余额、冻结余额、赠送余额不进入可开票金额。

不要只在 Portainer 里直接把 `WECHAT_PAY_SUPPORT_FAPIAO=true` 当作完整上线。必须先实现微信抬头通知、获取抬头、开票、下载/交付和退款冲红限制，否则用户能看到“开发票”入口，但商户系统无法完成开票闭环。

## 2. 当前系统现状

已存在能力：

- `src/accounts`：Web 用户、钱包、充值订单、余额流水、任务扣费。
- `src/payments`：微信 Native 支付 provider，通过独立 `wechat-pay` 服务完成微信支付 API v3 签名、通知解析。
- `docker-compose.portainer.yml`：
  - `BILLING_MODE=wechat_native`
  - `DEFAULT_JOB_PRICE_CENTS=100`
  - `RECHARGE_PACKAGES_CENTS=800,1800,3800,8800`
  - `WECHAT_PAY_SUPPORT_FAPIAO=false`
- `docs/frontend-payment-invoice-design.md` 记录过消费后开票口径；以本文档的“两阶段”决策为后续实现准。

现有预留点：

- `src/payments/types.ts` 里 `CreateNativePaymentInput.supportFapiao?: boolean`
- `src/accounts/account-service.ts` 创建充值订单时会传 `supportFapiao: config.billing.wechatSupportFapiao`
- `src/config/index.ts` 支持 `WECHAT_PAY_SUPPORT_FAPIAO`

第一阶段实现完成前保持 `WECHAT_PAY_SUPPORT_FAPIAO=false`。实现并验收微信凭证页发票闭环后，再在 Portainer 设置 `WECHAT_PAY_SUPPORT_FAPIAO=true`。

## 3. 微信支付电子发票能力边界

官方能力要点：

- Native/JSAPI 下单支持 `support_fapiao`，传 `true` 后，支付成功消息和支付详情页出现开票入口。当前按微信支付反馈改走服务商模式，前提是服务商开通电子发票、子商户接受邀请并完成“服务商电子发票”开票模式配置。
- 用户填写发票抬头后，微信支付会回调商户系统。商户必须验签、解密、幂等处理。
- 开票成功后，可通过微信支付接口获取发票下载地址；只有已开具状态的发票才能下载。
- 自建/第三方模式适合商户已有税控或第三方电子发票平台，由商户生成电子发票文件，再通过微信支付完成支付后开票入口、卡包等体验。

对本项目的影响：

- 第一阶段明确接受“充值订单开票”口径，所以微信支付凭证页开票入口是主流程。
- 充值退款必须先判断该充值订单是否已开票；已开票的充值订单需要先冲红，再退款。
- 第二阶段再做站内 `/app/invoices`，由系统根据消费流水生成发票申请。

## 4. 推荐分阶段方案

### 阶段 A：微信支付充值订单开票

目标：用户充值成功后，可从微信支付凭证页/账单页进入“开发票”，按充值订单金额完成电子发票。

范围：

- 支付下单传 `support_fapiao=true`。
- 实现微信“用户发票抬头填写完成通知”回调。
- 实现获取用户填写抬头。
- 按 `recharge_orders.out_trade_no` 匹配充值订单。
- 按充值订单金额开电子发票。
- 开票成功后保存发票号、发票申请单号、下载链接。
- 已开票充值订单退款前必须冲红。

上线顺序：

1. 实现回调和开票 API。
2. 如果当前微信支付账号走服务商/子商户模式，先调用 `POST /v3/new-tax-control-fapiao/merchant/{sub_mchid}/check` 检查子商户是否已接受服务商电子发票邀请并完成开票模式配置。
3. 配置 `PATCH /v3/new-tax-control-fapiao/merchant/development-config`，服务商代子商户配置账单页入口时必须带 `sub_mch_code`。
4. 在测试商户/小额真实订单验收。
5. Portainer 设置 `WECHAT_PAY_SUPPORT_FAPIAO=true`。
6. 生产小额充值验证支付凭证页出现“开发票”入口。

### 阶段 B：站内按实际消费开票

目标：用户在站内发票中心按已实际优化消费金额申请发票，适合后续余额、退款、赠送额度、企业客户和月结。

范围：

- 前端增加 `/app/invoices`。
- 后端增加发票抬头、发票申请、发票明细表。
- 可开票金额按 `charge` 流水计算。
- 支持人工或自动开票。
- 支持专票人工审核。

适用场景：

- 用户充值后不立即索票，想按实际消费累计开票。
- 企业/API 客户需要账单和批量开票。
- 后续存在赠送余额、优惠券、月结额度。

### 阶段 C：第三方或微信电子发票 provider 抽象

目标：把充值订单开票和消费后开票共用到统一 provider。

范围：

- 抽象 `InvoiceProvider`。
- 支持 `wechat_fapiao`。
- 支持 `third_party`。
- 支持查询、下载、冲红、插入微信卡包。

## 5. 数据模型

新增表建议：

```sql
create table invoice_profiles (
  id varchar(64) primary key,
  user_id varchar(64) not null,
  type varchar(16) not null, -- personal, company
  title varchar(255) not null,
  tax_no varchar(64),
  email varchar(255),
  phone varchar(64),
  bank_name varchar(255),
  bank_account varchar(128),
  address varchar(512),
  is_default boolean not null default false,
  created_at varchar(32) not null,
  updated_at varchar(32) not null
);

create table invoice_requests (
  id varchar(64) primary key,
  user_id varchar(64) not null,
  profile_id varchar(64) not null,
  amount_cents integer not null,
  currency varchar(16) not null default 'CNY',
  status varchar(32) not null,
  invoice_type varchar(32) not null, -- digital_normal, special
  provider varchar(32), -- manual, wechat_fapiao, third_party
  provider_invoice_id varchar(128),
  provider_apply_id varchar(128),
  invoice_no varchar(128),
  file_url varchar(1024),
  failure_reason varchar(1024),
  created_at varchar(32) not null,
  submitted_at varchar(32),
  issued_at varchar(32),
  reversed_at varchar(32),
  updated_at varchar(32) not null
);

create table invoice_items (
  id varchar(64) primary key,
  invoice_request_id varchar(64) not null,
  wallet_ledger_id varchar(64),
  recharge_order_id varchar(64),
  job_id varchar(64),
  amount_cents integer not null,
  created_at varchar(32) not null
);
```

要求：

- 第一阶段充值开票：`recharge_order_id` 必填，`wallet_ledger_id` 可为空或指向 `recharge` 流水。
- 第二阶段消费开票：`wallet_ledger_id` 必填，指向 `charge` 流水。
- 同一充值订单只能绑定一个未冲红的发票申请。

可选扩展表：

```sql
create table invoice_provider_events (
  id varchar(64) primary key,
  provider varchar(32) not null,
  event_type varchar(64) not null,
  dedupe_key varchar(255) not null,
  raw_body text not null,
  processed_at varchar(32),
  created_at varchar(32) not null,
  unique (provider, dedupe_key)
);
```

## 6. 金额计算规则

新增服务 `InvoiceService`：

```ts
type InvoiceSummary = {
  consumedCents: number;
  invoicedCents: number;
  refundedOrReversedCents: number;
  availableCents: number;
};
```

第一阶段充值订单开票口径：

- 发票金额 = `recharge_orders.amount_cents`。
- 同一充值订单只允许一张未冲红发票。
- 充值订单已开票后，不允许自动退款；必须先冲红或由财务人工处理。
- 第一阶段不计算可开票金额，开票入口来自微信支付凭证页/账单页。

第二阶段消费后开票口径：

- `consumedCents`：`wallet_ledger.type === 'charge'` 且现金扣费部分。
- `invoicedCents`：已绑定 `invoice_items` 且 `invoice_requests.status` 不是 `cancelled`、`failed`、`reversed`。
- `refundedOrReversedCents`：退款流水、已冲红流水。
- `availableCents = consumedCents - invoicedCents - refundedOrReversedCents`。

注意：

- `hold`、`release` 不进入可开票金额。
- `recharge` 不进入可开票金额。
- 赠送余额、优惠券不进入可开票金额。
- 如果未来做“充 88 送 5 次”，赠送部分必须单独记账，不能开票。

## 7. 后端 API

### 7.1 第一阶段：充值订单微信发票 API

微信通知回调：

```text
POST /api/v1/invoices/wechat/notify
POST /api/v1/invoices/wechat/title-notify   # compatibility alias
POST /api/v1/invoices/wechat/issued-notify  # compatibility alias
POST /api/v1/invoices/wechat/reverse-notify # compatibility alias
```

内部查询：

```text
GET /api/v1/account/wallet/recharge-orders/:orderId/invoice
GET /api/v1/account/wallet/recharge-orders/:orderId/invoice/download-url
```

管理接口：

```text
GET  /api/v1/admin/recharge-invoices
POST /api/v1/admin/recharge-invoices/:invoiceRequestId/retry
POST /api/v1/admin/recharge-invoices/:invoiceRequestId/reverse
```

第一阶段创建发票申请的触发源不是站内按钮，而是微信支付的抬头填写完成通知。业务流程：

1. 用户充值支付成功。
2. 用户从微信支付凭证页点击“开发票”并填写抬头。
3. 微信回调 `/api/v1/invoices/wechat/notify`。
4. 系统通过微信接口获取抬头。
5. 系统用 `out_trade_no` 找到 `recharge_orders`。
6. 系统创建 `invoice_requests` 和 `invoice_items`，金额等于充值订单金额。
7. 调 provider 开票。
8. 开票成功后保存发票号和下载信息。

### 7.2 第二阶段：站内消费后发票 API

所有接口要求 Web 登录。

```text
GET  /api/v1/invoices/summary
```

返回：

```json
{
  "summary": {
    "consumedCents": 1200,
    "invoicedCents": 800,
    "refundedOrReversedCents": 0,
    "availableCents": 400
  }
}
```

```text
GET  /api/v1/invoice-profiles
POST /api/v1/invoice-profiles
PATCH /api/v1/invoice-profiles/:profileId
DELETE /api/v1/invoice-profiles/:profileId
```

个人抬头最小字段：

```json
{
  "type": "personal",
  "title": "张三",
  "email": "user@example.com"
}
```

企业普通发票最小字段：

```json
{
  "type": "company",
  "title": "某某科技有限公司",
  "taxNo": "91110108XXXXXXXXXX",
  "email": "finance@example.com"
}
```

```text
POST /api/v1/invoice-requests
GET  /api/v1/invoice-requests
GET  /api/v1/invoice-requests/:invoiceRequestId
GET  /api/v1/invoice-requests/:invoiceRequestId/download-url
```

创建申请：

```json
{
  "profileId": "profile_xxx",
  "amountCents": 1000,
  "invoiceType": "digital_normal"
}
```

创建规则：

- `amountCents > 0`
- `amountCents <= availableCents`
- 默认自动选择最早未开票的 `charge` 流水组成 `invoice_items`
- `digital_normal` 可自动/人工处理
- `special` 先进入 `pending_review`

后台管理接口可先做内部 API：

```text
GET   /api/v1/admin/invoice-requests
PATCH /api/v1/admin/invoice-requests/:invoiceRequestId
POST  /api/v1/admin/invoice-requests/:invoiceRequestId/mark-issued
POST  /api/v1/admin/invoice-requests/:invoiceRequestId/mark-failed
POST  /api/v1/admin/invoice-requests/:invoiceRequestId/reverse
```

## 8. 状态机

```text
draft            用户开始填写，未提交，可选
submitted        用户已提交申请
pending_review   专票或异常金额等待人工审核
issuing          已提交 provider，等待开票
issued           已开票，可下载
failed           开票失败，可修改后重试
cancelled        用户或管理员取消，释放 invoice_items
reverse_pending  已发起冲红
reversed         已冲红
```

人工开票兜底流程可以简化为：

```text
submitted -> issued
submitted -> failed
submitted -> cancelled
issued -> reverse_pending -> reversed
```

## 9. 微信电子发票接入点

### 9.1 支付订单开票入口

微信 Native/JSAPI 下单支持：

```json
{
  "support_fapiao": true
}
```

效果：

- 支付成功消息和支付详情页出现开票入口。
- 必须先开通服务商电子发票能力，并完成服务商对子商户的邀请、授权和开票模式配置。微信支付已反馈电子发票不再支持直连模式，后续按服务商模式尝试。

第一阶段开发完成前默认不打开：

```text
WECHAT_PAY_SUPPORT_FAPIAO=false
```

第一阶段验收通过后打开：

```text
WECHAT_PAY_SUPPORT_FAPIAO=true
```

打开前必须完成：

- 充值退款前检查是否已开票。
- 已开票退款需要先冲红。
- 充值订单金额和发票金额必须一致或有明确拆分规则。
- 微信回调地址已在商户平台配置并可公网访问。
- 通知验签、解密、幂等处理已完成。
- 开票成功后能查询和下载发票。

### 9.2 用户填写抬头通知

如果使用微信支付发票入口，需要实现通知接收：

```text
POST /api/v1/invoices/wechat/notify
```

处理要求：

- 验证 `Wechatpay-Timestamp`、`Wechatpay-Nonce`、`Wechatpay-Serial`、`Wechatpay-Signature`。
- 使用 API v3 key 解密 `resource`。
- 幂等保存事件。
- 根据 `fapiao_apply_id` 找到微信支付订单号或站内发票申请。
- 校验金额、商户号、用户归属。
- 转为站内 `invoice_request` 或推进已有申请状态。

### 9.3 开具电子发票

自动开票 provider 需要封装：

```ts
interface InvoiceProvider {
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  queryInvoice(providerApplyId: string): Promise<QueryInvoiceResult>;
  getDownloadUrl(providerApplyId: string, providerInvoiceId?: string): Promise<InvoiceDownloadResult>;
  reverseInvoice(input: ReverseInvoiceInput): Promise<ReverseInvoiceResult>;
}
```

微信 provider 关键字段：

- `fapiao_apply_id`：发票申请单号。
- `fapiao_id`：商户发票单号。
- 发票购买方信息：个人/企业抬头、税号、邮箱等。
- 销售方信息：商户主体资料，来自配置或微信平台。
- 明细行：建议“3D 模型优化服务”，金额按 `invoice_items` 汇总。

### 9.4 开票成功通知

实现：

```text
POST /api/v1/invoices/wechat/notify
```

处理：

- 验签、解密、幂等。
- 更新 `invoice_requests.status = issued`。
- 保存 `provider_invoice_id`、`invoice_no`。
- 调下载接口拿 `download_url`，或延迟异步获取。

### 9.5 下载发票文件

实现：

```text
GET /api/v1/invoice-requests/:invoiceRequestId/download-url
```

如果 provider 是微信：

- 调微信“获取发票下载信息”接口。
- 只有 `ISSUED` 状态允许返回下载链接。
- 建议服务端短期缓存下载链接，不要把永久外链当作可信存储。

## 10. 配置项

新增配置建议：

```text
WECHAT_PAY_MODE=partner
WECHAT_PAY_SP_APP_ID=
WECHAT_PAY_SP_MCH_ID=
WECHAT_PAY_SUB_APP_ID=
WECHAT_PAY_SUB_MCH_ID=
INVOICE_ENABLED=false
INVOICE_PROVIDER=manual
INVOICE_STORE_PATH=data/cloud/invoices.json
INVOICE_ITEM_NAME=3D模型优化服务充值
WECHAT_FAPIAO_TAX_CODE=
WECHAT_FAPIAO_GOODS_CATEGORY=
WECHAT_FAPIAO_TAX_RATE_BPS=
WECHAT_FAPIAO_SUB_MCH_ID= # 可为空，默认复用 WECHAT_PAY_SUB_MCH_ID
WECHAT_PAY_PLATFORM_SERIAL_NO=
WECHAT_PAY_SUPPORT_FAPIAO=false
```

如果复用 `wechat-pay` 服务做微信 API v3 签名和验签，可把微信发票 API 封装在支付服务中：

```text
POST /v1/fapiao/applications
GET  /v1/fapiao/applications/:applyId/files
POST /v1/fapiao/notifications/parse
GET  /v1/fapiao/user-title/:applyId
POST /v1/fapiao/merchant/:subMchid/check
PATCH /v1/fapiao/development-config
```

业务 API 不直接接触商户私钥。

## 11. 前端页面

新增 `/app/invoices` 或在现有工作台增加“发票”面板。

页面模块：

- 可开票金额。
- 已开票金额。
- 发票抬头列表。
- 新增/编辑抬头。
- 开票金额输入。
- 发票类型：数电普通发票、专票申请。
- 开票申请列表。
- 发票下载按钮。

交互规则：

- 可开票金额为 `0` 时禁用提交。
- 建议自动开票最低 `10.00` 元；小额仍可提交人工申请。
- 企业发票必须填写税号。
- 专票显示“人工审核”状态。
- 已提交申请锁定对应消费流水，避免重复开票。

## 12. 退款和冲红

退款前检查：

- 充值退款关联的 `recharge_order` 是否已被开票。
- 退款关联的 `charge` 是否已被开票。
- 如果已开票，必须先冲红或由财务确认处理。

新增逻辑：

- `recharge_orders.status=paid` 且已开票时，自动退款必须拦截。
- `job_charges.status = refunded` 时生成退款流水。
- 如果退款流水对应已开票 `invoice_items`，标记发票需要冲红。
- `invoice_requests.status=issued` 且涉及退款时，进入 `reverse_pending`。

建议第一阶段：

- 已开票充值订单不允许自动退款。
- 提示“请联系人工处理冲红后退款”。

## 13. 安全与合规要求

- 所有发票 API 必须登录。
- 用户只能查看自己的抬头、申请、下载链接。
- 管理接口必须有管理员权限，不要复用普通 Web token。
- 微信通知必须验签和解密，不允许明文直信任。
- 所有 provider 通知必须幂等。
- 发票抬头、税号、邮箱、电话属于敏感业务信息，日志中避免完整打印。
- 发票文件链接建议短期有效，或由服务端代理下载并鉴权。
- 开票主体必须与微信支付收款商户主体、税务登记主体保持一致，最终由财务确认。

## 14. 实施任务拆分

建议给另一个对话按这个顺序做：

1. 新增 `src/invoices` 模块：
   - types
   - store interface
   - local/mysql store
   - invoice-service
2. 增加数据库表：
   - `invoice_profiles`
   - `invoice_requests`
   - `invoice_items`
   - 可选 `invoice_provider_events`
3. 先做第一阶段充值开票：
   - 微信抬头填写完成通知
   - 获取用户填写的抬头
   - 用充值订单创建发票申请
   - provider 开票
   - 开票成功通知
   - 下载链接
   - 已开票充值订单退款拦截/冲红
4. 第一阶段验收通过后，Portainer 设置 `WECHAT_PAY_SUPPORT_FAPIAO=true`。
5. 再做第二阶段用户 API：
   - summary
   - profiles CRUD
   - invoice request create/list/detail/download
6. 增加管理 API：
   - list requests
   - mark issued/failed/cancelled
   - upload or set file URL
7. 前端增加发票中心。
8. 单元测试：
   - 可开票金额计算
   - 重复开票拦截
   - 未登录拦截
   - 企业抬头校验
   - 已开票退款拦截
9. 选定 provider 后实现自动开票：
   - `manual`
   - `wechat_fapiao`
   - `third_party`

## 15. 验收清单

第一阶段充值开票验收：

- 充值下单请求传 `support_fapiao=true`。
- 支付成功后，微信支付凭证页/账单页出现“开发票”入口。
- 用户填写抬头后，微信会调用 `/api/v1/invoices/wechat/notify`。
- 回调验签失败时拒绝处理。
- 重复回调不会重复创建发票。
- 系统能通过 `out_trade_no` 找到充值订单。
- 发票金额等于充值订单支付金额。
- 开票成功后能保存发票号和下载链接。
- 已开票充值订单退款前被拦截，必须先冲红。

第二阶段消费后开票验收：

- 用户优化成功扣费 `1.00` 元后，可开票金额增加 `1.00` 元。
- 用户充值但未消费，可开票金额不增加。
- 用户提交 `8.00` 元发票申请后，对应 8 条 `charge` 流水被锁定。
- 同一条消费流水不能重复开票。
- 人工标记开票成功后，用户能看到发票号和下载链接。
- 未登录访问发票接口返回 `WEB_AUTH_REQUIRED`。
- 用户 A 不能读取用户 B 的发票。

微信 provider 通用验收：

- 微信通知验签失败时拒绝处理。
- 重复通知不会重复开票或重复更新。
- 开票成功通知能把申请推进到 `issued`。
- 只有 `ISSUED` 状态返回下载链接。
- 冲红后状态变为 `reversed`，可开票金额按规则恢复或进入退款处理。

生产验收：

- Portainer 环境变量不包含明文税控或商户私钥，私钥仍放在 `wechat-pay` 服务或密钥挂载目录。
- 第一阶段实现前 `WECHAT_PAY_SUPPORT_FAPIAO=false`。
- 第一阶段验收通过后 `WECHAT_PAY_SUPPORT_FAPIAO=true`。
- 发票功能灰度给管理员测试账号。
- 财务确认税目、税率、开票主体和专票流程。

## 16. 官方参考

- 微信支付电子发票接入前准备：`https://pay.wechatpay.cn/doc/v3/merchant/4012064807`
- 微信支付电子发票开发指引，自建/第三方模式：`https://pay.wechatpay.cn/doc/v3/merchant/4012065100`
- Native 下单 `support_fapiao`：`https://pay.wechatpay.cn/doc/v3/merchant/4012791877`
- 服务商 Native 下单 `support_fapiao`：`https://pay.wechatpay.cn/doc/v3/partner/4012738659`
- JSAPI/小程序下单 `support_fapiao`：`https://pay.wechatpay.cn/doc/v3/merchant/4012791897`
- 服务商检查子商户开票功能状态：`https://pay.wechatpay.cn/doc/v3/partner/4012474022`
- 服务商配置开发选项：`https://pay.wechatpay.cn/doc/v3/partner/4012474031`
- 用户发票抬头填写完成通知：`https://pay.wechatpay.cn/doc/v3/merchant/4012286009`
- 发票开具成功通知：`https://pay.wechatpay.cn/doc/v3/merchant/4012286057`
- 获取发票下载信息：`https://pay.wechatpay.cn/doc/v3/merchant/4012538335`
- 现有产品设计：`docs/frontend-payment-invoice-design.md`
