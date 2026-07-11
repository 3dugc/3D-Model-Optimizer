# 3D Model Optimizer

Because your 3D models aren't going to lose weight on their own.

A high-performance optimisation service that takes your bloated, overweight 3D models and puts them through a rather aggressive diet programme. Supports a frankly unreasonable number of formats, fixes geometry that should never have existed in the first place, and compresses everything until it begs for mercy.

[![CI](https://github.com/3dugc/3D-Model-Optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/3dugc/3D-Model-Optimizer/actions/workflows/ci.yml)
[![Docker](https://github.com/3dugc/3D-Model-Optimizer/actions/workflows/docker.yml/badge.svg)](https://github.com/3dugc/3D-Model-Optimizer/actions/workflows/docker.yml)

## What It Does (Since You Asked)

- **Format Conversion**: GLB / GLTF / OBJ / STL / DAE / FBX / USDZ / STEP / PRT / CATIA / ASM → GLB. Twelve input formats, one output. Democracy was never the point.
- **Geometry Repair**: Automatically fixes NaN vertices, invalid normals, and corrupted tangents — the sort of things that make rendering engines quietly weep.
- **Draco Compression**: Shrinks geometry data by 5–10x. Your vertices had it coming.
- **Texture Compression**: KTX2 (ETC1S/UASTC). Because uncompressed textures are a cry for help.
- **Mesh Optimisation**: Decimation, merging, quantisation, and general tidying up of the crime scene.
- **Presets**: Fast / Balanced / Maximum — for when you can't be bothered to think about compression levels.
- **Async Progress**: Elastic worker jobs with status polling so large models do not pin the web process.
- **Security**: Helmet.js headers + API Key auth. We're not animals.
- **Structured Logging**: Pino JSON logs. For the sort of person who finds comfort in structured data.
- **Web UI**: Bootstrap 5 with Three.js dual-view comparison. Before and after photos, like a weight loss advert.
- **REST API**: Swagger docs included. We're civilised.

## Getting Started

### Full Async Docker Stack (Recommended)

```bash
docker compose -f docker-compose.cloud.yml up --build -d
```

- Web UI: http://localhost:3000
- This starts MySQL, the API, payment service, Worker, and Dispatcher, so async jobs can actually complete.
- API docs are disabled by default when `NODE_ENV=production`; set `ENABLE_API_DOCS=true` only for a private development deployment.
- Docker image platform: `linux/amd64`. The optional USDZ/FBX/DAE/KTX toolchain relies on amd64 binaries and wheels; Apple Silicon hosts run this image through Docker emulation.
- Optional CAD support is enabled by default but capped during image build. Use `--build-arg INSTALL_CAD_SUPPORT=false` to skip STEP/CAD packages, or tune `--build-arg CAD_INSTALL_TIMEOUT_SECONDS=240` for slower networks.

The shorter `docker compose up -d` command starts only the lightweight API/payment stack. It does not include a Worker and therefore is not a complete async optimization environment.

### Local Development (For the Brave)

```bash
npm install
npm run dev
# In another terminal, for async jobs:
npm run worker
```

> Local environment only supports GLB/GLTF/OBJ/STL. Everything else requires Docker and its menagerie of external tools. Sorry about that. Actually, no, we're not sorry.

## Supported Formats

| Format | Local | Docker | Conversion Tool |
|--------|:-----:|:------:|-----------------|
| GLB / GLTF | ✅ | ✅ | gltf-transform |
| OBJ | ✅ | ✅ | obj2gltf |
| STL | ✅ | ✅ | Built-in parser |
| DAE | ❌ | ✅ | COLLADA2GLTF |
| FBX | ❌ | ✅ | FBX2glTF |
| USDZ | ❌ | ✅ | usd-core (Python) |
| STEP / STP | ❌ | ✅ | trimesh + cadquery |
| PRT (Creo) | ❌ | ⚠️ | External CAD translator required for native files |
| CATPart / CATProduct | ❌ | ⚠️ | External CAD translator required for native files |
| ASM (Creo Assembly) | ❌ | ⚠️ | External CAD translator required for native files |

The built-in CadQuery path reliably handles STEP/STP. Proprietary PRT/CATIA/ASM files are accepted as inputs but require a compatible external translator unless they contain STEP-compatible data.

## API

### Analyse a Model

```bash
curl -X POST http://localhost:3000/api/analyze -F "file=@model.glb"
```

Find out exactly how bad things are before we intervene.

### Optimise (Async Web Wallet Job)

```bash
curl -X POST http://localhost:3000/api/v1/account/wallet/optimize-jobs \
  -H "Authorization: Bearer <web_token>" \
  -F "file=@model.glb" \
  -F 'options={"clean":{"enabled":true},"draco":{"enabled":true,"compressionLevel":7}}'
```

The response includes a `job.id`. Poll that job until `status` becomes `succeeded`.

```bash
curl -H "Authorization: Bearer <web_token>" \
  http://localhost:3000/api/v1/account/wallet/jobs/{jobId}
```

### Optimise (Preset)

```bash
curl -X POST http://localhost:3000/api/v1/account/wallet/optimize-jobs \
  -H "Authorization: Bearer <web_token>" \
  -F "file=@model.glb" \
  -F "preset=balanced"
```

Available presets: `fast`, `balanced`, `maximum`. Choose your fighter.

### External Async API

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer <api_key>" \
  -H "x-tenant-id: tenant-a" \
  -H "Content-Type: application/json" \
  -d '{"filename":"model.glb","taskType":"model.optimize","preset":"balanced"}'
```

Use `/api/v1/jobs/{jobId}/upload-grant`, `/api/v1/jobs/{jobId}/complete-upload`, and `/api/v1/jobs/{jobId}/result-url` for direct object-storage integrations.

### Legacy Sync Optimise

`POST /api/optimize` and `POST /api/optimize/stream` are intentionally retained as legacy endpoints and return `410 ASYNC_OPTIMIZATION_REQUIRED`. Use the async job endpoints above.

### Download Result

```bash
curl -H "Authorization: Bearer <web_token>" \
  -O http://localhost:3000/api/v1/account/wallet/jobs/{jobId}/result-file
```

Retained web results are also listed at:

```bash
curl -H "Authorization: Bearer <web_token>" http://localhost:3000/api/download
```

## The Pipeline (A Journey of Self-Improvement)

```
repair-input → clean → merge → simplify → quantize → draco → texture → repair-output
```

| Step | What It Does | Default |
|------|-------------|:-------:|
| repair-input | Fixes NaN vertices, dodgy normals, mangled tangents | Always |
| clean | Removes unused nodes, materials, textures — the dead weight | Optional |
| merge | Combines meshes sharing materials. Efficiency through conformity | Optional |
| simplify | Mesh decimation. Fewer triangles, fewer problems | Optional |
| quantize | Vertex attribute quantisation. Close enough is good enough | Optional |
| draco | Draco geometry compression. The main event | Optional |
| texture | KTX2 texture compression (ETC1S/UASTC) | Optional |
| repair-output | Final validation and repair. Trust, but verify | Always |

### Presets

| Preset | Philosophy | Steps |
|--------|-----------|-------|
| `fast` | Just the essentials | clean + draco (level 3) |
| `balanced` | The sensible middle ground | clean + merge + simplify (75%) + draco (level 7) + texture (ETC1S) |
| `maximum` | Scorched earth | clean + merge + simplify (50%) + draco (level 10) + texture (ETC1S) |

### Custom Options

```json
{
  "clean": { "enabled": true },
  "merge": { "enabled": true },
  "simplify": { "enabled": true, "targetRatio": 0.5, "lockBorder": false },
  "draco": { "enabled": true, "compressionLevel": 7 },
  "texture": { "enabled": true, "mode": "ETC1S" }
}
```

## Security & Performance

Because someone has to be the responsible adult.

- **Helmet.js** — security headers so browsers don't have a nervous breakdown
- **API Key Auth** — optional, for when you don't trust the general public (wise)
- **Request Timeout** — 5 minutes, then we move on with our lives
- **Gzip Compression** — response bodies compressed automatically
- **Draco Singleton** — codec reuse, because initialising WASM repeatedly is a special kind of masochism
- **Temp File Cleanup** — 1-hour expiry, 10-minute polling. We clean up after ourselves
- **Parameter Validation** — invalid values get clamped. We fix your mistakes silently
- **Structured Logging** — Pino JSON format, for log aggregation enthusiasts

## Tech Stack

- **Runtime**: Node.js 20 / TypeScript for the main optimizer API; Node.js 22 for `services/payment-service`
- **Framework**: Express.js
- **3D Engine**: @gltf-transform/core + extensions
- **Compression**: Draco3D, KTX-Software (toktx)
- **Format Conversion**: obj2gltf, FBX2glTF, COLLADA2GLTF, usd-core, trimesh, cadquery/OCP
- **Security**: Helmet.js, CORS
- **Logging**: Pino
- **Frontend**: Bootstrap 5.3, Three.js 0.160
- **Container**: Docker (linux/amd64)

## Project Structure

```
src/
├── components/          # The organs
│   ├── optimization-pipeline.ts   # Pipeline orchestration (SSE progress)
│   ├── geometry-fixer.ts          # Geometry repair (input/output stages)
│   ├── format-converter.ts        # Multi-format → GLB (12 formats)
│   ├── draco-singleton.ts         # Draco codec singleton
│   ├── resource-cleaner.ts        # Resource cleanup
│   ├── mesh-merger.ts             # Mesh merging
│   ├── mesh-simplifier.ts         # Mesh decimation
│   ├── vertex-quantizer.ts        # Vertex quantisation
│   ├── draco-compressor.ts        # Draco compression
│   └── texture-compressor.ts      # Texture compression
├── routes/              # API routes
├── cloud/               # Object storage and queue provider contracts
├── jobs/                # Async job store, state machine, service
├── database/            # Shared MySQL/Postgres state stores and migrations
├── tasks/               # Extensible heavy task registry and model.optimize handler
├── worker/              # Docker worker runtime
├── billing/             # WeChat Native/mock billing contracts
├── callbacks/           # Customer callback signing/delivery helpers
├── middleware/           # Error handling, API Key auth
├── models/              # Data models
├── utils/               # File validation, storage, logging
└── config/              # Swagger config
public/                  # Web UI
scripts/                 # Python conversion scripts
tests/                   # Unit and integration tests
```

## Cloud Architecture Roadmap

The async Tencent Cloud runtime is implemented alongside the local providers; the remaining production work is tracked separately.

- Architecture: [docs/tencent-cloud-architecture.md](docs/tencent-cloud-architecture.md)
- Implementation guide: [docs/heavy-task-platform-implementation.md](docs/heavy-task-platform-implementation.md)
- Next tasks: [docs/heavy-task-platform-next-tasks.md](docs/heavy-task-platform-next-tasks.md)
- Deployment checklist: [docs/tencent-cloud-deployment-checklist.md](docs/tencent-cloud-deployment-checklist.md)
- Spec: [.kiro/specs/tencent-cloud-elastic-optimizer](.kiro/specs/tencent-cloud-elastic-optimizer)
- Local async runtime: `POST /api/v1/jobs`, `POST /api/v1/jobs/:jobId/complete-upload`, `GET /api/v1/jobs/:jobId`, `GET /api/v1/jobs/:jobId/result-url`
- Local worker: `npm run worker` or `node dist/worker/run-worker.js`
- Docker local cloud stack: `docker compose -f docker-compose.cloud.yml up --build`
- Shared state store: production should use `STATE_STORE_PROVIDER=mysql` with `DATABASE_URL=mysql://...`; Postgres remains compatible, and local JSON is only for development fallback.
- Runtime template: `.env.cloud.example`

## Testing

```bash
npm test
```

231 tests. All passing. We checked.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

> **🤖 AI-Friendly Summary** — One-stop 3D model compression and optimisation: 12 formats to GLB (including CAD formats PRT/CATIA/ASM), with geometry repair + Draco compression + texture compression + mesh decimation. Three presets, SSE real-time progress, REST API, Docker deployment, Swagger docs. Built for agent integration, because even robots deserve nice things.
