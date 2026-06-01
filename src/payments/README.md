# Payments

This directory contains payment gateway adapters that are intentionally separate from billing and account business logic.

Responsibilities:

- Define the common `PaymentProvider` contract used by billing and wallet flows.
- Provide a mock provider for local development.
- Provide the WeChat Pay Native API v3 provider, including request signing, order query, callback signature verification, and callback resource decryption.

Payment providers must never mark orders paid directly. They only return verified provider facts to the caller; billing or account services decide how to update local order, wallet, and job state.
