# Drawplate Architecture

Drawplate is structured as five self-contained, zero-dependency packages unified by a single Node.js ESM CLI (`bin/drawplate.mjs`), a live local server (`bin/serve.mjs`), a reproducible benchmark harness (`bin/bench.mjs`), and a browser-native Interactive Workbench (`workbench.html`).

## Design Principles

1. **Zero Runtime npm Dependencies**: Every package uses only built-in Web APIs (WebGL2, Web AudioWorklet, WebMIDI, Canvas2D), Node.js built-ins (`node:sqlite`, `node:http`, `node:https`, `node:fs`, `node:crypto`, `node:test`), and standard C++20 (`<cmath>`, `<cstdint>`, `<fstream>`).
2. **Strict Isomorphic Browser/Node Split**: Pure computation modules contain zero static `node:` imports so `workbench.html` imports the exact same ES modules executed by the CLI and test suite.
3. **Deterministic Local Storage**: All persistent state stays on disk in inspectable formats: SQLite WAL databases (`.drawplate/cadastre.sqlite`), sorted Git-friendly JSON cassettes (`data/tapeline-cassette-*.json`), JSON index snapshots (`data/cadastre-snapshot.json`), and standard 48 kHz PCM16 RIFF `.wav` files.

## Repository Layout

```text
.
├── bin/
│   ├── drawplate.mjs          # Unified CLI dispatcher (subpass|cleave|cadastre|slewbox|tapeline|serve|bench|snapshot)
│   ├── serve.mjs              # Local static HTTP server + live JSON API routes (/api/*)
│   └── bench.mjs              # Live benchmark suite measuring all 5 tools on the actual repo
├── packages/
│   ├── subpass/
│   │   ├── shaders.mjs        # Browser+Node: 3 scene GLSL ES 3.00 shaders + 3 post-pass shaders
│   │   ├── profiler.mjs       # Browser: WebGL2 3-pass FBO pipeline + timer queries + Canvas2D fallback
│   │   ├── analyzer.mjs       # Browser+Node: Static GLSL/WGSL parser, validator, complexity estimator
│   │   └── index.mjs          # Public exports + runSubpassCli
│   ├── cleave/
│   │   ├── parser.mjs         # Browser+Node: Multi-language tokenizer & block parser (JS/TS/Rust/Py/Go/C++)
│   │   ├── diff.mjs           # Browser+Node: Eugene Myers line diff + AST move-aware diff
│   │   ├── merge.mjs          # Browser+Node: 3-way structural merge with moved-block reconciliation
│   │   └── index.mjs          # Public exports + presets + runCleaveCli (dynamic node:fs import)
│   ├── cadastre/
│   │   ├── extract.mjs        # Browser+Node: Symbol/edge extractor + 128-dim signed Int8Array embeddings
│   │   ├── search.mjs         # Browser+Node: Hybrid cosine + BM25 + graph boost + caller/callee BFS
│   │   ├── store.mjs          # Node: node:sqlite DatabaseSync WAL store + incremental mtime/sha256 indexer
│   │   ├── mcp.mjs            # Node: Stdio JSON-RPC 2.0 MCP server (4 tools)
│   │   └── index.mjs          # Public exports + runCadastreCli
│   ├── slewbox/
│   │   ├── slewbox-worklet.js # Browser AudioWorkletProcessor: lock-free 8-voice DSP loop
│   │   ├── wav.mjs            # Browser+Node: Pure JS reference DSP renderer + PCM16 RIFF WAV encoder
│   │   ├── engine.mjs         # Browser: AudioContext, AnalyserNode, WebMIDI, patch JSON, WAV export
│   │   ├── native/
│   │   │   ├── slewbox_cli.cpp # Standalone C++20 48 kHz stereo WAV synthesizer
│   │   │   └── slewbox-cli     # Compiled native binary (39.4 KB arm64 Mach-O)
│   │   └── index.mjs          # Public exports + runSlewboxCli
│   └── tapeline/
│       ├── cassette.mjs       # Browser+Node: Deterministic cassette schema, JSON schema diff, waterfall
│       ├── proxy.mjs          # Node: node:http/https loopback record proxy & offline replay proxy
│       └── index.mjs          # Public exports + runTapelineCli
├── data/
│   ├── cadastre-snapshot.json # Real Cadastre index snapshot of packages/ + bin/ (24 files, 282 symbols, 1,456 edges)
│   ├── tapeline-cassette-v1.json # Real recorded v1 HTTP cassette (6 routes)
│   └── tapeline-cassette-v2.json # Real recorded v2 HTTP cassette (schema drift + latency regression)
├── tests/                     # node:test suites (33 tests total across all packages & CLI)
├── index.html                 # Showcase landing page
└── workbench.html / .css / .js # Full-screen interactive browser workbench importing packages/* directly
```

## Per-Tool Technical Design

### 1. Subpass (`packages/subpass/`)

- **Render Pipeline (`profiler.mjs`)**: Manages a WebGL2 context with ping-pong framebuffers (`RGBA16F` when `EXT_color_buffer_float` is available, `RGBA8` fallback) across three toggleable passes:
  1. `geometry`: Executes the active scene fragment shader (`pbr_sphere`, `sdf_lattice`, `flow_field`, or live user-edited GLSL ES 3.00).
  2. `bloom`: Runs Karis-weighted luminance threshold extraction (`BLOOM_EXTRACT_GLSL`) followed by separable 9-tap Gaussian blur (`BLOOM_BLUR_GLSL`).
  3. `tonemap`: Applies ACES filmic tone mapping, vignette, and sRGB gamma (`TONEMAP_ACES_GLSL`).
- **Timing & Diagnostics**: Uses `EXT_disjoint_timer_query_webgl2` for per-pass GPU timings with `performance.now()` fallback, parses WebGL shader compiler logs into `{ line, message }` arrays for inline editor markers, and degrades cleanly to a Canvas2D preview when WebGL2 is unavailable.
- **Static Analyzer (`analyzer.mjs`)**: Runs in both browser and Node CLI to extract uniforms, samplers/textures, WGSL `@workgroup_size`, function declarations, branch/instruction complexity tiers, and brace/semicolon/entry-point diagnostics.

### 2. Cleave (`packages/cleave/`)

- **Multi-Language Structural Parser (`parser.mjs`)**: Tokenizes JS/TS, Rust, Python, Go, and C/C++ source code while stripping comments/strings accurately, then extracts brace-delimited (or indentation-delimited for Python) top-level and nested symbols with normalized token streams and 64-bit hashes.
- **Move-Aware AST Diff (`diff.mjs`)**: Runs Eugene Myers `O((N+M)D)` shortest-edit-script diff for line hunks and pairs relocated blocks across files using exact token-hash matching first and normalized token Jaccard/dice similarity (`>= 0.65`) second for moved-and-edited functions, computing inner line edits and net churn saved.
- **3-Way Structural Merge (`merge.mjs`)**: Detects when one branch relocates a symbol while the other branch edits its body, applying the body edit cleanly at the new location and emitting standard conflict markers only for true overlapping edits or delete/modify collisions.

### 3. Cadastre (`packages/cadastre/`)

- **Extraction & Quantized Embeddings (`extract.mjs`)**: Extracts functions, classes, methods, exports, constants, imports, and caller-to-callee edges. Each symbol's identifier tokens and character trigrams are feature-hashed into a deterministic 128-dimensional signed `Int8Array` via absmax quantization (`[-127, 127]`), avoiding floating-point model downloads and external vector stores.
- **Hybrid Scoring (`search.mjs`)**: Combines cosine similarity over `Int8Array` vectors, Okapi BM25 lexical scores, exact identifier match boosts, and 1-hop call-graph neighbor boosts. Also provides bounded-depth BFS traversal (`traceCallers`, `traceCallees`).
- **SQLite Storage (`store.mjs`)**: Persists `meta`, `files`, `symbols`, `edges`, and `vectors` (raw `BLOB`) in a single WAL-mode SQLite file via Node 26's built-in `node:sqlite` (`DatabaseSync`). Re-indexing skips unchanged files using `(mtime_ms, sha256)` checks and cascades deletes on removed files.
- **MCP Server (`mcp.mjs`)**: Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) exposing `cadastre_search`, `cadastre_callers`, `cadastre_symbol`, and `cadastre_stats`.

### 4. Slewbox (`packages/slewbox/`)

- **Real-Time Browser Synth (`slewbox-worklet.js`, `engine.mjs`)**: Runs an 8-voice lock-free `AudioWorkletProcessor` at 48 kHz / 128-sample render quanta with zero heap allocations inside `process()`. Voices implement Poly-BLEP anti-aliased dual detuned sawtooth + sub (`saw`), a 2048-sample wavetable granular cloud scheduler (`granular`), and a 2-operator FM bell (`fm`), routed through a 2x oversampled Chamberlin State-Variable Filter, ADSR envelope, and `tanh` soft clipper.
- **Offline Renderers (`wav.mjs`, `native/slewbox_cli.cpp`)**: Shares a deterministic pure-JS PCM16 stereo RIFF WAV encoder for browser download and Node CLI, paired with a standalone C++20 CLI (`slewbox-cli`, compiled with `clang++ -std=c++20 -O2`, 39.4 KB) rendering 1.5 s of 48 kHz stereo audio in ~1.2 ms.

### 5. Tapeline (`packages/tapeline/`)

- **Deterministic Cassette Format (`cassette.mjs`)**: Canonicalizes request/response headers in lowercase alphabetical order, parses JSON bodies with sorted keys for stable Git diffs, and stores per-entry `ttfbMs` and `totalMs`.
- **Schema & Latency Diff**: Matches routes by `METHOD path` (with canonicalized query fallback), recursively diffs nested JSON objects and arrays to flag breaking type changes and key removals vs additive fields, tracks HTTP status regressions, and computes signed latency deltas (`totalDeltaPct`, `ttfbDeltaPct`).
- **Loopback Proxies (`proxy.mjs`)**:
  - `startRecordProxy`: Forwards HTTP/HTTPS traffic via `node:http`/`node:https`, strips `accept-encoding` for readable JSON capture, measures `process.hrtime.bigint()` TTFB and total duration, and writes cassettes deterministically on entry and graceful shutdown.
  - `startReplayProxy`: Serves recorded cassettes completely offline with zero upstream calls, returning `X-Tapeline-Replay: hit` on match or `404` diagnostic JSON with `X-Tapeline-Replay: miss` and available route hints.

## Local Server API (`bin/serve.mjs`)

`drawplate serve` serves static files with explicit MIME types and `X-Content-Type-Options: nosniff`, blocks dotfiles, `node_modules`, and `*.sqlite*` files (`403 Forbidden`), enforces root containment against path traversal, and exposes:

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Server version, Node version, uptime, active tools, and live Cadastre stats |
| `/api/cadastre/search?q=&mode=&limit=` | `GET` | Live hybrid/graph/lexical search against `.drawplate/cadastre.sqlite` |
| `/api/cadastre/callers?sym=&depth=&callees=` | `GET` | Live caller or callee graph trace |
| `/api/cadastre/stats` | `GET` | Indexed file/symbol/edge/vector counts and SQLite file size |
| `/api/cleave/diff` | `POST` | JSON `{ a, b, lang, mode }` returning real AST or Myers diff |
| `/api/tapeline/cassettes` | `GET` | Lists `data/tapeline-cassette*.json`, returns a cassette (`?name=`), or diffs two (`?before=&after=`) |

## Verification & CI

`.github/workflows/ci.yml` runs on every push and pull request:
1. Compiles `packages/slewbox/native/slewbox_cli.cpp` with `-std=c++20 -O2`.
2. Executes `node --test tests/*.test.mjs` (33 tests across Subpass, Cleave, Cadastre, Slewbox, Tapeline, and the Drawplate CLI/server).
3. Runs `node bin/drawplate.mjs bench` to verify all five engines end-to-end.
