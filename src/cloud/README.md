# Cloud Adapters

This directory is reserved for Tencent Cloud integration boundaries.

Planned adapters:

- COS storage provider for signed upload/download and object metadata.
- Queue provider for TDMQ/CMQ message publish, consume, ACK, retry and dead-letter behavior.
- Batch provider for one-off Docker worker jobs.
- CVM/Auto Scaling provider for Spot worker pools when Batch is not used.
- Task-type metadata must pass through all cloud messages so the same platform can run more than model optimization.

The current service must keep working without Tencent Cloud credentials. Cloud adapters should be selected through configuration and have local/fake implementations for development.
