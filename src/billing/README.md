# Billing

This directory is reserved for payment and tenant billing logic.

Planned responsibilities:

- Wechat Native payment order creation.
- Payment notification verification and decryption.
- Idempotent order state updates.
- Job queue release after successful payment.
- Future prepaid balance or subscription billing for API tenants.

Payment providers must never trust client-side payment state. Only verified provider callbacks or verified provider order queries should mark an order as paid.
