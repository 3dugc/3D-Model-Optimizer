# Worker Runtime

This directory is reserved for the Docker worker runtime.

Planned responsibilities:

- Consume queue messages.
- Respect `WORKER_CONCURRENCY` and expose worker slots.
- Download input models from COS or local storage.
- Run the extracted optimization job runner.
- Upload optimized GLB, reports and log summaries.
- ACK queue messages only after durable success.
- Support draining before Spot shutdown or planned scale-in.

Each worker slot processes one model at a time. A single CVM can run multiple slots when CPU and memory allow it.
