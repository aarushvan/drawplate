import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CASSETTE_VERSION,
  computeWaterfall,
  diffCassettes,
  diffJsonSchema,
  formatDiffReport,
  formatWaterfall,
  loadCassetteFile,
  runTapelineCli,
  serializeCassette,
  startRecordProxy,
  startReplayProxy,
} from '../packages/tapeline/index.mjs';

function startUpstreamServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
          }),
      });
    });
  });
}

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
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
            // non-JSON body
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('Tapeline records real loopback HTTP traffic, shuts down upstream, and replays offline deterministically', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tapeline-test-'));
  const cassettePath = path.join(tmpDir, 'api-v1.json');

  const upstream = await startUpstreamServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/v1/health') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Service': 'drawplate-api',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true, region: 'local', uptimeSec: 420 }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/tools?limit=2&sort=asc') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            total: 5,
            items: [
              { id: 'subpass', kind: 'gpu', latencyMs: 1.4 },
              { id: 'cleave', kind: 'ast', latencyMs: 0.8 },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/runs') {
        const parsed = JSON.parse(rawBody || '{}');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-001', target: parsed.target || 'default', queued: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  const recordProxy = await startRecordProxy({
    target: upstream.url,
    outPath: cassettePath,
  });

  try {
    const r1 = await httpRequest(`${recordProxy.url}/v1/health`, {
      headers: { 'X-Client': 'tapeline-test', Accept: 'application/json' },
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.ok, true);
    assert.equal(r1.headers['x-tapeline-mode'], 'record');

    const r2 = await httpRequest(`${recordProxy.url}/v1/tools?limit=2&sort=asc`);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.items.length, 2);

    const r3 = await httpRequest(`${recordProxy.url}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'cleave', dryRun: false }),
    });
    assert.equal(r3.status, 201);
    assert.equal(r3.json.runId, 'run-001');
  } finally {
    await recordProxy.close();
    await upstream.close();
  }

  // Verify saved cassette on disk is deterministic & sorted
  const rawDisk = await readFile(cassettePath, 'utf8');
  const cassette = await loadCassetteFile(cassettePath);
  assert.equal(cassette.version, CASSETTE_VERSION);
  assert.equal(cassette.entries.length, 3);
  assert.equal(serializeCassette(cassette), rawDisk);

  // Headers must be deterministically sorted
  const hKeys = Object.keys(cassette.entries[0].resHeaders);
  assert.deepEqual(hKeys, [...hKeys].sort());
  assert.ok(cassette.entries[0].ttfbMs >= 0);
  assert.ok(cassette.entries[0].totalMs >= cassette.entries[0].ttfbMs);

  // Now upstream is completely closed; start offline replay proxy
  const replayProxy = await startReplayProxy({ cassettePath });
  try {
    const h1 = await httpRequest(`${replayProxy.url}/v1/health`);
    assert.equal(h1.status, 200);
    assert.equal(h1.headers['x-tapeline-replay'], 'hit');
    assert.equal(h1.headers['x-tapeline-entry-id'], '001');
    assert.equal(h1.json.ok, true);
    assert.equal(h1.json.uptimeSec, 420);

    // Reordered query string still hits canonically
    const h2 = await httpRequest(`${replayProxy.url}/v1/tools?sort=asc&limit=2`);
    assert.equal(h2.status, 200);
    assert.equal(h2.headers['x-tapeline-replay'], 'hit');
    assert.equal(h2.json.total, 5);

    const h3 = await httpRequest(`${replayProxy.url}/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'cleave' }),
    });
    assert.equal(h3.status, 201);
    assert.equal(h3.headers['x-tapeline-replay'], 'hit');
    assert.equal(h3.json.runId, 'run-001');

    // Unrecorded route returns 404 diagnostic JSON + miss header
    const miss = await httpRequest(`${replayProxy.url}/v1/unrecorded`);
    assert.equal(miss.status, 404);
    assert.equal(miss.headers['x-tapeline-replay'], 'miss');
    assert.equal(miss.json.error, 'tapeline_cache_miss');
    assert.ok(Array.isArray(miss.json.availableRoutes));
    assert.equal(miss.json.availableRoutes.length, 3);

    assert.equal(replayProxy.stats.hits, 3);
    assert.equal(replayProxy.stats.misses, 1);
  } finally {
    await replayProxy.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('Tapeline diffCassettes detects added/removed routes, status changes, deep JSON schema drift, and latency deltas', () => {
  const before = {
    version: '1.0',
    recordedAt: '2026-01-01T00:00:00.000Z',
    target: 'http://127.0.0.1:4100',
    entries: [
      {
        id: '001',
        method: 'GET',
        path: '/v1/tools',
        status: 200,
        ttfbMs: 8.0,
        totalMs: 10.0,
        reqHeaders: { accept: 'application/json' },
        reqBody: null,
        resHeaders: { 'content-type': 'application/json' },
        resBody: {
          total: 5,
          items: [{ id: 'subpass', latencyMs: 1.4, deprecatedTag: 'beta' }],
        },
      },
      {
        id: '002',
        method: 'GET',
        path: '/v1/legacy',
        status: 200,
        ttfbMs: 5.0,
        totalMs: 6.0,
        reqHeaders: {},
        reqBody: null,
        resHeaders: { 'content-type': 'application/json' },
        resBody: { ok: true },
      },
      {
        id: '003',
        method: 'POST',
        path: '/v1/runs',
        status: 201,
        ttfbMs: 12.0,
        totalMs: 15.0,
        reqHeaders: {},
        reqBody: { target: 'cleave' },
        resHeaders: { 'content-type': 'application/json' },
        resBody: { runId: 'run-1', status: 'queued' },
      },
    ],
  };

  const after = {
    version: '1.0',
    recordedAt: '2026-01-02T00:00:00.000Z',
    target: 'http://127.0.0.1:4100',
    entries: [
      {
        id: '001',
        method: 'GET',
        path: '/v1/tools',
        status: 200,
        ttfbMs: 20.0,
        totalMs: 25.0,
        reqHeaders: { accept: 'application/json' },
        reqBody: null,
        resHeaders: { 'content-type': 'application/json' },
        resBody: {
          total: '5', // breaking type drift: number -> string
          items: [{ id: 'subpass', latencyMs: 1.6, version: '1.0' }], // removed deprecatedTag, added version
        },
      },
      {
        id: '002',
        method: 'POST',
        path: '/v1/runs',
        status: 503, // status change
        ttfbMs: 14.0,
        totalMs: 16.0,
        reqHeaders: {},
        reqBody: { target: 'cleave' },
        resHeaders: { 'content-type': 'application/json' },
        resBody: { error: 'overloaded' },
      },
      {
        id: '003',
        method: 'GET',
        path: '/v1/metrics',
        status: 200,
        ttfbMs: 3.0,
        totalMs: 4.0,
        reqHeaders: {},
        reqBody: null,
        resHeaders: { 'content-type': 'application/json' },
        resBody: { cpuPct: 12.5 },
      },
    ],
  };

  const diff = diffCassettes(before, after);
  assert.equal(diff.addedRoutes.length, 1);
  assert.equal(diff.addedRoutes[0].path, '/v1/metrics');
  assert.equal(diff.removedRoutes.length, 1);
  assert.equal(diff.removedRoutes[0].path, '/v1/legacy');
  assert.equal(diff.statusChanges.length, 1);
  assert.equal(diff.statusChanges[0].beforeStatus, 201);
  assert.equal(diff.statusChanges[0].afterStatus, 503);

  const toolsSchema = diff.schemaChanges.find((s) => s.path === '/v1/tools');
  assert.ok(toolsSchema);
  assert.ok(
    toolsSchema.drifts.some(
      (d) => d.kind === 'type_changed' && d.path === '$.total' && d.beforeType === 'number' && d.afterType === 'string',
    ),
  );
  assert.ok(
    toolsSchema.drifts.some((d) => d.kind === 'removed' && d.path === '$.items[].deprecatedTag'),
  );
  assert.ok(
    toolsSchema.drifts.some((d) => d.kind === 'added' && d.path === '$.items[].version'),
  );

  const toolsLatency = diff.latencyDeltas.find((l) => l.path === '/v1/tools');
  assert.ok(toolsLatency);
  assert.equal(toolsLatency.totalDeltaPct, 150);
  assert.equal(toolsLatency.regressed, true);
  assert.equal(diff.summary.hasBreakingChanges, true);

  // Verify negative latency improvement is preserved as negative delta
  const fasterDiff = diffCassettes(after, before);
  const fasterTools = fasterDiff.latencyDeltas.find((l) => l.path === '/v1/tools');
  assert.ok(fasterTools.totalDeltaMs < 0);
  assert.equal(fasterTools.totalDeltaPct, -60);

  const report = formatDiffReport(diff);
  assert.match(report, /Added Routes:/);
  assert.match(report, /Removed Routes/);
  assert.match(report, /Schema Drift:/);
  assert.match(report, /REGRESSION/);

  const wf = computeWaterfall(before);
  assert.equal(wf.count, 3);
  const wfText = formatWaterfall(before);
  assert.match(wfText, /Tapeline Waterfall/);
  assert.match(wfText, /\/v1\/tools/);
});

test('Tapeline CLI inspect & diff commands work end-to-end', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'tapeline-cli-'));
  const f1 = path.join(tmpDir, 'v1.json');
  const f2 = path.join(tmpDir, 'v2.json');

  const c1 = {
    version: '1.0',
    recordedAt: '2026-01-01T00:00:00.000Z',
    target: 'http://127.0.0.1:4200',
    entries: [
      {
        id: '001',
        method: 'GET',
        path: '/ping',
        status: 200,
        ttfbMs: 2.0,
        totalMs: 3.0,
        reqHeaders: {},
        reqBody: null,
        resHeaders: { 'content-type': 'application/json' },
        resBody: { pong: true, count: 1 },
      },
    ],
  };
  const c2 = {
    ...c1,
    entries: [
      {
        ...c1.entries[0],
        ttfbMs: 5.0,
        totalMs: 6.0,
        resBody: { pong: true, count: '1' },
      },
    ],
  };

  const { saveCassetteFile } = await import('../packages/tapeline/index.mjs');
  await saveCassetteFile(f1, c1);
  await saveCassetteFile(f2, c2);

  let out = '';
  let err = '';
  const io = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  };

  try {
    const inspectRes = await runTapelineCli(['inspect', f1], io);
    assert.equal(inspectRes.exitCode, 0);
    assert.equal(err, '');
    assert.match(out, /\/ping/);

    out = '';
    const diffRes = await runTapelineCli(['diff', f1, f2, '--json', '--fail-on-breaking'], io);
    assert.equal(diffRes.exitCode, 2);
    const parsed = JSON.parse(out);
    assert.equal(parsed.summary.hasBreakingChanges, true);
    assert.equal(diffJsonSchema({ a: 1 }, { a: 1 }).length, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
