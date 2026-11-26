# Drawplate

A local-first, zero-dependency developer suite built on native Node.js ESM (`node:sqlite`, `node:http`, `node:test`), Browser WebGL2 + Web AudioWorklet, and C++20. Everything runs offline on localhost with zero runtime npm packages and zero telemetry.

## Suite Overview

| Tool | Domain | Runtime | Core Capabilities |
| :--- | :--- | :--- | :--- |
| **Subpass** | Graphics / Shaders | WebGL2 + Node CLI | 3-pass FBO shader pipeline (`geometry`, `bloom`, `tonemap`), live GLSL ES 3.00 hot reload with line-numbered compile errors, static GLSL/WGSL analyzer |
| **Cleave** | Code Diff & Merge | Node CLI + Browser ESM | Structural AST move-aware diff (`similarity >= 0.65`) and 3-way merge across JS/TS, Rust, Python, Go, and C/C++, plus Eugene Myers line diff |
| **Cadastre** | Code Index & MCP | `node:sqlite` + Browser ESM | Single-file SQLite index with incremental mtime/SHA-256 updates, 128-dim `Int8Array` vectors + BM25 + call-graph hybrid ranking, stdio JSON-RPC 2.0 MCP server |
| **Slewbox** | Audio DSP | Web AudioWorklet + C++20 CLI | Lock-free 48 kHz / 128-frame modular & granular synth (`saw`, `granular`, `fm`, `sub`), Chamberlin SVF, PCM16 stereo WAV encoder, 39.4 KB native C++20 renderer |
| **Tapeline** | HTTP Proxy & Diff | `node:http` + Browser ESM | Loopback HTTP record/replay reverse proxy, deterministic sorted JSON cassettes, offline cache replay (`X-Tapeline-Replay: hit`), recursive JSON schema drift & latency diff |

[Live workbench](https://aarushvan.github.io/drawplate/workbench.html)

### Standalone repositories

- **Cadastre v0.1.0** provides an offline, standard-library Go indexer and stdio MCP server. [GitHub repository](https://github.com/aarushvan/cadastre)
- **Cleave v0.1.1** ships a zero-dependency Go CLI for structural diff and three-way merge. [GitHub repository](https://github.com/aarushvan/cleave)
- **Slewbox v0.1.0** pairs a C++20 renderer with a browser AudioWorklet studio. [GitHub repository](https://github.com/aarushvan/slewbox)
- **Subpass v0.1.0** provides a live-reloading shader studio and a zero-dependency Node CLI. [GitHub repository](https://github.com/aarushvan/subpass)
- **Tapeline v0.2.0** ships a Go CLI for YAML cassette recording, offline replay, schema drift diff, and a browser waterfall. [GitHub repository](https://github.com/aarushvan/tapeline)

## Quickstart

Use Node.js 22.13 or newer. Building the native Slewbox CLI and running its tests also require a C++20 compiler. Set `CXX=g++` if you use GCC. No npm installation is required.

```bash
# 1. Build the native C++20 Slewbox WAV renderer
npm run build:native

# 2. Test all five tools and the unified CLI
npm test

# 3. Run live benchmarks across all 5 tools on this repository
npm run bench

# 4. Launch the static showcase + live Interactive Workbench + local JSON API
npm run serve
# Site:       http://127.0.0.1:8080/index.html
# Workbench:  http://127.0.0.1:8080/workbench.html
# Health API: http://127.0.0.1:8080/api/health
```

## CLI Reference (`bin/drawplate.mjs`)

Invoke via `node bin/drawplate.mjs <command>` or link globally with `npm link` to run `drawplate <command>`.

### Platform Commands

```bash
# Serve index.html, workbench.html, packages/*, data/*, and live /api/* endpoints
node bin/drawplate.mjs serve --port 8080 --host 127.0.0.1

# Run live benchmarks across Cleave, Cadastre, Slewbox, Tapeline, and Subpass
node bin/drawplate.mjs bench [--runs 15] [--json] [--out bench.json]

# Export the Cadastre index of packages/ and bin/ to data/cadastre-snapshot.json
node bin/drawplate.mjs snapshot [--out data/cadastre-snapshot.json]
```

### Subpass (GLSL/WGSL Analyzer & Presets)

```bash
node bin/drawplate.mjs subpass presets [--json]
node bin/drawplate.mjs subpass check pbr_sphere [--json]
node bin/drawplate.mjs subpass inspect path/to/shader.glsl [--json]
```

### Cleave (AST Move Diff & 3-Way Merge)

```bash
node bin/drawplate.mjs cleave diff before.mjs after.mjs [--mode ast|line] [--lang js] [--json]
node bin/drawplate.mjs cleave merge base.mjs left.mjs right.mjs [--lang js] [--out merged.mjs] [--json]
```

### Cadastre (Local SQLite Hybrid Indexer & MCP Server)

```bash
node bin/drawplate.mjs cadastre index . --db .drawplate/cadastre.sqlite [--force] [--json]
node bin/drawplate.mjs cadastre query "moved function ast diff" --db .drawplate/cadastre.sqlite [--mode hybrid|graph|lexical] [--limit 10] [--json]
node bin/drawplate.mjs cadastre callers diffAst --db .drawplate/cadastre.sqlite [--depth 3] [--callees] [--json]
node bin/drawplate.mjs cadastre symbol diffAst --db .drawplate/cadastre.sqlite [--json]
node bin/drawplate.mjs cadastre stats --db .drawplate/cadastre.sqlite [--json]
node bin/drawplate.mjs cadastre export-json data/cadastre-snapshot.json --db .drawplate/cadastre.sqlite
node bin/drawplate.mjs cadastre mcp --db .drawplate/cadastre.sqlite
```

### Slewbox (DSP Patches & 48 kHz WAV Renderer)

```bash
node bin/drawplate.mjs slewbox patches [--json]
node bin/drawplate.mjs slewbox render --patch saw --note 60 --seconds 1.5 --out saw.wav [--native] [--json]
```

### Tapeline (HTTP Record/Replay Proxy & Cassette Diff)

```bash
node bin/drawplate.mjs tapeline record --target http://127.0.0.1:4000 --port 8787 --out cassette.json
node bin/drawplate.mjs tapeline replay --cassette data/tapeline-cassette-v1.json --port 8788
node bin/drawplate.mjs tapeline inspect data/tapeline-cassette-v1.json [--json]
node bin/drawplate.mjs tapeline diff data/tapeline-cassette-v1.json data/tapeline-cassette-v2.json [--json] [--fail-on-breaking]
```

## MCP Server Setup (Claude Desktop / Cursor / Antigravity)

Cadastre ships a newline-delimited JSON-RPC 2.0 stdio MCP server exposing four tools: `cadastre_search`, `cadastre_callers`, `cadastre_symbol`, and `cadastre_stats`.

First build your local index:

```bash
node bin/drawplate.mjs cadastre index . --db .drawplate/cadastre.sqlite
```

Then register Drawplate Cadastre in your MCP client config:

```json
{
  "mcpServers": {
    "drawplate-cadastre": {
      "command": "node",
      "args": [
        "/absolute/path/to/sota-projects-showcase/bin/drawplate.mjs",
        "cadastre",
        "mcp",
        "--db",
        "/absolute/path/to/sota-projects-showcase/.drawplate/cadastre.sqlite"
      ]
    }
  }
}
```

## Live Workbench (`workbench.html`)

Open `http://127.0.0.1:8080/workbench.html` via `npm run serve` (or jump directly to any tool with `#subpass`, `#cleave`, `#cadastre`, `#slewbox`, `#tapeline`, or keyboard shortcuts `1`-`5`):

- **Local API mode** (`drawplate serve`): Cadastre searches the live `.drawplate/cadastre.sqlite` index via `/api/cadastre/*`, Cleave can run both in-browser and via `/api/cleave/diff`, and Tapeline lists cassettes from `/api/tapeline/cassettes`.
- **Static browser mode** (any static HTTP host): Every tool still runs locally in the browser using pure isomorphic ESM imports from `packages/*` and the real bundled fixtures in `data/cadastre-snapshot.json`, `data/tapeline-cassette-v1.json`, and `data/tapeline-cassette-v2.json`.

## Reference Benchmarks

Measured before the release handoff with `node bin/drawplate.mjs bench` on Node `v26.9.0` (`darwin/arm64`, Apple M5, `runs=15`, zero runtime npm dependencies):

| Tool | Metric | Measured Result |
| :--- | :--- | :--- |
| **Cleave** | AST diff, moved + edited function (preset) | `0.11 ms` (1 moved block, 8 lines saved) |
| **Cleave** | AST diff, 480-line real file (`store.mjs`, 1 moved block) | `1.467 ms` (1 moved block, 70 lines saved) |
| **Cleave** | Myers line diff, same 480-line real file | `0.067 ms` |
| **Cleave** | 3-way structural merge, move + edit (preset) | `0.295 ms` (0 conflicts) |
| **Cadastre** | Cold SQLite index (`packages/` + `bin/`: 24 files, 10,450 lines) | `71.1 ms` (282 symbols, 1,456 edges) |
| **Cadastre** | Incremental re-index (no changes) | `3.72 ms` (24 files skipped) |
| **Cadastre** | Hybrid int8 + BM25 query | `0.232 ms` median (`0.358 ms` p95) |
| **Cadastre** | Lexical BM25 query | `0.19 ms` median |
| **Cadastre** | Caller graph trace (depth 3) | `0.007 ms` median |
| **Cadastre** | SQLite database footprint (WAL checkpointed) | `808 KB` (128-dim int8 vectors) |
| **Slewbox** | Native C++20 CLI binary (`clang++ -std=c++20 -O2`) | `40,376 bytes` (`39.4 KB`) |
| **Slewbox** | Native 1.5 s stereo 48 kHz render (`saw` / `granular` / `fm`) | `1.208 ms` / `1.349 ms` / `1.715 ms` median (72,000 frames) |
| **Slewbox** | JS reference 1.5 s stereo 48 kHz render (`saw`) | `4.56 ms` median (72,000 frames) |
| **Tapeline** | Loopback HTTP replay (300 requests, 6 recorded routes) | `0.076 ms` median (`0.2 ms` p95, `10,552 req/s`, 0 misses) |
| **Subpass** | Static analysis of 6 built-in shaders (630 GLSL lines) | `0.609 ms` median total (all valid) |
| **Repo** | Source footprint (`packages/` + `bin/`, 24 files) | `10,426 LOC` (`323.9 KB`), `0` runtime npm deps |

## Documentation & License

- See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module boundary map, storage schemas, DSP architecture, and local server API specification.
- See [docs/DEPLOY.md](docs/DEPLOY.md) for GitHub Pages, Docker, Fly.io, and Render.
- See [docs/ENGINEERING_NOTES.md](docs/ENGINEERING_NOTES.md) for concise engineering notes across all five tools.
- Licensed under the [MIT License](LICENSE).

Brand icon attribution is recorded in [assets/icons/icons-credits.json](assets/icons/icons-credits.json).
