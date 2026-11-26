// Drawplate local server: static files + live JSON API backed by the real repo and SQLite index.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CadastreStore } from '../packages/cadastre/index.mjs';
import { detectLanguage, diffAst, diffLines } from '../packages/cleave/index.mjs';
import { diffCassettes, parseCassette } from '../packages/tapeline/index.mjs';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
};

const INDEXED_PATHS = ['packages', 'bin'];
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toInt(value, fallback, min, max) {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isBlockedPath(relPath) {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) return true;
  if (segments.includes('node_modules')) return true;
  if (/\.(sqlite|sqlite-shm|sqlite-wal)$/i.test(relPath)) return true;
  return false;
}

export async function startServer({
  port = 8080,
  host = '127.0.0.1',
  root,
  version = '0.0.0',
  quiet = true,
} = {}) {
  const repoRoot = path.resolve(root);
  const dataDir = path.join(repoRoot, 'data');
  const dbDir = path.join(repoRoot, '.drawplate');
  fs.mkdirSync(dbDir, { recursive: true });
  const store = new CadastreStore(path.join(dbDir, 'cadastre.sqlite'));
  const indexSummary = store.indexDirectory(repoRoot, { includePaths: INDEXED_PATHS });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const startedAt = Date.now();

  function listCassettes() {
    if (!fs.existsSync(dataDir)) return [];
    return fs
      .readdirSync(dataDir)
      .filter((name) => /^tapeline-cassette.*\.json$/.test(name))
      .sort()
      .map((name) => {
        const abs = path.join(dataDir, name);
        const stat = fs.statSync(abs);
        let meta = { entries: 0, target: null, recordedAt: null, version: null };
        try {
          const c = parseCassette(fs.readFileSync(abs, 'utf8'));
          meta = {
            entries: c.entries.length,
            target: c.target,
            recordedAt: c.recordedAt,
            version: c.version,
          };
        } catch {
          // unreadable cassette: report zero entries
        }
        return { name, bytes: stat.size, ...meta };
      });
  }

  function loadCassetteByName(name) {
    const safe = path.basename(String(name || ''));
    const known = listCassettes().find((c) => c.name === safe);
    if (!known) return null;
    return parseCassette(fs.readFileSync(path.join(dataDir, safe), 'utf8'));
  }

  async function handleApi(req, res, url) {
    const route = url.pathname;
    const method = req.method || 'GET';
    const q = url.searchParams;

    if (route === '/api/health' && method === 'GET') {
      const stats = store.getStats();
      return sendJson(res, 200, {
        ok: true,
        name: 'drawplate',
        version,
        node: process.version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        tools: ['subpass', 'cleave', 'cadastre', 'slewbox', 'tapeline'],
        cadastre: { files: stats.files, symbols: stats.symbols, edges: stats.edges, dbSizeBytes: stats.dbSizeBytes },
      });
    }

    if (route === '/api/cadastre/search' && method === 'GET') {
      const query = (q.get('q') || '').trim();
      if (!query) return sendJson(res, 400, { error: 'missing_query', message: 'q is required' });
      const mode = ['hybrid', 'graph', 'lexical'].includes(q.get('mode')) ? q.get('mode') : 'hybrid';
      const limit = toInt(q.get('limit'), 10, 1, 50);
      return sendJson(res, 200, store.search(query, { mode, limit, fileFilter: q.get('file') || null }));
    }

    if (route === '/api/cadastre/callers' && method === 'GET') {
      const sym = (q.get('sym') || '').trim();
      if (!sym) return sendJson(res, 400, { error: 'missing_symbol', message: 'sym is required' });
      const depth = toInt(q.get('depth'), 3, 1, 8);
      const trace = q.get('callees') === '1' || q.get('callees') === 'true'
        ? store.callees(sym, depth)
        : store.callers(sym, depth);
      return sendJson(res, 200, trace);
    }

    if (route === '/api/cadastre/stats' && method === 'GET') {
      return sendJson(res, 200, store.getStats({ includeLocalPaths: false }));
    }

    if (route === '/api/cleave/diff' && method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        const status = err.status || 400;
        return sendJson(res, status, { error: 'bad_request', message: err.message });
      }
      if (typeof payload?.a !== 'string' || typeof payload?.b !== 'string') {
        return sendJson(res, 400, { error: 'bad_request', message: 'a and b must be strings' });
      }
      const lang = detectLanguage(payload.lang || payload.filename || 'js', payload.a);
      const result = payload.mode === 'line' ? diffLines(payload.a, payload.b) : diffAst(payload.a, payload.b, lang);
      return sendJson(res, 200, { mode: payload.mode === 'line' ? 'line' : 'ast', lang, result });
    }

    if (route === '/api/tapeline/cassettes' && method === 'GET') {
      const name = q.get('name');
      if (name) {
        const cassette = loadCassetteByName(name);
        if (!cassette) return sendJson(res, 404, { error: 'unknown_cassette', name });
        return sendJson(res, 200, cassette);
      }
      const before = q.get('before');
      const after = q.get('after');
      if (before && after) {
        const b = loadCassetteByName(before);
        const a = loadCassetteByName(after);
        if (!b || !a) return sendJson(res, 404, { error: 'unknown_cassette', before, after });
        return sendJson(res, 200, diffCassettes(b, a));
      }
      return sendJson(res, 200, { cassettes: listCassettes() });
    }

    return sendJson(res, 404, { error: 'unknown_api_route', method, path: route });
  }

  function serveStatic(req, res, url) {
    let relPath;
    try {
      relPath = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    if (relPath.includes('\0')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    if (relPath.endsWith('/')) relPath += 'index.html';
    const abs = path.resolve(repoRoot, `.${relPath}`);
    const within = abs === repoRoot || abs.startsWith(repoRoot + path.sep);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!within || isBlockedPath(rel)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    let filePath = abs;
    if (stat.isDirectory()) {
      filePath = path.join(abs, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      stat = fs.statSync(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'content-length': String(stat.size),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: err.message });
      } else {
        res.end();
      }
    }
  });

  const boundPort = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

  if (!quiet) {
    process.stdout.write(`Indexed ${indexSummary.filesIndexed} files, ${indexSummary.symbolsIndexed} symbols\n`);
  }

  return {
    server,
    store,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    indexSummary,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      store.close();
    },
  };
}
