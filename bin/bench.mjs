// Drawplate live benchmark suite: measures all five tools on the real repository.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { CadastreStore } from '../packages/cadastre/index.mjs';
import { PRESETS, diffAst, diffLines, merge3, parseBlocks } from '../packages/cleave/index.mjs';
import { analyzeShader } from '../packages/subpass/analyzer.mjs';
import { POST_SHADERS, SHADER_PRESETS } from '../packages/subpass/shaders.mjs';
import { renderPatchToWav } from '../packages/slewbox/index.mjs';
import { startReplayProxy } from '../packages/tapeline/index.mjs';

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: round(percentile(sorted, 50), 3),
    p95Ms: round(percentile(sorted, 95), 3),
    minMs: round(sorted[0] ?? 0, 3),
    runs: sorted.length,
  };
}

function timeRuns(fn, runs, warmup = 2) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

function countLines(text) {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, exts, out);
    else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) out.push(abs);
  }
  return out;
}

function measureRepo(root) {
  const codeExts = new Set(['.mjs', '.js', '.cpp', '.glsl']);
  const groups = {
    packages: walk(path.join(root, 'packages'), codeExts),
    bin: walk(path.join(root, 'bin'), codeExts),
    tests: walk(path.join(root, 'tests'), codeExts),
  };
  const web = ['index.html', 'workbench.html', 'workbench.css', 'workbench.js']
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f));

  const loc = (files) => files.reduce((acc, f) => acc + countLines(fs.readFileSync(f, 'utf8')), 0);
  const bytes = (files) => files.reduce((acc, f) => acc + fs.statSync(f).size, 0);

  const sourceFiles = [...groups.packages, ...groups.bin];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(pkg.dependencies || {}).length;
  const devDeps = Object.keys(pkg.devDependencies || {}).length;

  return {
    version: pkg.version,
    runtimeDependencies: runtimeDeps,
    devDependencies: devDeps,
    nodeModulesPresent: fs.existsSync(path.join(root, 'node_modules')),
    packagesLoc: loc(groups.packages),
    binLoc: loc(groups.bin),
    testsLoc: loc(groups.tests),
    webLoc: loc(web),
    totalLoc: loc(groups.packages) + loc(groups.bin) + loc(groups.tests) + loc(web),
    sourceFiles: sourceFiles.length,
    sourceBytes: bytes(sourceFiles),
    webBytes: bytes(web),
  };
}

function benchCleave(root, runs) {
  const preset = PRESETS.jsMoveAndEdit;
  let presetResult;
  const presetStats = timeRuns(() => {
    presetResult = diffAst(preset.base, preset.left, 'js');
  }, runs);

  const mergeStats = timeRuns(() => merge3(preset.base, preset.left, preset.right, 'js'), runs);
  const mergeResult = merge3(preset.base, preset.left, preset.right, 'js');

  // Real file: move the largest top-level block of store.mjs to the end of the file.
  const realPath = path.join(root, 'packages/cadastre/store.mjs');
  const original = fs.readFileSync(realPath, 'utf8');
  const lines = original.split('\n');
  const blocks = parseBlocks(original, 'js');
  const topLevel = blocks.filter(
    (b) => !blocks.some((o) => o !== b && o.startLine <= b.startLine && o.endLine >= b.endLine && (o.startLine < b.startLine || o.endLine > b.endLine)),
  );
  const candidates = topLevel
    .filter((b) => b.endLine - b.startLine + 1 < lines.length * 0.4)
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine));
  let moved = null;
  let modified = original;
  if (candidates.length > 0 && candidates[0].startLine < lines.length * 0.5) {
    const blk = candidates[0];
    const startIdx = blk.startLine - 1;
    const endIdx = blk.endLine;
    const chunk = lines.slice(startIdx, endIdx);
    const rest = [...lines.slice(0, startIdx), ...lines.slice(endIdx)];
    while (rest.length && rest[rest.length - 1] === '') rest.pop();
    modified = [...rest, '', ...chunk, ''].join('\n');
    moved = { symbol: blk.name || null, lines: chunk.length };
  }
  let realResult;
  const realStats = timeRuns(() => {
    realResult = diffAst(original, modified, 'js');
  }, Math.max(3, Math.floor(runs / 2)));
  const lineStats = timeRuns(() => diffLines(original, modified), Math.max(3, Math.floor(runs / 2)));

  return {
    presetAstDiff: {
      ...presetStats,
      movedBlocks: presetResult.stats.movedBlocks,
      linesSaved: presetResult.stats.linesSaved,
    },
    presetMerge3: { ...mergeStats, hasConflicts: Boolean(mergeResult.hasConflicts) },
    realFileAstDiff: {
      ...realStats,
      file: 'packages/cadastre/store.mjs',
      fileLines: lines.length,
      movedBlock: moved,
      movedBlocks: realResult.stats.movedBlocks,
      linesSaved: realResult.stats.linesSaved,
    },
    realFileLineDiff: { ...lineStats },
  };
}

function benchCadastre(root, runs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawplate-bench-'));
  const dbPath = path.join(tmp, 'cadastre.sqlite');
  const store = new CadastreStore(dbPath);
  try {
    const t0 = performance.now();
    const summary = store.indexDirectory(root, { includePaths: ['packages', 'bin'] });
    const indexMs = performance.now() - t0;

    const t1 = performance.now();
    const again = store.indexDirectory(root, { includePaths: ['packages', 'bin'] });
    const incrementalMs = performance.now() - t1;

    const queries = [
      'moved function structural diff',
      'wav riff encoder',
      'replay proxy cassette',
      'shader compile errors',
      'sqlite incremental index',
    ];

    const tCold = performance.now();
    store.search(queries[0], { mode: 'hybrid', limit: 10 });
    const coldQueryMs = performance.now() - tCold;

    let qi = 0;
    const hybrid = timeRuns(() => {
      store.search(queries[qi % queries.length], { mode: 'hybrid', limit: 10 });
      qi += 1;
    }, runs * 2);
    const lexical = timeRuns(() => {
      store.search(queries[qi % queries.length], { mode: 'lexical', limit: 10 });
      qi += 1;
    }, runs * 2);
    const callers = timeRuns(() => store.callers('diffAst', 3), runs * 2);
    const top = store.search('diffAst structural ast diff', { mode: 'hybrid', limit: 1 });

    // Flush WAL frames into the main SQLite file so dbSizeBytes reflects true on-disk footprint
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const st = store.getStats();
    return {
      files: st.files,
      lines: st.lines,
      symbols: st.symbols,
      edges: st.edges,
      vectors: st.vectors,
      embeddingDims: st.embeddingDims,
      dbSizeBytes: st.dbSizeBytes,
      indexMs: round(indexMs, 1),
      indexFilesPerSec: round(summary.filesIndexed / (indexMs / 1000), 0),
      incrementalReindexMs: round(incrementalMs, 2),
      incrementalFilesSkipped: again.filesSkipped,
      coldQueryMs: round(coldQueryMs, 2),
      hybridQuery: hybrid,
      lexicalQuery: lexical,
      callersTrace: callers,
      topHit: top.results[0] ? `${top.results[0].qualifiedName} (${top.results[0].file}:${top.results[0].startLine})` : null,
    };
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function benchSlewbox(root, runs) {
  const binPath = path.join(root, 'packages/slewbox/native/slewbox-cli');
  const result = { nativeBinaryBytes: null, native: null, jsReference: null };

  const jsRuns = [];
  for (let i = 0; i < Math.max(3, Math.floor(runs / 3)); i += 1) {
    const r = renderPatchToWav('saw', 60, 1.5);
    jsRuns.push(r.renderMs);
    if (i === 0) {
      result.jsReference = { frames: r.numFrames, sampleRate: r.sampleRate, wavBytes: r.bytes.byteLength };
    }
  }
  result.jsReference = { ...result.jsReference, ...stats(jsRuns) };

  if (fs.existsSync(binPath)) {
    result.nativeBinaryBytes = fs.statSync(binPath).size;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawplate-wav-'));
    try {
      const perPatch = {};
      for (const patch of ['saw', 'granular', 'fm']) {
        const samples = [];
        let last = null;
        for (let i = 0; i < Math.max(3, Math.floor(runs / 3)); i += 1) {
          const out = execFileSync(
            binPath,
            ['--patch', patch, '--note', '60', '--seconds', '1.5', '--out', path.join(tmp, `${patch}.wav`), '--json'],
            { encoding: 'utf8' },
          );
          last = JSON.parse(out.trim().split('\n').pop());
          samples.push(last.renderMs);
        }
        perPatch[patch] = { ...stats(samples), frames: last.samples, wavBytes: last.bytes, sampleRate: last.sampleRate };
      }
      result.native = perPatch;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return result;
}

async function benchTapeline(root, runs) {
  const cassettePath = path.join(root, 'data/tapeline-cassette-v1.json');
  if (!fs.existsSync(cassettePath)) return { error: 'missing data/tapeline-cassette-v1.json' };
  const proxy = await startReplayProxy({ cassettePath });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const entries = proxy.cassette.entries;

  const hit = (entry) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: proxy.host, port: proxy.port, path: entry.path, method: entry.method, agent },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers['x-tapeline-replay']));
        },
      );
      req.on('error', reject);
      req.end(entry.method === 'GET' ? undefined : '{}');
    });

  try {
    for (let i = 0; i < 20; i += 1) await hit(entries[i % entries.length]);
    const total = Math.max(60, runs * 20);
    const samples = [];
    let hits = 0;
    const wall0 = performance.now();
    for (let i = 0; i < total; i += 1) {
      const t0 = performance.now();
      const header = await hit(entries[i % entries.length]);
      samples.push(performance.now() - t0);
      if (header === 'hit') hits += 1;
    }
    const wallMs = performance.now() - wall0;
    return {
      cassette: 'data/tapeline-cassette-v1.json',
      recordedEntries: entries.length,
      requests: total,
      hits,
      misses: total - hits,
      ...stats(samples),
      requestsPerSec: round(total / (wallMs / 1000), 0),
    };
  } finally {
    agent.destroy();
    await proxy.close();
  }
}

function benchSubpass(runs) {
  const shaders = [
    ...SHADER_PRESETS.map((p) => ({ id: p.id, source: p.source })),
    ...Object.values(POST_SHADERS).map((p) => ({ id: p.id, source: p.source })),
  ];
  const lines = shaders.reduce((acc, s) => acc + countLines(s.source), 0);
  let allOk = true;
  const st = timeRuns(() => {
    for (const s of shaders) {
      const r = analyzeShader(s.source);
      if (!r.ok) allOk = false;
    }
  }, runs);
  return { shaders: shaders.length, glslLines: lines, allShadersValid: allOk, analyzeAll: st };
}

export async function runBench({ root, runs = 15 } = {}) {
  const repoRoot = path.resolve(root);
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const repo = measureRepo(repoRoot);
  const cleave = benchCleave(repoRoot, runs);
  const cadastre = benchCadastre(repoRoot, runs);
  const slewbox = benchSlewbox(repoRoot, runs);
  const tapeline = await benchTapeline(repoRoot, runs);
  const subpass = benchSubpass(runs);

  return {
    drawplateVersion: repo.version,
    generatedAt: startedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model || 'unknown',
      cores: os.cpus().length,
      runs,
    },
    repo,
    cleave,
    cadastre,
    slewbox,
    tapeline,
    subpass,
    totalBenchMs: round(performance.now() - t0, 0),
  };
}

function kb(bytes) {
  return `${round(bytes / 1024, 1)} KB`;
}

export function formatBenchTable(r) {
  const rows = [];
  const add = (tool, metric, value) => rows.push([tool, metric, value]);

  const c = r.cleave;
  add('Cleave', `AST diff, moved+edited fn (preset)`, `${c.presetAstDiff.medianMs} ms (moved ${c.presetAstDiff.movedBlocks}, saved ${c.presetAstDiff.linesSaved} lines)`);
  add('Cleave', `AST diff, ${c.realFileAstDiff.fileLines}-line real file, 1 moved block`, `${c.realFileAstDiff.medianMs} ms (moved ${c.realFileAstDiff.movedBlocks}, saved ${c.realFileAstDiff.linesSaved} lines)`);
  add('Cleave', 'Myers line diff, same real file', `${c.realFileLineDiff.medianMs} ms`);
  add('Cleave', '3-way merge, move + edit (preset)', `${c.presetMerge3.medianMs} ms (conflicts: ${c.presetMerge3.hasConflicts ? 'yes' : 'none'})`);

  const d = r.cadastre;
  add('Cadastre', `Cold SQLite index, ${d.files} files / ${d.lines} lines`, `${d.indexMs} ms (${d.symbols} symbols, ${d.edges} edges)`);
  add('Cadastre', 'Incremental re-index (no changes)', `${d.incrementalReindexMs} ms (${d.incrementalFilesSkipped} files skipped)`);
  add('Cadastre', 'Hybrid int8 + BM25 query', `${d.hybridQuery.medianMs} ms median, ${d.hybridQuery.p95Ms} ms p95`);
  add('Cadastre', 'Lexical BM25 query', `${d.lexicalQuery.medianMs} ms median`);
  add('Cadastre', 'Caller trace (depth 3)', `${d.callersTrace.medianMs} ms median`);
  add('Cadastre', 'SQLite database size', `${kb(d.dbSizeBytes)} (${d.embeddingDims}-dim int8 vectors)`);

  const s = r.slewbox;
  if (s.native) {
    add('Slewbox', 'Native C++20 binary size', `${s.nativeBinaryBytes} bytes (${kb(s.nativeBinaryBytes)})`);
    for (const [patch, v] of Object.entries(s.native)) {
      add('Slewbox', `Native render 1.5 s @ 48 kHz, ${patch}`, `${v.medianMs} ms median (${v.frames} frames)`);
    }
  } else {
    add('Slewbox', 'Native C++20 binary', 'not built (run npm run build:native)');
  }
  add('Slewbox', 'JS reference render 1.5 s @ 48 kHz, saw', `${s.jsReference.medianMs} ms median (${s.jsReference.frames} frames)`);

  const t = r.tapeline;
  if (t.error) {
    add('Tapeline', 'Loopback replay', t.error);
  } else {
    add('Tapeline', `Loopback replay, ${t.requests} requests, ${t.recordedEntries} recorded routes`, `${t.medianMs} ms median, ${t.p95Ms} ms p95`);
    add('Tapeline', 'Replay throughput (keep-alive, sequential)', `${t.requestsPerSec} req/s (${t.hits} hits, ${t.misses} misses)`);
  }

  const p = r.subpass;
  add('Subpass', `Static analysis of ${p.shaders} shaders (${p.glslLines} GLSL lines)`, `${p.analyzeAll.medianMs} ms median total (all valid: ${p.allShadersValid ? 'yes' : 'no'})`);

  const g = r.repo;
  add('Repo', 'Source LOC (packages + bin)', `${g.packagesLoc + g.binLoc}`);
  add('Repo', 'Total LOC (source + tests + web)', `${g.totalLoc}`);
  add('Repo', `Source size (${g.sourceFiles} files)`, kb(g.sourceBytes));
  add('Repo', 'Runtime npm dependencies', `${g.runtimeDependencies}`);

  const w0 = Math.max(...rows.map((x) => x[0].length), 4);
  const w1 = Math.max(...rows.map((x) => x[1].length), 6);
  const lines = [
    `Drawplate ${r.drawplateVersion} bench | node ${r.environment.node} | ${r.environment.platform}/${r.environment.arch} | ${r.environment.cpu} | runs=${r.environment.runs}`,
    '',
    `${'TOOL'.padEnd(w0)}  ${'METRIC'.padEnd(w1)}  VALUE`,
    `${'-'.repeat(w0)}  ${'-'.repeat(w1)}  ${'-'.repeat(5)}`,
    ...rows.map((x) => `${x[0].padEnd(w0)}  ${x[1].padEnd(w1)}  ${x[2]}`),
    '',
    `Total bench time: ${r.totalBenchMs} ms`,
  ];
  return `${lines.join('\n')}\n`;
}
