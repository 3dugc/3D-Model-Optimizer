# Unified Auth Service Design

本文档定义新的统一注册登录中心。旧仓库 `gdgeek/auth` 是 Yii2/PHP 实现，只作为历史流程参考，不继续扩展。

## 目标

- 给 `3dugc.com` 和现有业务站点共用一套用户身份。
- 微信公众号网页授权、微信开放平台网站扫码、小程序登录最终合并到同一个用户。
- 以 `unionid` 作为跨公众号/小程序/网站的统一微信身份锚点；保留每个渠道自己的 `openid`。
- 每个业务系统只接入标准授权协议，不直接保存公众号 AppSecret。
- 后续可扩展手机号、邮箱、企业微信、Apple、GitHub、Google 等登录方式。

## 旧 Yii2 Auth 仓库结论

旧仓库已有以下能力：

- 使用 EasyWeChat 连接公众号。
- 通过公众号二维码事件拿到 `openid`。
- 调用公众号用户信息接口补 `unionid`。
- 用临时 `token -> openid` 映射完成扫码登录轮询。
- 数据模型中已有 `wechat.openid`、`wechat.unionid`、`wechat.token`。

不建议继续扩展的原因：

- Yii2 技术栈老，和当前 Node/TypeScript 服务体系不一致。
- 登录接口不是标准 OAuth/OIDC 风格，跨多个站点复用会越来越难。
- token 是随机字符串，缺少 refresh token、会话撤销、设备管理、审计等完整身份能力。
- 公众号消息推送、扫码登录、用户账号绑定混在一个 controller 中，后续维护成本高。
- CORS、IP 白名单、密钥管理、回调地址校验需要重新梳理。

旧仓库可复用的信息：

- 公众号 AppID：`wx6f81800f15c9a88c`。
- 公众号原始 ID：`gh_625753f9b05f`。
- 现有公众号消息推送域名：`auth.bujiaban.com`。
- 现有 JS 安全域名包括：`dev.mrpp.com`、`auth.bujiaban.com`。
- 历史扫码登录流程可作为兼容迁移参考。

## 推荐技术方案

第一版建议使用：

- Runtime: Node.js 22 LTS。
- Language: TypeScript。
- Framework: Fastify 或 NestJS。
- DB: 腾讯云 TDSQL-C MySQL。
- ORM: Prisma。
- Cache/session: Redis。
- API Auth: OAuth 2.1 Authorization Code + PKCE。
- Token: 短期 Access Token + Refresh Token；对内可发布 JWKS。
- Deploy: Docker + GitHub Actions + Portainer/Traefik。
- Domain: `auth.3dugc.com` 或继续使用已有 `auth.bujiaban.com`。

建议优先 Fastify + Prisma：更轻、更贴近当前 `3D-Model-Optimizer` Node 服务；如果未来团队更偏企业后端规范，再选 NestJS。

## 授权流程

业务站点都注册为 OAuth Client：

```text
3dugc.com
client_id=3dugc-web
redirect_uri=https://3dugc.com/auth/callback

现有业务站点
client_id=bujiaban-web
redirect_uri=https://<existing-site>/auth/callback
```

标准 Web 登录：

```text
Browser -> App: 点击登录
App -> Auth: GET /oauth/authorize?client_id=...&redirect_uri=...&scope=openid profile&state=...&code_challenge=...
Auth -> WeChat: 公众号网页授权或开放平台扫码登录
WeChat -> Auth: callback with code
Auth: 换 openid/unionid，创建或绑定用户
Auth -> App: redirect_uri?code=...&state=...
App -> Auth: POST /oauth/token with code + code_verifier
Auth -> App: access_token + refresh_token + id_token
App -> Auth: GET /userinfo
```

微信内浏览器：

- 使用公众号网页授权 `snsapi_userinfo`。
- 公众号后台配置网页授权域名：统一登录域名，例如 `auth.3dugc.com`。

桌面浏览器：

- 优先使用微信开放平台网站应用 `snsapi_login`。
- 如果暂时没有网站应用，可保留旧式公众号二维码关注/扫码事件登录作为过渡，但不要作为长期主方案。

小程序：

- 小程序调用 `wx.login` 得到 code。
- Auth service 通过小程序 AppID/AppSecret 换取 `openid/session_key/unionid`。
- 有 `unionid` 时合并到同一个用户；没有 unionid 时先保存小程序 `openid`，后续补全。

## 数据模型

核心表：

```text
auth_users
  id
  primary_unionid
  display_name
  avatar_url
  status
  created_at
  updated_at

auth_identities
  id
  user_id
  provider                  # wechat_official_account / wechat_open_platform / wechat_mini_program / phone / email
  provider_app_id
  openid
  unionid
  profile_json
  created_at
  updated_at
  unique(provider, provider_app_id, openid)
  index(unionid)

oauth_clients
  id
  client_id
  client_secret_hash        # public SPA client 可为空
  name
  allowed_redirect_uris_json
  allowed_origins_json
  scopes_json
  status
  created_at
  updated_at

oauth_authorization_codes
  code_hash
  client_id
  user_id
  redirect_uri
  code_challenge
  code_challenge_method
  scopes_json
  expires_at
  consumed_at

oauth_refresh_tokens
  token_hash
  client_id
  user_id
  device_id
  scopes_json
  expires_at
  revoked_at
  created_at

auth_sessions
  id
  user_id
  login_method
  ip
  user_agent
  expires_at
  revoked_at
  created_at

auth_audit_logs
  id
  user_id
  event
  client_id
  ip
  user_agent
  metadata_json
  created_at
```

## API Surface

公开 OAuth：

```text
GET  /oauth/authorize
POST /oauth/token
POST /oauth/revoke
GET  /.well-known/openid-configuration
GET  /.well-known/jwks.json
GET  /userinfo
POST /logout
```

微信登录：

```text
GET  /login/wechat/offiaccount
GET  /login/wechat/offiaccount/callback
GET  /login/wechat/website
GET  /login/wechat/website/callback
POST /login/wechat/miniprogram
```

管理端：

```text
GET  /admin/users
GET  /admin/users/:id
GET  /admin/clients
POST /admin/clients
PATCH /admin/clients/:id
POST /admin/users/:id/merge
POST /admin/users/:id/disable
```

## 与 3D Model Optimizer 集成

短期：

- 保留当前 `3dugc.com` 内置 `WEB_AUTH_*` token。
- 新增 `AUTH_SERVICE_ISSUER`、`AUTH_SERVICE_CLIENT_ID`、`AUTH_SERVICE_CLIENT_SECRET`。
- 前端登录按钮跳到统一登录中心。
- 回调后 `3dugc.com` 后端交换 code，拿 `userinfo`。
- 用 `unionid` 或 auth user id 绑定本服务钱包用户。

长期：

- `3dugc.com` 不再直接配置公众号 AppSecret。
- 钱包用户表增加 `auth_user_id`，并把现有 `wechat_openid/unionid` 迁移为外部身份快照。
- 其他重后端任务服务复用同一 auth user id。

## 迁移步骤

1. 新建 `gdgeek/unified-auth` 或 `3dugc/auth-service` 仓库。
2. 初始化 Fastify + TypeScript + Prisma + Docker。
3. 建表并接入 TDSQL-C MySQL、Redis。
4. 实现 OAuth Client 注册、Authorization Code + PKCE。
5. 实现公众号网页授权，先接入 `wx6f81800f15c9a88c`。
6. 实现 `unionid` 合并策略。
7. 给 `3dugc.com` 接入统一登录中心。
8. 给现有业务站点接入统一登录中心。
9. 从旧 Yii2 auth 导出 `wechat` 表，按 `unionid/openid` 导入 `auth_identities`。
10. 观察一段时间后下线旧 Yii2 auth。

## 无痛替换 bujiaban.com 的策略

`bujiaban.com` 已经依赖旧 Yii2 auth 做登录/注册，因此第一阶段不能要求它立刻改 OAuth。新 auth service 必须先提供旧接口兼容层。

旧接口兼容层：

```text
GET  /v1/wechat/qrcode
GET  /v1/wechat/refresh?token=<scan_token>
GET  /v1/wechat
POST /v1/wechat
GET  /v1/wechat/menu
GET  /v1/wechat/check
```

兼容返回：

```json
{
  "success": true,
  "message": "signin",
  "token": "<legacy-login-token>"
}
```

关键约束：

- `GET /v1/wechat/qrcode` 返回结构必须兼容旧前端。
- `GET /v1/wechat/refresh` 的 `signin/signup/token` 语义必须兼容旧前端。
- 旧 token 先继续用随机字符串，存入 `legacy_login_tokens`，让 `bujiaban.com` 无需立刻改 token 解析方式。
- 新服务内部同时创建标准 OAuth/OIDC 用户与身份，后续再让 `bujiaban.com` 切换到标准授权码模式。
- 公众号消息推送 URL 可以继续使用 `https://auth.bujiaban.com/v1/wechat`，域名切流后由新服务接管。

推荐灰度路线：

1. 部署新服务到 `auth-next.bujiaban.com`。
2. 从旧 Yii2 auth 导出用户和微信身份，只导入长期身份，不迁移过期扫码 token。
3. 新服务实现旧接口兼容层，并用同一个公众号 AppID/AppSecret 生成二维码。
4. 用测试页面调用 `auth-next.bujiaban.com/v1/wechat/qrcode` 和 `refresh` 验证扫码注册/登录。
5. 在短维护窗口把公众号“消息推送 URL”临时切到 `auth-next.bujiaban.com/v1/wechat`，做真实扫码事件验证。
6. 验证通过后，把 `auth.bujiaban.com` 反向代理或 DNS 切到新服务。
7. 保留旧 Yii2 auth 只读待命，出现问题可把域名切回旧服务。
8. 稳定一段时间后，`bujiaban.com` 前端再升级到标准 OAuth Authorization Code + PKCE。

兼容数据表：

```text
legacy_scan_tokens
  token
  openid
  scene
  expires_at
  consumed_at
  created_at

legacy_login_tokens
  token_hash
  user_id
  openid
  unionid
  client_hint
  expires_at
  revoked_at
  created_at
```

切换前必须确认：

- `bujiaban.com` 当前是怎么保存登录态：只保存 `token`，还是会回调 auth API 校验 token。
- 除了 `qrcode/refresh`，是否还有用户资料、退出登录、token 校验等隐藏接口。
- 旧 Yii2 数据库中 `wechat.user_id` 是否已经和 `user` 表强绑定。
- 公众号 AppSecret 是否能复用，避免重置影响旧站。
- `auth.bujiaban.com` 当前部署在哪里，Traefik/Nginx/DNS 谁控制切流。

## 风险和决策

- 如果重置公众号 AppSecret，会影响旧站点；迁移前必须拿到现有 AppSecret 或同时改旧站配置。
- 如果只用公众号网页授权，电脑浏览器扫码登录体验不如开放平台网站应用；桌面端长期建议申请网站应用。
- `unionid` 只有在公众号/小程序绑定同一开放平台主体且用户满足微信返回条件时才稳定可用；仍要保留 `openid` 维度。
- 业务站点不要直接接触微信 AppSecret，减少密钥扩散。
- 统一登录中心必须严格校验 `redirect_uri`，避免开放跳转。
