# Drawplate engineering notes

## Slewbox audio render quantum

Slewbox renders 8 voices at 48 kHz in 128-sample `AudioWorkletProcessor` quanta. The zero-allocation callback creates no garbage during rendering, and the lock-free render path avoids lock waits. The 2x oversampled Chamberlin SVF uses smaller integration steps at the cost of extra filter work per quantum.

## Subpass bloom and GPU timing

Subpass runs `geometry` -> `bloom_extract` -> `bloom_blur` -> `tonemap_aces` through WebGL2 framebuffer objects. Karis weighting reduces the contribution of very bright samples to bloom so isolated fireflies spread less during blur. The same weighting can soften small, intentional highlights. `EXT_disjoint_timer_query_webgl2` measures the GPU cost of each pass, so bloom can be evaluated separately from geometry and tone mapping.

## Cleave three-way move reconciliation

Cleave uses Myers shortest edit scripts for sequence changes in its AST diff and a token similarity threshold of `>= 0.65` to match moves that include edits. If one branch moves a base function and the other edits its body, the three-way merge puts the edited body at the new location. A lower threshold can pair unrelated functions with similar tokens. A higher threshold can miss moves with larger edits.

## Cadastre search over SQLite

Cadastre stores symbols, call-graph edges, and 128-dimensional signed `Int8Array` embeddings in one SQLite file via Node 26's `node:sqlite`. Quantization reduces storage per embedding at the cost of precision. Hybrid search combines BM25 for lexical relevance, vector similarity for embedding proximity, and call-graph edges for relationships between functions.

## Tapeline cassette determinism and redaction

Sorted YAML keys make cassette diffs easier to review by giving recorded maps a stable key order. Tapeline redacts `Authorization`, `Cookie`, `Set-Cookie`, and `X-Api-Key` by default. That keeps the original values of those headers out of the cassette at the cost of replay fidelity for those fields. Strictly offline replay serves recorded responses from the cassette.
