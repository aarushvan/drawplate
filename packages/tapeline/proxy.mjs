// Tapeline Proxy: Zero-dependency Node HTTP reverse record/replay proxy.

import http from 'node:http';
import https from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CASSETTE_VERSION,
  createCassette,
  createEntry,
  matchCassetteEntry,
  parseCassette,
  roundMs,
  serializeCassette,
  sortHeaders,
} from './cassette.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function readStreamBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function stripHopHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (v !== undefined) out[lower] = v;
  }
  return out;
}

function listenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

export async function saveCassetteFile(filePath, cassette) {
  const dir = path.dirname(path.resolve(filePath));
  await mkdir(dir, { recursive: true });
  const content = serializeCassette(cassette);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

export async function loadCassetteFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return parseCassette(raw);
}

export async function startRecordProxy({
  target,
  port = 0,
  host = '127.0.0.1',
  outPath = null,
  autoSave = true,
  recordedAt = null,
  onEntry = null,
} = {}) {
  if (!target) {
    throw new Error('startRecordProxy requires a target URL (e.g. http://127.0.0.1:4000)');
  }

  const targetUrl = new URL(target);
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const createdAt = recordedAt || new Date().toISOString();
  const entries = [];
  let writeChain = Promise.resolve();

  const getCassette = () => createCassette({
    version: CASSETTE_VERSION,
    recordedAt: createdAt,
    target: targetUrl.origin,
    entries,
  });

  const persist = async (dest = outPath) => {
    if (!dest) return null;
    return saveCassetteFile(dest, getCassette());
  };

  const server = http.createServer(async (req, res) => {
    try {
      const reqBodyBuf = await readStreamBuffer(req);
      const reqPath = req.url || '/';
      const method = (req.method || 'GET').toUpperCase();

      const forwardHeaders = stripHopHeaders(req.headers);
      forwardHeaders.host = targetUrl.host;
      // Request uncompressed bodies so Git-friendly JSON cassettes remain readable
      delete forwardHeaders['accept-encoding'];
      if (reqBodyBuf.length > 0) {
        forwardHeaders['content-length'] = String(reqBodyBuf.length);
      } else {
        delete forwardHeaders['content-length'];
      }

      const startNs = process.hrtime.bigint();

      const upstreamReq = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          method,
          path: reqPath,
          headers: forwardHeaders,
        },
        async (upstreamRes) => {
          try {
            const ttfbNs = process.hrtime.bigint();
            const resBodyBuf = await readStreamBuffer(upstreamRes);
            const endNs = process.hrtime.bigint();

            const ttfbMs = roundMs(Number(ttfbNs - startNs) / 1e6);
            const totalMs = roundMs(Number(endNs - startNs) / 1e6);
            const status = upstreamRes.statusCode || 200;

            const clientHeaders = stripHopHeaders(upstreamRes.headers);
            clientHeaders['content-length'] = String(resBodyBuf.length);
            clientHeaders['x-tapeline-mode'] = 'record';

            const entry = createEntry(
              {
                id: String(entries.length + 1).padStart(3, '0'),
                method,
                path: reqPath,
                status,
                ttfbMs,
                totalMs,
                reqHeaders: sortHeaders(stripHopHeaders(req.headers)),
                reqBody: reqBodyBuf.length > 0 ? reqBodyBuf.toString('utf8') : null,
                resHeaders: sortHeaders(stripHopHeaders(upstreamRes.headers)),
                resBody: resBodyBuf.length > 0 ? resBodyBuf.toString('utf8') : null,
              },
              entries.length,
            );
            entries.push(entry);

            if (typeof onEntry === 'function') {
              onEntry(entry);
            }
            if (autoSave && outPath) {
              writeChain = writeChain.then(() => persist(outPath)).catch(() => {});
              await writeChain;
            }

            res.writeHead(status, clientHeaders);
            res.end(resBodyBuf);
          } catch (err) {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'tapeline_upstream_read_error', message: err.message }));
            }
          }
        },
      );

      upstreamReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'tapeline_upstream_error', message: err.message }));
        }
      });

      if (reqBodyBuf.length > 0) {
        upstreamReq.write(reqBodyBuf);
      }
      upstreamReq.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'tapeline_record_error', message: err.message }));
      }
    }
  });

  const boundPort = await listenServer(server, port, host);
  const url = `http://${host}:${boundPort}`;

  return {
    server,
    host,
    port: boundPort,
    url,
    target: targetUrl.origin,
    entries,
    getCassette,
    save: persist,
    async close() {
      await writeChain;
      if (outPath) {
        await persist(outPath);
      }
      await closeServer(server);
    },
  };
}

export async function startReplayProxy({
  cassettePath = null,
  cassette = null,
  port = 0,
  host = '127.0.0.1',
} = {}) {
  let loadedCassette = null;
  if (cassette) {
    loadedCassette = parseCassette(cassette);
  } else if (cassettePath) {
    loadedCassette = await loadCassetteFile(cassettePath);
  } else {
    throw new Error('startReplayProxy requires cassettePath or cassette');
  }

  const cursorMap = new Map();
  const stats = { requests: 0, hits: 0, misses: 0 };

  const server = http.createServer(async (req, res) => {
    // Drain request body cleanly so keep-alive sockets stay healthy
    await readStreamBuffer(req);
    stats.requests += 1;

    const method = (req.method || 'GET').toUpperCase();
    const reqPath = req.url || '/';
    const matched = matchCassetteEntry(loadedCassette, method, reqPath, cursorMap);

    if (!matched) {
      stats.misses += 1;
      const body = JSON.stringify(
        {
          error: 'tapeline_cache_miss',
          message: `No recorded cassette entry matched ${method} ${reqPath}`,
          method,
          path: reqPath,
          availableRoutes: loadedCassette.entries.map((e) => `${e.method} ${e.path}`),
        },
        null,
        2,
      );
      const buf = Buffer.from(body, 'utf8');
      res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(buf.length),
        'x-tapeline-replay': 'miss',
      });
      res.end(buf);
      return;
    }

    stats.hits += 1;
    const headers = stripHopHeaders(matched.resHeaders);
    let bodyBuf = Buffer.alloc(0);
    if (matched.resBody !== null && matched.resBody !== undefined) {
      const payload = typeof matched.resBody === 'string'
        ? matched.resBody
        : JSON.stringify(matched.resBody);
      bodyBuf = Buffer.from(payload, 'utf8');
    }

    headers['content-length'] = String(bodyBuf.length);
    headers['x-tapeline-replay'] = 'hit';
    headers['x-tapeline-entry-id'] = matched.id;

    res.writeHead(matched.status, headers);
    res.end(bodyBuf);
  });

  const boundPort = await listenServer(server, port, host);
  const url = `http://${host}:${boundPort}`;

  return {
    server,
    host,
    port: boundPort,
    url,
    cassette: loadedCassette,
    stats,
    reset() {
      cursorMap.clear();
      stats.requests = 0;
      stats.hits = 0;
      stats.misses = 0;
    },
    async close() {
      await closeServer(server);
    },
  };
}
