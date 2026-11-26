import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../bin/serve.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/drawplate.mjs');

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function httpReq(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('drawplate --help and --version print expected output', async () => {
  const help = await runCli(['--help']);
  assert.match(help.stdout, /subpass/);
  assert.match(help.stdout, /cleave/);
  assert.match(help.stdout, /cadastre/);
  assert.match(help.stdout, /slewbox/);
  assert.match(help.stdout, /tapeline/);
  assert.match(help.stdout, /serve/);
  assert.match(help.stdout, /bench/);

  const ver = await runCli(['--version']);
  assert.match(ver.stdout, /^drawplate 1\.0\.0/);
});

test('drawplate dispatches subpass, cleave, cadastre, slewbox, and tapeline subcommands end-to-end', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'drawplate-cli-e2e-'));
  try {
    // 1. Subpass
    const subpassRes = await runCli(['subpass', 'presets', '--json']);
    const presets = JSON.parse(subpassRes.stdout);
    assert.ok(Array.isArray(presets) && presets.length >= 3);
    assert.ok(presets.every((p) => p.ok === true));

    // 2. Cleave
    const fA = path.join(tmp, 'a.js');
    const fB = path.join(tmp, 'b.js');
    await writeFile(fA, 'export function alpha(x) {\n  return x + 1;\n}\n\nexport function beta(y) {\n  return y * 2;\n}\n', 'utf8');
    await writeFile(fB, 'export function beta(y) {\n  return y * 2;\n}\n\nexport function alpha(x) {\n  return x + 1;\n}\n', 'utf8');
    const cleaveRes = await runCli(['cleave', 'diff', fA, fB, '--json']);
    const cleaveJson = JSON.parse(cleaveRes.stdout);
    assert.equal(cleaveJson.mode, 'ast');
    assert.ok(cleaveJson.stats.movedBlocks >= 1);

    // 3. Cadastre
    const dbPath = path.join(tmp, 'cadastre.sqlite');
    const idxRes = await runCli(['cadastre', 'index', path.join(ROOT, 'packages/tapeline'), '--db', dbPath, '--json']);
    const idxJson = JSON.parse(idxRes.stdout);
    assert.ok(idxJson.filesIndexed >= 3);
    assert.ok(idxJson.symbolsIndexed >= 10);

    const qRes = await runCli(['cadastre', 'query', 'diffCassettes', '--db', dbPath, '--json']);
    const qJson = JSON.parse(qRes.stdout);
    assert.ok(qJson.results.length >= 1);
    assert.equal(qJson.results[0].name, 'diffCassettes');

    // 4. Slewbox
    const wavPath = path.join(tmp, 'note.wav');
    const slewRes = await runCli(['slewbox', 'render', '--patch', 'saw', '--note', '60', '--seconds', '0.2', '--out', wavPath, '--json']);
    const slewJson = JSON.parse(slewRes.stdout);
    assert.equal(slewJson.sampleRate, 48000);
    const wavBuf = await readFile(wavPath);
    assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');

    // 5. Tapeline
    const tapeRes = await runCli([
      'tapeline',
      'diff',
      path.join(ROOT, 'data/tapeline-cassette-v1.json'),
      path.join(ROOT, 'data/tapeline-cassette-v2.json'),
      '--json',
    ]);
    const tapeJson = JSON.parse(tapeRes.stdout);
    assert.equal(tapeJson.summary.added, 1);
    assert.equal(tapeJson.summary.removed, 1);
    assert.equal(tapeJson.summary.hasBreakingChanges, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('drawplate bench runs real benchmarks across all 5 tools and returns valid JSON', async () => {
  const res = await runCli(['bench', '--runs', '3', '--json']);
  const report = JSON.parse(res.stdout);
  assert.equal(report.repo.runtimeDependencies, 0);
  assert.ok(report.repo.totalLoc > 1000);
  assert.ok(report.cleave.presetAstDiff.movedBlocks >= 1);
  assert.ok(report.cadastre.symbols > 50);
  assert.ok(report.cadastre.dbSizeBytes > 0);
  assert.ok(report.slewbox.nativeBinaryBytes > 0);
  assert.ok(report.slewbox.native.saw.medianMs > 0);
  assert.ok(report.tapeline.hits === report.tapeline.requests);
  assert.equal(report.subpass.allShadersValid, true);
});

test('drawplate serve exposes static files and live local JSON API routes', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', root: ROOT, version: '1.0.0' });
  try {
    const health = await httpReq(`${srv.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.ok(health.json.cadastre.symbols > 50);

    const search = await httpReq(`${srv.url}/api/cadastre/search?q=diffAst&mode=hybrid`);
    assert.equal(search.status, 200);
    assert.ok(search.json.results.length >= 1);

    const callers = await httpReq(`${srv.url}/api/cadastre/callers?sym=diffAst`);
    assert.equal(callers.status, 200);
    assert.equal(callers.json.root, 'diffAst');

    const stats = await httpReq(`${srv.url}/api/cadastre/stats`);
    assert.equal(stats.status, 200);
    assert.ok(stats.json.files > 10);
    assert.ok(!Object.hasOwn(stats.json, 'dbPath'));
    assert.ok(!Object.hasOwn(stats.json, 'rootDir'));

    const diffResp = await httpReq(`${srv.url}/api/cleave/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lang: 'js',
        a: 'export function f() { return 1; }\nexport function g() { return 2; }\n',
        b: 'export function g() { return 2; }\nexport function f() { return 1; }\n',
      }),
    });
    assert.equal(diffResp.status, 200);
    assert.ok(diffResp.json.result.stats.movedBlocks >= 1);

    const cassettes = await httpReq(`${srv.url}/api/tapeline/cassettes`);
    assert.equal(cassettes.status, 200);
    assert.ok(cassettes.json.cassettes.some((c) => c.name === 'tapeline-cassette-v1.json'));

    const staticIndex = await httpReq(`${srv.url}/index.html`);
    assert.equal(staticIndex.status, 200);
    assert.match(staticIndex.headers['content-type'], /text\/html/);

    const staticSnap = await httpReq(`${srv.url}/data/cadastre-snapshot.json`);
    assert.equal(staticSnap.status, 200);
    assert.ok(staticSnap.json.symbols.length > 50);

    // Blocked dotfiles must return 403
    const blocked = await httpReq(`${srv.url}/.gitignore`);
    assert.equal(blocked.status, 403);
  } finally {
    await srv.close();
  }
});
