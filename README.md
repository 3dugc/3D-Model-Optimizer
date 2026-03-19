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
- **Real-time Progress**: SSE streaming so you can watch your model suffer step by step.
- **Security**: Helmet.js headers + API Key auth. We're not animals.
- **Structured Logging**: Pino JSON logs. For the sort of person who finds comfort in structured data.
- **Web UI**: Bootstrap 5 with Three.js dual-view comparison. Before and after photos, like a weight loss advert.
- **REST API**: Swagger docs included. We're civilised.

## Getting Started

### Docker (Recommended, Obviously)

```bash
docker compose up -d
```

- Web UI: http://localhost:3000
- API Docs: http://localhost:3000/api-docs

### Local Development (For the Brave)

```bash
npm install
npm run dev
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
| PRT (Creo) | ❌ | ✅ | trimesh + OCP |
| CATPart / CATProduct | ❌ | ✅ | trimesh + OCP |
| ASM (Creo Assembly) | ❌ | ✅ | trimesh + OCP |

## API

### Analyse a Model

```bash
curl -X POST http://localhost:3000/api/analyze -F "file=@model.glb"
```

Find out exactly how bad things are before we intervene.

### Optimise (Custom Options)

```bash
curl -X POST http://localhost:3000/api/optimize \
  -F "file=@model.glb" \
  -F 'options={"clean":{"enabled":true},"draco":{"enabled":true,"compressionLevel":7}}'
```

### Optimise (Preset)

```bash
curl -X POST http://localhost:3000/api/optimize \
  -F "file=@model.glb" \
  -F "preset=balanced"
```

Available presets: `fast`, `balanced`, `maximum`. Choose your fighter.

### SSE Real-time Progress

```bash
curl -X POST http://localhost:3000/api/optimize/stream \
  -F "file=@model.glb" \
  -F "preset=balanced"
```

Returns a Server-Sent Events stream. Each event is another step in your model's rehabilitation.

### Download Result

```bash
curl -O http://localhost:3000/api/download/{taskId}
```

### Check Status

```bash
curl http://localhost:3000/api/status/{taskId}
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

- **Runtime**: Node.js 20 / TypeScript
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
├── middleware/           # Error handling, API Key auth
├── models/              # Data models
├── utils/               # File validation, storage, logging
└── config/              # Swagger config
public/                  # Web UI
scripts/                 # Python conversion scripts
tests/                   # Unit tests (226 of them, we're thorough)
```

## Testing

```bash
npm test
```

226 tests. All passing. We checked.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

> **🤖 AI-Friendly Summary** — One-stop 3D model compression and optimisation: 12 formats to GLB (including CAD formats PRT/CATIA/ASM), with geometry repair + Draco compression + texture compression + mesh decimation. Three presets, SSE real-time progress, REST API, Docker deployment, Swagger docs. Built for agent integration, because even robots deserve nice things.
