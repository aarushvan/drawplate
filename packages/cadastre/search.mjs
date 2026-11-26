// Cadastre hybrid vector + BM25 + call-graph search and traversal engine
// Pure isomorphic ESM: works on JSON snapshots in Browser AND SQLite rows in Node

import {
  EMBEDDING_DIMS,
  base64ToVector,
  embedText,
  tokenizeIdentifierText
} from './extract.mjs';

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function cosineInt8(vecA, vecB) {
  const len = Math.min(vecA.length, vecB.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function normalizeVector(raw) {
  if (raw instanceof Int8Array) return raw;
  if (typeof raw === 'string') return base64ToVector(raw);
  if (raw instanceof Uint8Array) {
    return new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) return Int8Array.from(raw);
  return new Int8Array(EMBEDDING_DIMS);
}

export function prepareIndex(input) {
  if (input && input.__prepared === true) return input;

  const rawSymbols = input?.symbols || [];
  const rawEdges = input?.edges || [];
  const files = input?.files || [];
  const stats = input?.stats || {};

  const symbols = rawSymbols.map((s) => ({
    ...s,
    vector: normalizeVector(s.vector),
    termFreqs: s.termFreqs || {},
    tokenCount: s.tokenCount || Object.values(s.termFreqs || {}).reduce((a, b) => a + b, 0) || 1
  }));

  const byId = new Map();
  const byName = new Map();
  const byQualified = new Map();
  const docFreq = new Map();
  let totalTokens = 0;

  for (const sym of symbols) {
    byId.set(sym.id, sym);

    const shortKey = sym.name.toLowerCase();
    if (!byName.has(shortKey)) byName.set(shortKey, []);
    byName.get(shortKey).push(sym);

    const qualKey = sym.qualifiedName.toLowerCase();
    if (!byQualified.has(qualKey)) byQualified.set(qualKey, []);
    byQualified.get(qualKey).push(sym);

    totalTokens += sym.tokenCount;
    for (const term of Object.keys(sym.termFreqs)) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const N = Math.max(1, symbols.length);
  const avgDocLen = totalTokens / N;
  const idf = new Map();
  for (const [term, df] of docFreq.entries()) {
    // Okapi BM25 smoothed IDF
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  // Build bidirectional call graph keyed by lowercase short name and qualified name
  const callersOf = new Map(); // calleeLower -> Array<edge>
  const calleesOf = new Map(); // callerLower -> Array<edge>

  const pushEdge = (map, key, edge) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(edge);
  };

  for (const e of rawEdges) {
    const callerName = e.caller || e.callerName || '';
    const calleeName = e.callee || e.calleeName || '';
    const callerFile = e.callerFile || '';
    const line = e.line || 0;
    const edgeObj = {
      callerId: e.callerId || '',
      caller: callerName,
      callerShort: callerName.includes('.') ? callerName.split('.').pop() : callerName,
      callerFile,
      callee: calleeName,
      line,
      weight: e.weight ?? 1.0
    };

    const calleeKey = calleeName.toLowerCase();
    pushEdge(callersOf, calleeKey, edgeObj);

    const callerQualKey = callerName.toLowerCase();
    pushEdge(calleesOf, callerQualKey, edgeObj);
    const callerShortKey = edgeObj.callerShort.toLowerCase();
    if (callerShortKey !== callerQualKey) {
      pushEdge(calleesOf, callerShortKey, edgeObj);
    }
  }

  return {
    __prepared: true,
    symbols,
    edges: rawEdges,
    files,
    stats,
    byId,
    byName,
    byQualified,
    idf,
    avgDocLen,
    callersOf,
    calleesOf
  };
}

export function searchIndex(indexOrSnapshot, query, options = {}) {
  const t0 = nowMs();
  const idx = prepareIndex(indexOrSnapshot);
  const mode = options.mode || 'hybrid';
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const fileFilter = options.fileFilter ? String(options.fileFilter).toLowerCase() : null;
  const kindFilter = options.kindFilter ? String(options.kindFilter).toLowerCase() : null;

  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery || idx.symbols.length === 0) {
    return {
      query: trimmedQuery,
      mode,
      elapsedMs: Number((nowMs() - t0).toFixed(3)),
      totalSymbols: idx.symbols.length,
      results: []
    };
  }

  const queryLower = trimmedQuery.toLowerCase();
  const queryTokens = tokenizeIdentifierText(trimmedQuery);
  const uniqueQueryTokens = Array.from(new Set(queryTokens));
  const queryVec = embedText(trimmedQuery, EMBEDDING_DIMS);

  const k1 = 1.5;
  const b = 0.75;

  // Step 1: Compute per-symbol lexical BM25, int8 cosine similarity, and exact symbol match
  const rawScores = [];
  let maxBm25 = 0;

  for (let i = 0; i < idx.symbols.length; i++) {
    const sym = idx.symbols[i];
    if (fileFilter && !sym.file.toLowerCase().includes(fileFilter)) continue;
    if (kindFilter && sym.kind.toLowerCase() !== kindFilter) continue;

    // BM25 lexical score
    let bm25 = 0;
    for (let t = 0; t < uniqueQueryTokens.length; t++) {
      const term = uniqueQueryTokens[t];
      const tf = sym.termFreqs[term] || 0;
      if (tf === 0) continue;
      const termIdf = idx.idf.get(term) || 0.5;
      const denom = tf + k1 * (1 - b + b * (sym.tokenCount / idx.avgDocLen));
      bm25 += termIdf * ((tf * (k1 + 1)) / denom);
    }
    if (bm25 > maxBm25) maxBm25 = bm25;

    // Int8 quantized cosine similarity
    const cos = Math.max(0, cosineInt8(queryVec, sym.vector));

    // Direct symbol name / qualifiedName match bonus
    const symNameL = sym.name.toLowerCase();
    const symQualL = sym.qualifiedName.toLowerCase();
    let exact = 0;
    if (symNameL === queryLower || symQualL === queryLower) {
      exact = 1.0;
    } else if (symNameL.includes(queryLower) || symQualL.includes(queryLower)) {
      exact = 0.55;
    } else if (uniqueQueryTokens.length > 0 && uniqueQueryTokens.some((qt) => symNameL === qt)) {
      exact = 0.4;
    }

    rawScores.push({ sym, bm25, cos, exact, graphBoost: 0 });
  }

  // Normalize BM25 to [0, 1]
  const bm25NormDiv = maxBm25 > 0 ? maxBm25 : 1;
  for (const item of rawScores) {
    item.bm25Norm = item.bm25 / bm25NormDiv;
    item.seedScore = 0.48 * item.cos + 0.42 * item.bm25Norm + 0.35 * item.exact;
  }

  // Step 2: Call-graph neighbor boost from top seed matches
  if (mode === 'hybrid' || mode === 'graph') {
    const topSeeds = rawScores
      .slice()
      .sort((a, b) => b.seedScore - a.seedScore)
      .slice(0, 6)
      .filter((s) => s.seedScore > 0.15);

    const neighborBoostByName = new Map();
    for (const seed of topSeeds) {
      const seedNameL = seed.sym.name.toLowerCase();
      const seedQualL = seed.sym.qualifiedName.toLowerCase();

      // Symbols that call this seed
      const callers = idx.callersOf.get(seedNameL) || [];
      for (const e of callers) {
        const key = e.callerShort.toLowerCase();
        const prev = neighborBoostByName.get(key) || 0;
        neighborBoostByName.set(key, Math.min(1, prev + 0.32 * seed.seedScore));
      }

      // Symbols called by this seed
      const callees = idx.calleesOf.get(seedQualL) || idx.calleesOf.get(seedNameL) || [];
      for (const e of callees) {
        const key = e.callee.toLowerCase();
        const prev = neighborBoostByName.get(key) || 0;
        neighborBoostByName.set(key, Math.min(1, prev + 0.28 * seed.seedScore));
      }
    }

    for (const item of rawScores) {
      const symNameL = item.sym.name.toLowerCase();
      const callersCnt = (idx.callersOf.get(symNameL) || []).length;
      const centrality = Math.min(0.2, Math.log1p(callersCnt) * 0.06);
      const neighbor = neighborBoostByName.get(symNameL) || 0;
      item.graphBoost = Math.min(1, neighbor + centrality);
    }
  }

  // Step 3: Mode-specific final scoring
  for (const item of rawScores) {
    if (mode === 'lexical') {
      item.score = 0.72 * item.bm25Norm + 0.28 * item.exact;
    } else if (mode === 'graph') {
      item.score = 0.52 * item.graphBoost + 0.28 * item.exact + 0.12 * item.bm25Norm + 0.08 * item.cos;
    } else {
      // Hybrid: int8 cosine + BM25 + call-graph neighbor boost + exact symbol tie-breaker
      item.score = 0.38 * item.cos + 0.34 * item.bm25Norm + 0.16 * item.graphBoost + 0.28 * item.exact;
    }
  }

  rawScores.sort((a, b) => b.score - a.score || a.sym.file.localeCompare(b.sym.file));

  const results = rawScores
    .filter((r) => r.score > 0.01)
    .slice(0, limit)
    .map((r) => {
      const nameL = r.sym.name.toLowerCase();
      const qualL = r.sym.qualifiedName.toLowerCase();
      const callersCount = (idx.callersOf.get(nameL) || []).length;
      const calleesCount = (idx.calleesOf.get(qualL) || idx.calleesOf.get(nameL) || []).length;
      return {
        id: r.sym.id,
        name: r.sym.name,
        qualifiedName: r.sym.qualifiedName,
        kind: r.sym.kind,
        file: r.sym.file,
        lang: r.sym.lang,
        startLine: r.sym.startLine,
        endLine: r.sym.endLine,
        signature: r.sym.signature,
        snippet: r.sym.snippet,
        score: Number(r.score.toFixed(4)),
        breakdown: {
          vector: Number(r.cos.toFixed(4)),
          bm25: Number(r.bm25Norm.toFixed(4)),
          graph: Number(r.graphBoost.toFixed(4)),
          exact: Number(r.exact.toFixed(4))
        },
        callersCount,
        calleesCount
      };
    });

  return {
    query: trimmedQuery,
    mode,
    elapsedMs: Number((nowMs() - t0).toFixed(3)),
    totalSymbols: idx.symbols.length,
    results
  };
}

export function traceCallers(graphOrIndex, symbolName, maxDepth = 3) {
  const idx = prepareIndex(graphOrIndex);
  const rootName = String(symbolName || '').trim();
  const rootKey = rootName.toLowerCase();
  const depthLimit = Math.max(1, Math.min(8, maxDepth));

  const visited = new Set([rootKey]);
  const nodes = [];
  const edges = [];
  const queue = [{ name: rootName, key: rootKey, depth: 0 }];

  const buildTree = (name, depth, seenPath) => {
    const key = name.toLowerCase();
    const shortKey = key.includes('.') ? key.split('.').pop() : key;
    const incoming = idx.callersOf.get(shortKey) || [];
    const children = [];
    if (depth < depthLimit) {
      for (const e of incoming) {
        const nextKey = e.caller.toLowerCase();
        if (seenPath.has(nextKey)) continue;
        const nextSeen = new Set(seenPath);
        nextSeen.add(nextKey);
        children.push({
          name: e.caller,
          file: e.callerFile,
          line: e.line,
          depth: depth + 1,
          children: buildTree(e.caller, depth + 1, nextSeen)
        });
      }
    }
    return children;
  };

  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.depth >= depthLimit) continue;

    const shortKey = cur.key.includes('.') ? cur.key.split('.').pop() : cur.key;
    const incoming = idx.callersOf.get(shortKey) || [];

    for (const e of incoming) {
      edges.push({
        from: e.caller,
        to: cur.name,
        file: e.callerFile,
        line: e.line,
        depth: cur.depth + 1
      });

      const nextKey = e.caller.toLowerCase();
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        const def = (idx.byQualified.get(nextKey) || idx.byName.get(e.callerShort.toLowerCase()) || [])[0];
        nodes.push({
          name: e.caller,
          file: def?.file || e.callerFile,
          line: def?.startLine || e.line,
          kind: def?.kind || 'function',
          depth: cur.depth + 1
        });
        queue.push({ name: e.caller, key: nextKey, depth: cur.depth + 1 });
      }
    }
  }

  return {
    root: rootName,
    direction: 'callers',
    maxDepth: depthLimit,
    nodes,
    edges,
    tree: {
      name: rootName,
      depth: 0,
      children: buildTree(rootName, 0, new Set([rootKey]))
    }
  };
}

export function traceCallees(graphOrIndex, symbolName, maxDepth = 3) {
  const idx = prepareIndex(graphOrIndex);
  const rootName = String(symbolName || '').trim();
  const rootKey = rootName.toLowerCase();
  const depthLimit = Math.max(1, Math.min(8, maxDepth));

  const visited = new Set([rootKey]);
  const nodes = [];
  const edges = [];
  const queue = [{ name: rootName, key: rootKey, depth: 0 }];

  const buildTree = (name, depth, seenPath) => {
    const key = name.toLowerCase();
    const outgoing = idx.calleesOf.get(key) || idx.calleesOf.get(key.split('.').pop()) || [];
    const children = [];
    if (depth < depthLimit) {
      for (const e of outgoing) {
        const nextKey = e.callee.toLowerCase();
        if (seenPath.has(nextKey)) continue;
        const nextSeen = new Set(seenPath);
        nextSeen.add(nextKey);
        const def = (idx.byName.get(nextKey) || [])[0];
        children.push({
          name: e.callee,
          file: def?.file || e.callerFile,
          line: def?.startLine || e.line,
          depth: depth + 1,
          children: buildTree(e.callee, depth + 1, nextSeen)
        });
      }
    }
    return children;
  };

  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur.depth >= depthLimit) continue;

    const outgoing = idx.calleesOf.get(cur.key) || idx.calleesOf.get(cur.key.split('.').pop()) || [];
    for (const e of outgoing) {
      edges.push({
        from: cur.name,
        to: e.callee,
        file: e.callerFile,
        line: e.line,
        depth: cur.depth + 1
      });

      const nextKey = e.callee.toLowerCase();
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        const def = (idx.byName.get(nextKey) || [])[0];
        nodes.push({
          name: e.callee,
          file: def?.file || null,
          line: def?.startLine || e.line,
          kind: def?.kind || 'external',
          depth: cur.depth + 1
        });
        queue.push({ name: e.callee, key: nextKey, depth: cur.depth + 1 });
      }
    }
  }

  return {
    root: rootName,
    direction: 'callees',
    maxDepth: depthLimit,
    nodes,
    edges,
    tree: {
      name: rootName,
      depth: 0,
      children: buildTree(rootName, 0, new Set([rootKey]))
    }
  };
}

export function getSymbolDetails(graphOrIndex, symbolName) {
  const idx = prepareIndex(graphOrIndex);
  const key = String(symbolName || '').trim().toLowerCase();
  if (!key) return { query: symbolName, matches: [] };

  let matches = idx.byQualified.get(key) || idx.byName.get(key) || [];
  if (matches.length === 0) {
    matches = idx.symbols.filter(
      (s) => s.name.toLowerCase().includes(key) || s.qualifiedName.toLowerCase().includes(key)
    ).slice(0, 10);
  }

  return {
    query: symbolName,
    matches: matches.map((s) => ({
      id: s.id,
      name: s.name,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      file: s.file,
      lang: s.lang,
      startLine: s.startLine,
      endLine: s.endLine,
      signature: s.signature,
      exported: s.exported,
      snippet: s.snippet,
      callers: traceCallers(idx, s.name, 2).edges,
      callees: traceCallees(idx, s.qualifiedName, 2).edges
    }))
  };
}
