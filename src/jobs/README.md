# Jobs

This directory owns the async optimization job domain.

Responsibilities:

- Job creation and idempotency.
- Job state transitions.
- Tenant limits before queueing.
- Repository interfaces for database-backed and local development modes.
- Result URL lookup after worker completion.

The default local store writes JSON files for development. When `DATABASE_URL` is set, or `STATE_STORE_PROVIDER=postgres` is used, `PostgresJobStore` creates the shared `optimizer_jobs` table and uses row locks with `FOR UPDATE SKIP LOCKED` so multiple workers can claim jobs safely.

The existing synchronous routes should call shared runner code after it is extracted, but they should not own the cloud job state machine.
