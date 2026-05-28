# Accounts

This module owns Web user identity, wallet balances, recharge orders, wallet ledger entries, and per-job wallet charges.

Current scope:

- WeChat user upsert by `openid` / `unionid`.
- WeChat OAuth authorize/callback flow for Official Account web auth and Open Platform website QR login.
- Signed Web user bearer token for the frontend.
- Wallet cash balance, frozen balance, and ledger.
- Recharge order creation and mock paid settlement for local development.
- Paid Web job creation with a `100` cent hold.
- Worker-side settlement on success and release on final system failure.

Production WeChat login requires `WECHAT_OAUTH_APP_SECRET` and a WeChat-authorized callback domain. When WeChat returns `unionid`, the account store persists it so future mini program users can be merged under the same account.
