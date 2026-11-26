import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  CadastreStore,
  EMBEDDING_DIMS,
  base64ToVector,
  cosineInt8,
  embedText,
  extractFile,
  prepareIndex,
  runCadastreCli,
  searchIndex,
  traceCallees,
  traceCallers,
  vectorToBase64
} from '../packages/cadastre/index.mjs';

test('cadastre browser modules have zero node: imports and zero em dashes', () => {
  for (const file of ['extract.mjs', 'search.mjs']) {
    const src = fs.readFileSync(path.resolve('packages/cadastre', file), 'utf8');
    assert.equal(/['"]node:/.test(src), false, `${file} must remain browser-pure ESM`);
    assert.equal(src.includes('\u2014'), false, `${file} must not contain em dashes`);
  }
  for (const file of ['store.mjs', 'mcp.mjs', 'index.mjs']) {
    const src = fs.readFileSync(path.resolve('packages/cadastre', file), 'utf8');
    assert.equal(src.includes('\u2014'), false, `${file} must not contain em dashes`);
  }
});

test('128-dim int8 quantized embeddings are deterministic, bounded, and semantically meaningful', () => {
  const v1 = embedText('computeAudioGain decibel linear clamp dsp');
  const v2 = embedText('computeAudioGain decibel linear clamp dsp');
  const vRelated = embedText('audio gain decibel clamp');
  const vUnrelated = embedText('sqlite database schema migration table index');

  assert.ok(v1 instanceof Int8Array);
  assert.equal(v1.length, EMBEDDING_DIMS);
  assert.deepEqual(Array.from(v1), Array.from(v2));

  for (let i = 0; i < v1.length; i++) {
    assert.ok(v1[i] >= -127 && v1[i] <= 127);
  }

  const simRelated = cosineInt8(v1, vRelated);
  const simUnrelated = cosineInt8(v1, vUnrelated);
  assert.ok(simRelated > simUnrelated + 0.25, `expected related (${simRelated}) >> unrelated (${simUnrelated})`);

  // Lossless base64 round-trip for browser JSON snapshots
  const b64 = vectorToBase64(v1);
  const decoded = base64ToVector(b64);
  assert.deepEqual(Array.from(decoded), Array.from(v1));
});

test('extractFile extracts symbols, imports, and call edges across JS, Python, C++, and GLSL', () => {
  const jsOut = extractFile('src/audio.mjs', `
import { clamp } from './math.mjs';

export const SAMPLE_RATE = 48000;

export class SynthVoice {
  renderBlock(buf) {
    return applyFilter(buf);
  }
}

export function applyFilter(buf) {
  // clamp() in comment must be ignored
  const label = "fakeCall()";
  return clamp(buf[0], -1, 1);
}
`);
  assert.equal(jsOut.imports.length, 1);
  assert.equal(jsOut.imports[0].source, './math.mjs');
  assert.ok(jsOut.symbols.some((s) => s.name === 'SAMPLE_RATE' && s.kind === 'const'));
  assert.ok(jsOut.symbols.some((s) => s.name === 'SynthVoice' && s.kind === 'class'));
  assert.ok(jsOut.symbols.some((s) => s.qualifiedName === 'SynthVoice.renderBlock' && s.kind === 'method'));
  assert.ok(jsOut.symbols.some((s) => s.name === 'applyFilter' && s.kind === 'function'));
  assert.ok(jsOut.edges.some((e) => e.caller === 'SynthVoice.renderBlock' && e.callee === 'applyFilter'));
  assert.ok(jsOut.edges.some((e) => e.caller === 'applyFilter' && e.callee === 'clamp'));
  assert.equal(jsOut.edges.some((e) => e.callee === 'fakeCall'), false);

  const glslOut = extractFile('shaders/bloom.frag', `
uniform float uThreshold;
vec3 extractBright(vec3 col) {
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  return lum > uThreshold ? col : vec3(0.0);
}
void main() {
  vec3 c = extractBright(vec3(1.0));
}
`);
  assert.ok(glslOut.symbols.some((s) => s.name === 'uThreshold' && s.kind === 'const'));
  assert.ok(glslOut.symbols.some((s) => s.name === 'extractBright' && s.kind === 'shader_fn'));
  assert.ok(glslOut.symbols.some((s) => s.name === 'main' && s.kind === 'shader_fn'));
  assert.ok(glslOut.edges.some((e) => e.caller === 'main' && e.callee === 'extractBright'));

  const pyOut = extractFile('tools/ranker.py', `
import math

def score_vec(a, b):
    return math.sqrt(a * b)

def rank_all(pairs):
    return [score_vec(x, y) for x, y in pairs]
`);
  assert.ok(pyOut.symbols.some((s) => s.name === 'score_vec'));
  assert.ok(pyOut.edges.some((e) => e.caller === 'rank_all' && e.callee === 'score_vec'));

  const cppOut = extractFile('native/dsp.cpp', `
#include <cmath>
float softClip(float x) {
  return std::tanh(x);
}
float processSample(float x) {
  return softClip(x * 1.5f);
}
`);
  assert.ok(cppOut.symbols.some((s) => s.name === 'softClip'));
  assert.ok(cppOut.edges.some((e) => e.caller === 'processSample' && e.callee === 'softClip'));
});

test('CadastreStore SQLite indexing, incremental re-index, hybrid search, caller graph, and JSON snapshot parity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadastre-store-'));
  const repoDir = path.join(tmpDir, 'repo');
  const dbPath = path.join(tmpDir, 'index.sqlite');
  const snapPath = path.join(tmpDir, 'snapshot.json');
  fs.mkdirSync(repoDir, { recursive: true });

  try {
    fs.writeFileSync(path.join(repoDir, 'math.mjs'), `
export function clampUnit(x) {
  return Math.max(0, Math.min(1, x));
}
`, 'utf8');

    fs.writeFileSync(path.join(repoDir, 'bloom.mjs'), `
import { clampUnit } from './math.mjs';

export function karisAverage(luminance) {
  return clampUnit(luminance / (1 + luminance));
}

export function runBloomPass(pixels) {
  return pixels.map((p) => karisAverage(p));
}
`, 'utf8');

    fs.writeFileSync(path.join(repoDir, 'pipeline.mjs'), `
import { runBloomPass } from './bloom.mjs';

export function renderFrame(frameBuffer) {
  return runBloomPass(frameBuffer);
}
`, 'utf8');

    const store = new CadastreStore(dbPath);
    try {
      // 1. Initial full index
      const first = store.indexDirectory(repoDir);
      assert.equal(first.filesIndexed, 3);
      assert.equal(first.filesSkipped, 0);
      assert.ok(first.symbolsIndexed >= 4);
      assert.ok(first.edgesIndexed >= 3);
      assert.ok(fs.existsSync(dbPath));
      assert.ok(first.dbSizeBytes > 0);

      // 2. Incremental second index skips unchanged files
      const second = store.indexDirectory(repoDir);
      assert.equal(second.filesIndexed, 0);
      assert.equal(second.filesSkipped, 3);

      // 3. Edit one file -> only that file re-indexes
      fs.writeFileSync(path.join(repoDir, 'math.mjs'), `
export function clampUnit(x) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
`, 'utf8');
      const third = store.indexDirectory(repoDir);
      assert.equal(third.filesIndexed, 1);
      assert.equal(third.filesSkipped, 2);

      // 4. Hybrid search ranks karisAverage / runBloomPass at top
      const hybridHits = store.search('karis luminance bloom pass', { mode: 'hybrid', limit: 5 });
      assert.ok(hybridHits.results.length >= 2);
      assert.ok(['karisAverage', 'runBloomPass'].includes(hybridHits.results[0].name));
      assert.ok(hybridHits.results[0].breakdown.vector > 0);
      assert.ok(hybridHits.results[0].breakdown.bm25 > 0);

      // Lexical and graph modes both work cleanly
      const lexHits = store.search('clampUnit', { mode: 'lexical', limit: 3 });
      assert.equal(lexHits.results[0].name, 'clampUnit');
      const graphHits = store.search('karisAverage', { mode: 'graph', limit: 5 });
      assert.ok(graphHits.results.length >= 1);

      // 5. Multi-hop caller traversal: clampUnit <- karisAverage <- runBloomPass <- renderFrame
      const callers = store.callers('clampUnit', 4);
      const callerNames = callers.nodes.map((n) => n.name);
      assert.ok(callerNames.includes('karisAverage'));
      assert.ok(callerNames.includes('runBloomPass'));
      assert.ok(callerNames.includes('renderFrame'));

      // Callee traversal: renderFrame -> runBloomPass -> karisAverage -> clampUnit
      const callees = store.callees('renderFrame', 4);
      const calleeNames = callees.nodes.map((n) => n.name);
      assert.ok(calleeNames.includes('runBloomPass'));
      assert.ok(calleeNames.includes('karisAverage'));
      assert.ok(calleeNames.includes('clampUnit'));

      // 6. Export static JSON snapshot & verify identical browser-side search
      const snapshot = store.exportSnapshot(snapPath);
      assert.ok(fs.existsSync(snapPath));
      const parsedSnap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      assert.equal(store.getStats().dbPath, dbPath);
      assert.ok(!Object.hasOwn(parsedSnap.stats, 'dbPath'));
      assert.ok(!Object.hasOwn(parsedSnap.stats, 'rootDir'));
      const browserIdx = prepareIndex(parsedSnap);
      const browserHits = searchIndex(browserIdx, 'karis luminance bloom pass', { mode: 'hybrid', limit: 5 });
      assert.equal(browserHits.results[0].name, hybridHits.results[0].name);
      assert.equal(traceCallers(browserIdx, 'clampUnit', 4).nodes.length, callers.nodes.length);
      assert.equal(traceCallees(browserIdx, 'renderFrame', 4).nodes.length, callees.nodes.length);
      assert.equal(snapshot.symbols.length, store.getStats().symbols);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Live stdio JSON-RPC 2.0 MCP server round-trip (initialize, tools/list, tools/call)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadastre-mcp-'));
  const dbPath = path.join(tmpDir, 'mcp.sqlite');

  try {
    // Index real packages/cleave directory into SQLite DB
    const store = new CadastreStore(dbPath);
    store.indexDirectory(path.resolve('packages/cleave'));
    store.close();

    // Spawn real stdio MCP server child process
    const mcpRunner = `
      import { startMcpServer } from ${JSON.stringify(path.resolve('packages/cadastre/mcp.mjs'))};
      startMcpServer({ dbPath: ${JSON.stringify(dbPath)} });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', mcpRunner], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const responses = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });

    const send = (obj) => {
      child.stdin.write(JSON.stringify(obj) + '\n');
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cadastre_search', arguments: { query: 'diffAst moved blocks', mode: 'hybrid', limit: 5 } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cadastre_callers', arguments: { symbol: 'parseBlocks', maxDepth: 2 } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cadastre_symbol', arguments: { symbol: 'merge3' } } });
    send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'cadastre_stats', arguments: {} } });
    send({ jsonrpc: '2.0', id: 7, method: 'nonexistent/method' });
    child.stdin.end();

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0);

    // 7 responses (notification produced no response!)
    assert.equal(responses.length, 7);

    const byId = new Map(responses.map((r) => [r.id, r]));

    // 1. initialize
    assert.equal(byId.get(1).result.serverInfo.name, 'drawplate-cadastre');
    assert.equal(byId.get(1).result.protocolVersion, '2024-11-05');

    // 2. tools/list
    const toolNames = byId.get(2).result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, ['cadastre_search', 'cadastre_callers', 'cadastre_symbol', 'cadastre_stats']);

    // 3. cadastre_search
    const searchRes = byId.get(3).result;
    assert.equal(searchRes.isError, false);
    const searchPayload = JSON.parse(searchRes.content[0].text);
    assert.ok(searchPayload.results.some((r) => r.name === 'diffAst'));

    // 4. cadastre_callers
    const callersPayload = JSON.parse(byId.get(4).result.content[0].text);
    assert.ok(callersPayload.nodes.some((n) => n.name === 'diffAst' || n.name === 'merge3'));

    // 5. cadastre_symbol
    const symPayload = JSON.parse(byId.get(5).result.content[0].text);
    assert.equal(symPayload.matches[0].name, 'merge3');

    // 6. cadastre_stats
    const statsPayload = JSON.parse(byId.get(6).result.content[0].text);
    assert.equal(statsPayload.files, 4);
    assert.ok(statsPayload.symbols > 10);
    assert.equal(statsPayload.embeddingDims, 128);

    // 7. Unknown method error
    assert.equal(byId.get(7).error.code, -32601);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runCadastreCli supports index, query, callers, stats, and export-json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadastre-cli-'));
  const dbPath = path.join(tmpDir, 'cli.sqlite');
  const outJson = path.join(tmpDir, 'out.json');

  try {
    let buf = '';
    const io = { stdout: (s) => { buf += s; }, stderr: () => {} };

    assert.equal(await runCadastreCli(['index', path.resolve('packages/cleave'), '--db', dbPath, '--json'], io), 0);
    assert.ok(JSON.parse(buf).filesIndexed === 4);

    buf = '';
    assert.equal(await runCadastreCli(['query', 'mergeLines3', '--db', dbPath, '--mode', 'hybrid', '--json'], io), 0);
    assert.ok(JSON.parse(buf).results.some((r) => r.name === 'mergeLines3'));

    buf = '';
    assert.equal(await runCadastreCli(['callers', 'diffLines', '--db', dbPath, '--json'], io), 0);
    assert.ok(JSON.parse(buf).edges.length > 0);

    buf = '';
    assert.equal(await runCadastreCli(['stats', '--db', dbPath, '--json'], io), 0);
    assert.equal(JSON.parse(buf).files, 4);

    buf = '';
    assert.equal(await runCadastreCli(['export-json', outJson, '--db', dbPath], io), 0);
    assert.ok(fs.existsSync(outJson));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
