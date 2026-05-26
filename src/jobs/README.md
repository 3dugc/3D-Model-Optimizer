# Jobs

This directory owns the async optimization job domain.

Planned responsibilities:

- Job creation and idempotency.
- Job state transitions.
- Tenant limits before queueing.
- Repository interfaces for database-backed and local development modes.
- Result URL lookup after worker completion.

The existing synchronous routes should call shared runner code after it is extracted, but they should not own the cloud job state machine.
