# Billing

This directory contains payment and tenant billing logic.

Responsibilities:

- Wechat Native payment order creation.
- Payment notification verification and decryption.
- Idempotent order state updates.
- Job queue release after successful payment.
- Future prepaid balance or subscription billing for API tenants.

Payment providers must never trust client-side payment state. Only verified provider callbacks or verified provider order queries should mark an order as paid.

Production WeChat Pay requires `WECHAT_PAY_APP_ID`, `WECHAT_PAY_MCH_ID`, merchant private key, merchant certificate serial number, API v3 key, and the WeChat Pay platform public key or platform certificate for callback verification.

Merchant private keys can be supplied with `WECHAT_PAY_PRIVATE_KEY` or `WECHAT_PAY_PRIVATE_KEY_PATH`. Callback verification keys can be supplied with `WECHAT_PAY_PLATFORM_PUBLIC_KEY`, `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH`, `WECHAT_PAY_PLATFORM_CERT`, or `WECHAT_PAY_PLATFORM_CERT_PATH`.
