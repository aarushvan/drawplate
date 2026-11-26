// Cadastre persistent SQLite store (Node 26 built-in node:sqlite DatabaseSync)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  EMBEDDING_DIMS,
  extractFile,
  vectorToBase64
} from './extract.mjs';
import {
  getSymbolDetails,
  prepareIndex,
  searchIndex,
  traceCallees,
  traceCallers
} from './search.mjs';

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.taste-skill',
  'shots',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '__pycache__',
  'target'
]);

const DEFAULT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx',
  '.glsl', '.vert', '.frag', '.wgsl', '.rs', '.go'
]);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  imports_json TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  lang TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL,
  snippet TEXT NOT NULL,
  term_freqs_json TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id TEXT NOT NULL,
  caller_name TEXT NOT NULL,
  caller_file TEXT NOT NULL,
  callee_name TEXT NOT NULL,
  line INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  FOREIGN KEY(caller_file) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vectors (
  symbol_id TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  vec BLOB NOT NULL,
  FOREIGN KEY(symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_edges_callee ON edges(callee_name);
CREATE INDEX IF NOT EXISTS idx_edges_caller ON edges(caller_name);
CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(caller_file);
`;

function walkFiles(rootDir, options = {}) {
  const ignoreDirs = options.ignoreDirs || DEFAULT_IGNORE_DIRS;
  const extensions = options.extensions || DEFAULT_EXTENSIONS;
  const includePaths = options.includePaths || null;
  const results = [];

  const visit = (dirAbs) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.isDirectory()) continue;
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) continue;
        visit(path.join(dirAbs, ent.name));
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!extensions.has(ext)) continue;
        const absPath = path.join(dirAbs, ent.name);
        const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
        if (includePaths && !includePaths.some((p) => relPath === p || relPath.startsWith(p + '/'))) {
          continue;
        }
        results.push({ absPath, relPath });
      }
    }
  };

  visit(rootDir);
  return results;
}

export class CadastreStore {
  constructor(dbPath = '.cadastre.sqlite') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec(SCHEMA_SQL);
    this._cachedIndex = null;
  }

  close() {
    this._cachedIndex = null;
    this.db.close();
  }

  _setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  _getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  indexDirectory(rootDir, options = {}) {
    const t0 = performance.now();
    const resolvedRoot = path.resolve(rootDir);
    const discovered = walkFiles(resolvedRoot, options);
    const seenPaths = new Set();

    const existingRows = this.db.prepare('SELECT path, mtime_ms, sha256 FROM files').all();
    const existingByPath = new Map();
    for (const r of existingRows) {
      existingByPath.set(r.path, { mtimeMs: r.mtime_ms, sha256: r.sha256 });
    }

    const deleteFileStmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    const updateMtimeStmt = this.db.prepare('UPDATE files SET mtime_ms = ? WHERE path = ?');
    const insertFileStmt = this.db.prepare(`
      INSERT INTO files (path, lang, mtime_ms, sha256, size_bytes, line_count, imports_json, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSymStmt = this.db.prepare(`
      INSERT INTO symbols (id, file_path, name, qualified_name, kind, lang, start_line, end_line, signature, exported, snippet, term_freqs_json, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVecStmt = this.db.prepare(`
      INSERT INTO vectors (symbol_id, dims, vec) VALUES (?, ?, ?)
    `);
    const insertEdgeStmt = this.db.prepare(`
      INSERT INTO edges (caller_id, caller_name, caller_file, callee_name, line, weight)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let filesIndexed = 0;
    let filesSkipped = 0;
    let symbolsIndexed = 0;
    let edgesIndexed = 0;
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN');
    try {
      for (const { absPath, relPath } of discovered) {
        seenPaths.add(relPath);
        const stat = fs.statSync(absPath);
        const mtimeMs = Math.floor(stat.mtimeMs);
        const prev = existingByPath.get(relPath);

        if (prev && Math.floor(prev.mtimeMs) === mtimeMs && !options.force) {
          filesSkipped++;
          continue;
        }

        const content = fs.readFileSync(absPath, 'utf8');
        const sha256 = crypto.createHash('sha256').update(content).digest('hex');

        if (prev && prev.sha256 === sha256 && !options.force) {
          updateMtimeStmt.run(mtimeMs, relPath);
          filesSkipped++;
          continue;
        }

        // Remove stale rows (cascades to symbols, edges, vectors)
        if (prev) {
          deleteFileStmt.run(relPath);
        }

        const extracted = extractFile(relPath, content);
        insertFileStmt.run(
          relPath,
          extracted.lang,
          mtimeMs,
          sha256,
          stat.size,
          extracted.lines,
          JSON.stringify(extracted.imports),
          nowIso
        );

        for (const sym of extracted.symbols) {
          insertSymStmt.run(
            sym.id,
            sym.file,
            sym.name,
            sym.qualifiedName,
            sym.kind,
            sym.lang,
            sym.startLine,
            sym.endLine,
            sym.signature,
            sym.exported ? 1 : 0,
            sym.snippet,
            JSON.stringify(sym.termFreqs),
            sym.tokenCount
          );
          const vecBytes = new Uint8Array(sym.vector.buffer, sym.vector.byteOffset, sym.vector.byteLength);
          insertVecStmt.run(sym.id, EMBEDDING_DIMS, vecBytes);
          symbolsIndexed++;
        }

        for (const edge of extracted.edges) {
          insertEdgeStmt.run(
            edge.callerId,
            edge.caller,
            edge.callerFile,
            edge.callee,
            edge.line,
            edge.weight
          );
          edgesIndexed++;
        }

        filesIndexed++;
      }

      // Prune removed files
      let filesRemoved = 0;
      for (const oldPath of existingByPath.keys()) {
        if (!seenPaths.has(oldPath)) {
          deleteFileStmt.run(oldPath);
          filesRemoved++;
        }
      }

      this._setMeta('root_dir', resolvedRoot);
      this._setMeta('indexed_at', nowIso);
      this._setMeta('schema_version', '1');
      this._setMeta('embedding_dims', String(EMBEDDING_DIMS));

      this.db.exec('COMMIT');
      this._cachedIndex = null;

      const elapsedMs = Number((performance.now() - t0).toFixed(3));
      const dbSizeBytes = this.getDbSizeBytes();

      return {
        rootDir: resolvedRoot,
        filesScanned: discovered.length,
        filesIndexed,
        filesSkipped,
        filesRemoved,
        symbolsIndexed,
        edgesIndexed,
        elapsedMs,
        dbSizeBytes
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getDbSizeBytes() {
    if (this.dbPath === ':memory:') return 0;
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  loadIndex() {
    if (this._cachedIndex) return this._cachedIndex;

    const fileRows = this.db.prepare('SELECT path, lang, line_count, size_bytes, imports_json FROM files ORDER BY path').all();
    const symRows = this.db.prepare(`
      SELECT s.id, s.file_path, s.name, s.qualified_name, s.kind, s.lang,
             s.start_line, s.end_line, s.signature, s.exported, s.snippet,
             s.term_freqs_json, s.token_count, v.vec
      FROM symbols s
      LEFT JOIN vectors v ON v.symbol_id = s.id
      ORDER BY s.file_path, s.start_line
    `).all();
    const edgeRows = this.db.prepare(`
      SELECT caller_id, caller_name, caller_file, callee_name, line, weight
      FROM edges
    `).all();

    const symbols = symRows.map((r) => {
      const vecU8 = r.vec instanceof Uint8Array ? r.vec : new Uint8Array(EMBEDDING_DIMS);
      const vector = new Int8Array(vecU8.buffer, vecU8.byteOffset, vecU8.byteLength);
      return {
        id: r.id,
        file: r.file_path,
        name: r.name,
        qualifiedName: r.qualified_name,
        kind: r.kind,
        lang: r.lang,
        startLine: r.start_line,
        endLine: r.end_line,
        signature: r.signature,
        exported: Boolean(r.exported),
        snippet: r.snippet,
        termFreqs: JSON.parse(r.term_freqs_json),
        tokenCount: r.token_count,
        vector
      };
    });

    const edges = edgeRows.map((e) => ({
      callerId: e.caller_id,
      caller: e.caller_name,
      callerFile: e.caller_file,
      callee: e.callee_name,
      line: e.line,
      weight: e.weight
    }));

    const files = fileRows.map((f) => ({
      path: f.path,
      lang: f.lang,
      lines: f.line_count,
      sizeBytes: f.size_bytes,
      imports: JSON.parse(f.imports_json)
    }));

    this._cachedIndex = prepareIndex({
      files,
      symbols,
      edges,
      stats: this.getStats()
    });
    return this._cachedIndex;
  }

  search(query, options = {}) {
    return searchIndex(this.loadIndex(), query, options);
  }

  callers(symbolName, maxDepth = 3) {
    return traceCallers(this.loadIndex(), symbolName, maxDepth);
  }

  callees(symbolName, maxDepth = 3) {
    return traceCallees(this.loadIndex(), symbolName, maxDepth);
  }

  getSymbol(symbolName) {
    return getSymbolDetails(this.loadIndex(), symbolName);
  }

  getStats({ includeLocalPaths = true } = {}) {
    const fileCount = this.db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
    const symbolCount = this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c;
    const edgeCount = this.db.prepare('SELECT COUNT(*) AS c FROM edges').get().c;
    const vectorCount = this.db.prepare('SELECT COUNT(*) AS c FROM vectors').get().c;
    const totalLines = this.db.prepare('SELECT COALESCE(SUM(line_count), 0) AS c FROM files').get().c;
    const langRows = this.db.prepare('SELECT lang, COUNT(*) AS files, SUM(line_count) AS lines FROM files GROUP BY lang ORDER BY files DESC').all();
    const kindRows = this.db.prepare('SELECT kind, COUNT(*) AS count FROM symbols GROUP BY kind ORDER BY count DESC').all();

    return {
      ...(includeLocalPaths && { dbPath: this.dbPath, rootDir: this._getMeta('root_dir') }),
      dbSizeBytes: this.getDbSizeBytes(),
      indexedAt: this._getMeta('indexed_at'),
      embeddingDims: EMBEDDING_DIMS,
      quantization: 'int8',
      files: fileCount,
      lines: totalLines,
      symbols: symbolCount,
      edges: edgeCount,
      vectors: vectorCount,
      languages: langRows.map((r) => ({ lang: r.lang, files: r.files, lines: r.lines })),
      kinds: kindRows.map((r) => ({ kind: r.kind, count: r.count }))
    };
  }

  exportSnapshot(outPath = null) {
    const idx = this.loadIndex();
    const stats = this.getStats({ includeLocalPaths: false });

    const snapshot = {
      version: 1,
      generator: 'drawplate-cadastre',
      generatedAt: new Date().toISOString(),
      embeddingDims: EMBEDDING_DIMS,
      quantization: 'int8',
      stats,
      files: idx.files,
      symbols: idx.symbols.map((s) => ({
        id: s.id,
        file: s.file,
        name: s.name,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        lang: s.lang,
        startLine: s.startLine,
        endLine: s.endLine,
        signature: s.signature,
        exported: s.exported,
        snippet: s.snippet,
        termFreqs: s.termFreqs,
        tokenCount: s.tokenCount,
        vector: vectorToBase64(s.vector)
      })),
      edges: idx.edges
    };

    if (outPath) {
      const absOut = path.resolve(outPath);
      const dir = path.dirname(absOut);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absOut, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    }

    return snapshot;
  }
}

export function indexDirectory(rootDir, dbPath = '.cadastre.sqlite', options = {}) {
  const store = new CadastreStore(dbPath);
  try {
    return store.indexDirectory(rootDir, options);
  } finally {
    store.close();
  }
}
