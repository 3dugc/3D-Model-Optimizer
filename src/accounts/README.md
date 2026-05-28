# Accounts

This module owns Web user identity, wallet balances, recharge orders, wallet ledger entries, and per-job wallet charges.

Current scope:

- WeChat user upsert by `openid` / `unionid`.
- Signed Web user bearer token for the frontend.
- Wallet cash balance, frozen balance, and ledger.
- Recharge order creation and mock paid settlement for local development.
- Paid Web job creation with a `100` cent hold.
- Worker-side settlement on success and release on final system failure.

Production WeChat login and WeChat Pay notification verification still require merchant and Open Platform credentials during deployment wiring.

