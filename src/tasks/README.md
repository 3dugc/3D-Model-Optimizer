# Heavy Task Runtime

This directory is reserved for task-type plugins used by the async backend platform.

Model optimization is the first task type, but the queue, worker slots, billing, callbacks and elastic compute design should support other heavy backend workloads later.

Planned task type contract:

- Validate task-specific input payload.
- Estimate cost and resource class.
- Build the worker command or handler name.
- Execute task-specific processing inside a worker slot.
- Produce standard result metadata and task-specific report details.

Examples of future task types:

- `model.optimize`
- `video.transcode`
- `file.convert`
- `texture.compress`
- `cad.preview`
- `ai.batch-infer`

Shared platform code should depend on this contract, not directly on model optimization details.
