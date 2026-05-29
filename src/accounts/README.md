# Accounts

This module owns Web user identity, wallet balances, recharge orders, wallet ledger entries, and per-job wallet charges.

Current scope:

- WeChat user upsert by `openid` / `unionid`.
- Unified auth-service login by `auth_user_id` / `unionid`.
- WeChat OAuth authorize/callback flow for Official Account web auth and Open Platform website QR login.
- Signed Web user bearer token for the frontend.
- Wallet cash balance, frozen balance, and ledger.
- Recharge order creation and mock paid settlement for local development.
- Paid Web job creation with a `100` cent hold.
- Worker-side settlement on success and release on final system failure.

Production login should use the standalone auth-service by default:

```text
AUTH_SERVICE_ENABLED=true
AUTH_SERVICE_BASE_URL=https://auth.bujiaban.com
AUTH_SERVICE_LOGIN_PATH=/login/3dugc
AUTH_SERVICE_CLIENT_ID=3dugc-web
AUTH_SERVICE_REDIRECT_URI=https://3dugc.com/auth/callback
```

The frontend starts OAuth with PKCE through `https://auth.bujiaban.com/login/3dugc`. On desktop it first asks the local backend to proxy `/login/3dugc/widget-config`, renders either the WeChat website widget or the auth-service official-account QR image in a modal, polls scan status when needed, then exchanges the returned code and binds the local wallet user by `auth_user_id`. Legacy direct WeChat OAuth (`WECHAT_OAUTH_*`) remains as a fallback path.
