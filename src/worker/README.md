# Worker Runtime

This directory is reserved for the Docker worker runtime.

Responsibilities:

- Consume queue messages.
- Respect `WORKER_CONCURRENCY` and expose worker slots.
- Download input models from COS or local storage.
- Run the extracted optimization job runner.
- Upload optimized GLB, reports and log summaries.
- ACK queue messages only after durable success.
- Support draining before Spot shutdown or planned scale-in.
- Renew a per-job lease while processing, and let another worker retry the job if the lease expires.
- Poll Tencent Cloud Spot termination metadata and stop claiming new work when an interruption notice appears.
- Write worker heartbeat snapshots to local JSON, MySQL or Postgres, matching the configured state store.
- Exit after `WORKER_IDLE_EXIT_SECONDS` when disposable elastic CVMs should stop after the queue drains.

Each worker slot processes one model at a time. A single CVM can run multiple slots when CPU and memory allow it.

Important settings for interruptible workers:

```text
JOB_LEASE_SECONDS=300
EXPIRED_JOB_RECOVERY_INTERVAL_SECONDS=30
WORKER_SPOT_TERMINATION_CHECK_URL=http://metadata.tencentyun.com/latest/meta-data/spot/termination-time
WORKER_SPOT_TERMINATION_POLL_MS=5000
```

When a Spot CVM disappears mid-task, the unacked CMQ message becomes visible again. The next worker can reclaim the job once its lease expires, so local scratch loss does not leave the job stuck in `processing`.
