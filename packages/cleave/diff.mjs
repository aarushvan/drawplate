// Cleave Myers line diff and structural AST move-aware diff (pure isomorphic ESM)

import { detectLanguage, parseBlocks, splitLines, tokenSimilarity } from './parser.mjs';

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function buildHunks(ops, contextLines = 3) {
  const changeIndices = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'equal') changeIndices.push(i);
  }
  if (!changeIndices.length) return [];

  const ranges = [];
  let start = Math.max(0, changeIndices[0] - contextLines);
  let end = Math.min(ops.length - 1, changeIndices[0] + contextLines);

  for (let k = 1; k < changeIndices.length; k++) {
    const nextStart = Math.max(0, changeIndices[k] - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndices[k] + contextLines);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
    } else {
      ranges.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  ranges.push([start, end]);

  return ranges.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;
    for (const op of slice) {
      if (op.oldLine !== null && oldStart === 0) oldStart = op.oldLine;
      if (op.newLine !== null && newStart === 0) newStart = op.newLine;
      if (op.type === 'equal' || op.type === 'delete') oldCount++;
      if (op.type === 'equal' || op.type === 'insert') newCount++;
    }
    return {
      oldStart: oldStart || 1,
      oldCount,
      newStart: newStart || 1,
      newCount,
      lines: slice
    };
  });
}

// Eugene W. Myers O((N+M)D) shortest edit script line diff
export function diffLines(textA, textB, options = {}) {
  const t0 = nowMs();
  const a = Array.isArray(textA) ? textA : splitLines(textA);
  const b = Array.isArray(textB) ? textB : splitLines(textB);
  const n = a.length;
  const m = b.length;
  const contextLines = options.contextLines ?? 3;

  // Fast trim common prefix and suffix
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    a[n - 1 - suffix] === b[m - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, n - suffix);
  const bMid = b.slice(prefix, m - suffix);
  const midOps = myersCore(aMid, bMid, prefix, prefix);

  const ops = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'equal', line: a[i], oldLine: i + 1, newLine: i + 1 });
  }
  for (const op of midOps) ops.push(op);
  for (let i = 0; i < suffix; i++) {
    const oldIdx = n - suffix + i;
    const newIdx = m - suffix + i;
    ops.push({ type: 'equal', line: a[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.type === 'insert') added++;
    else if (op.type === 'delete') removed++;
    else unchanged++;
  }

  const hunks = buildHunks(ops, contextLines);
  const elapsedMs = Number((nowMs() - t0).toFixed(3));

  return {
    ops,
    hunks,
    stats: {
      added,
      removed,
      unchanged,
      totalOld: n,
      totalNew: m,
      elapsedMs
    }
  };
}

function myersCore(a, b, oldOffset, newOffset) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return b.map((line, j) => ({
      type: 'insert',
      line,
      oldLine: null,
      newLine: newOffset + j + 1
    }));
  }
  if (m === 0) {
    return a.map((line, i) => ({
      type: 'delete',
      line,
      oldLine: oldOffset + i + 1,
      newLine: null
    }));
  }

  const maxD = n + m;
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace = [];

  // Cap pathological edit distance while preserving full exact Myers for real files
  const dLimit = Math.min(maxD, 4000);
  let foundD = -1;

  for (let d = 0; d <= dLimit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD !== -1) break;
  }

  if (foundD === -1) {
    // Fallback if file diff exceeds 4000 edit steps
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ type: 'delete', line: a[i], oldLine: oldOffset + i + 1, newLine: null });
    }
    for (let j = 0; j < m; j++) {
      out.push({ type: 'insert', line: b[j], oldLine: null, newLine: newOffset + j + 1 });
    }
    return out;
  }

  // Backtrack shortest edit script
  const reversed = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d--) {
    const snap = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && snap[d + k - 1] < snap[d + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = snap[d + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      reversed.push({
        type: 'equal',
        line: a[x],
        oldLine: oldOffset + x + 1,
        newLine: newOffset + y + 1
      });
    }

    if (x === prevX) {
      y--;
      reversed.push({
        type: 'insert',
        line: b[y],
        oldLine: null,
        newLine: newOffset + y + 1
      });
    } else {
      x--;
      reversed.push({
        type: 'delete',
        line: a[x],
        oldLine: oldOffset + x + 1,
        newLine: null
      });
    }
  }

  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push({
      type: 'equal',
      line: a[x],
      oldLine: oldOffset + x + 1,
      newLine: newOffset + y + 1
    });
  }

  reversed.reverse();
  return reversed;
}

// Longest Increasing Subsequence over matched indices (maximize stationary block count, break ties by line weight)
function weightedLisIndices(pairs) {
  const n = pairs.length;
  if (n === 0) return new Set();
  const dpCount = new Array(n).fill(1);
  const dpWeight = new Array(n).fill(0);
  const parent = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const w = Math.max(1, pairs[i].weight);
    dpCount[i] = 1;
    dpWeight[i] = w;
    for (let j = 0; j < i; j++) {
      if (pairs[j].indexB < pairs[i].indexB) {
        const candCount = dpCount[j] + 1;
        const candWeight = dpWeight[j] + w;
        if (candCount > dpCount[i] || (candCount === dpCount[i] && candWeight > dpWeight[i])) {
          dpCount[i] = candCount;
          dpWeight[i] = candWeight;
          parent[i] = j;
        }
      }
    }
  }

  let bestIdx = 0;
  for (let i = 1; i < n; i++) {
    if (
      dpCount[i] > dpCount[bestIdx] ||
      (dpCount[i] === dpCount[bestIdx] && dpWeight[i] > dpWeight[bestIdx])
    ) {
      bestIdx = i;
    }
  }

  const kept = new Set();
  let cur = bestIdx;
  while (cur !== -1) {
    kept.add(cur);
    cur = parent[cur];
  }
  return kept;
}

function matchBlockSets(blocksA, blocksB, similarityThreshold) {
  const matchedA = new Set();
  const matchedB = new Set();
  const matches = [];

  // Pass 1: exact tokenHash matches (prefer same qualifiedName, then nearest startLine)
  const byHashB = new Map();
  for (let j = 0; j < blocksB.length; j++) {
    const h = blocksB[j].tokenHash;
    if (!byHashB.has(h)) byHashB.set(h, []);
    byHashB.get(h).push(j);
  }

  for (let i = 0; i < blocksA.length; i++) {
    const a = blocksA[i];
    const candidates = (byHashB.get(a.tokenHash) || []).filter((j) => !matchedB.has(j));
    if (!candidates.length) continue;

    candidates.sort((j1, j2) => {
      const same1 = blocksB[j1].qualifiedName === a.qualifiedName ? 0 : 1;
      const same2 = blocksB[j2].qualifiedName === a.qualifiedName ? 0 : 1;
      if (same1 !== same2) return same1 - same2;
      return Math.abs(blocksB[j1].startLine - a.startLine) - Math.abs(blocksB[j2].startLine - a.startLine);
    });

    const bestJ = candidates[0];
    matchedA.add(i);
    matchedB.add(bestJ);
    matches.push({ indexA: i, indexB: bestJ, a, b: blocksB[bestJ], similarity: 1, exact: true });
  }

  // Pass 2: same qualifiedName + kind with similarity >= 0.45 (or >= similarityThreshold if moved)
  for (let i = 0; i < blocksA.length; i++) {
    if (matchedA.has(i)) continue;
    const a = blocksA[i];
    let bestJ = -1;
    let bestSim = 0;
    for (let j = 0; j < blocksB.length; j++) {
      if (matchedB.has(j)) continue;
      const b = blocksB[j];
      if (b.qualifiedName === a.qualifiedName && b.kind === a.kind) {
        const sim = tokenSimilarity(a.tokens, b.tokens);
        if (sim >= 0.4 && sim > bestSim) {
          bestSim = sim;
          bestJ = j;
        }
      }
    }
    if (bestJ !== -1) {
      matchedA.add(i);
      matchedB.add(bestJ);
      matches.push({ indexA: i, indexB: bestJ, a, b: blocksB[bestJ], similarity: bestSim, exact: false });
    }
  }

  // Pass 3: cross-name / moved+edited matching with similarity >= similarityThreshold (default 0.65)
  const scoredPairs = [];
  for (let i = 0; i < blocksA.length; i++) {
    if (matchedA.has(i)) continue;
    for (let j = 0; j < blocksB.length; j++) {
      if (matchedB.has(j)) continue;
      const a = blocksA[i];
      const b = blocksB[j];
      const sim = tokenSimilarity(a.tokens, b.tokens);
      if (sim >= similarityThreshold) {
        scoredPairs.push({ i, j, sim });
      }
    }
  }

  scoredPairs.sort((p1, p2) => p2.sim - p1.sim);
  for (const pair of scoredPairs) {
    if (matchedA.has(pair.i) || matchedB.has(pair.j)) continue;
    matchedA.add(pair.i);
    matchedB.add(pair.j);
    matches.push({
      indexA: pair.i,
      indexB: pair.j,
      a: blocksA[pair.i],
      b: blocksB[pair.j],
      similarity: pair.sim,
      exact: false
    });
  }

  // Sort by indexA to compute LIS over indexB
  matches.sort((m1, m2) => m1.indexA - m2.indexA);
  const lisInput = matches.map((m) => ({
    indexB: m.indexB,
    weight: m.a.rawLines.length
  }));
  const stationarySet = weightedLisIndices(lisInput);

  for (let idx = 0; idx < matches.length; idx++) {
    const m = matches[idx];
    const orderChanged = !stationarySet.has(idx);
    const parentChanged = m.a.parent !== m.b.parent;
    m.moved = orderChanged || parentChanged;
  }

  return { matches, matchedA, matchedB };
}

export function diffAst(textA, textB, langInput = 'js', options = {}) {
  const t0 = nowMs();
  const lang = detectLanguage(langInput, textA || textB);
  const similarityThreshold = options.similarityThreshold ?? 0.65;
  const linesA = splitLines(textA);
  const linesB = splitLines(textB);

  const naive = diffLines(linesA, linesB);
  const allBlocksA = parseBlocks(textA, lang);
  const allBlocksB = parseBlocks(textB, lang);

  // Top-level blocks for primary structural diff
  const topA = allBlocksA.filter((b) => b.depth === 0);
  const topB = allBlocksB.filter((b) => b.depth === 0);

  const { matches: topMatches, matchedA: topMatchedA, matchedB: topMatchedB } = matchBlockSets(
    topA,
    topB,
    similarityThreshold
  );

  // Also check nested methods inside matched stationary containers (e.g. moved methods inside a class)
  const nestedMatches = [];
  for (const m of topMatches) {
    if (!m.moved && (m.a.kind === 'class' || m.a.kind === 'impl' || m.a.kind === 'namespace' || m.a.kind === 'struct')) {
      const childrenA = allBlocksA.filter((b) => b.parent === m.a.qualifiedName);
      const childrenB = allBlocksB.filter((b) => b.parent === m.b.qualifiedName);
      if (childrenA.length > 1 && childrenB.length > 1) {
        const sub = matchBlockSets(childrenA, childrenB, similarityThreshold);
        for (const sm of sub.matches) {
          if (sm.moved) nestedMatches.push(sm);
        }
      }
    }
  }

  const allMovedMatches = [
    ...topMatches.filter((m) => m.moved),
    ...nestedMatches
  ];

  const moves = [];
  const movedOldLines = new Set();
  const movedNewLines = new Set();
  let innerEditCount = 0;

  for (const m of allMovedMatches) {
    // Only consider moved+edited valid when exact or >= similarityThreshold
    if (!m.exact && m.similarity < similarityThreshold) continue;

    const innerDiff = diffLines(m.a.rawLines, m.b.rawLines);
    const innerEdits = innerDiff.ops
      .filter((op) => op.type !== 'equal')
      .map((op) => ({
        type: op.type,
        line: op.line,
        oldLine: op.oldLine !== null ? m.a.startLine + op.oldLine - 1 : null,
        newLine: op.newLine !== null ? m.b.startLine + op.newLine - 1 : null
      }));

    innerEditCount += innerEdits.length;

    for (let ln = m.a.startLine; ln <= m.a.endLine; ln++) movedOldLines.add(ln);
    for (let ln = m.b.startLine; ln <= m.b.endLine; ln++) movedNewLines.add(ln);

    moves.push({
      symbol: m.b.qualifiedName,
      oldSymbol: m.a.qualifiedName,
      kind: m.b.kind,
      fromLine: m.a.startLine,
      fromEndLine: m.a.endLine,
      toLine: m.b.startLine,
      toEndLine: m.b.endLine,
      similarity: Number(m.similarity.toFixed(4)),
      exact: m.exact,
      lineCount: m.b.rawLines.length,
      innerEdits,
      innerHunks: innerDiff.hunks
    });
  }

  // Compute residual line diff excluding moved block lines so hunks stay clean
  const residualA = [];
  const residualAMap = [];
  for (let i = 0; i < linesA.length; i++) {
    if (!movedOldLines.has(i + 1)) {
      residualA.push(linesA[i]);
      residualAMap.push(i + 1);
    }
  }

  const residualB = [];
  const residualBMap = [];
  for (let j = 0; j < linesB.length; j++) {
    if (!movedNewLines.has(j + 1)) {
      residualB.push(linesB[j]);
      residualBMap.push(j + 1);
    }
  }

  const residualDiff = diffLines(residualA, residualB);
  const mappedResidualOps = residualDiff.ops.map((op) => ({
    type: op.type,
    line: op.line,
    oldLine: op.oldLine !== null ? residualAMap[op.oldLine - 1] : null,
    newLine: op.newLine !== null ? residualBMap[op.newLine - 1] : null
  }));
  const hunks = buildHunks(mappedResidualOps, options.contextLines ?? 3);

  const naiveChurn = naive.stats.added + naive.stats.removed;
  const residualChurn = residualDiff.stats.added + residualDiff.stats.removed;
  const structuralChurn = residualChurn + innerEditCount;
  const linesSaved = Math.max(0, naiveChurn - structuralChurn);

  const addedBlocks = topB
    .filter((_, idx) => !topMatchedB.has(idx))
    .map((b) => ({ symbol: b.qualifiedName, kind: b.kind, startLine: b.startLine, endLine: b.endLine }));
  const removedBlocks = topA
    .filter((_, idx) => !topMatchedA.has(idx))
    .map((b) => ({ symbol: b.qualifiedName, kind: b.kind, startLine: b.startLine, endLine: b.endLine }));

  const elapsedMs = Number((nowMs() - t0).toFixed(3));

  return {
    mode: 'ast',
    lang,
    moves,
    hunks,
    matches: topMatches.map((m) => ({
      oldSymbol: m.a.qualifiedName,
      symbol: m.b.qualifiedName,
      kind: m.b.kind,
      fromLine: m.a.startLine,
      fromEndLine: m.a.endLine,
      toLine: m.b.startLine,
      toEndLine: m.b.endLine,
      moved: m.moved,
      exact: m.exact,
      similarity: Number(m.similarity.toFixed(4))
    })),
    addedBlocks,
    removedBlocks,
    lineDiff: naive,
    stats: {
      movedBlocks: moves.length,
      exactMoves: moves.filter((m) => m.exact).length,
      editedMoves: moves.filter((m) => !m.exact).length,
      naiveChurn,
      structuralChurn,
      linesSaved,
      added: residualDiff.stats.added + moves.reduce((s, mv) => s + mv.innerEdits.filter((e) => e.type === 'insert').length, 0),
      removed: residualDiff.stats.removed + moves.reduce((s, mv) => s + mv.innerEdits.filter((e) => e.type === 'delete').length, 0),
      elapsedMs
    }
  };
}

export function formatDiff(result, labelA = 'a', labelB = 'b') {
  const out = [];
  out.push(`--- ${labelA}`);
  out.push(`+++ ${labelB}`);

  if (result.moves && result.moves.length > 0) {
    out.push(`# Structural moves detected: ${result.moves.length} (lines saved: ${result.stats.linesSaved})`);
    for (const mv of result.moves) {
      const tag = mv.exact ? 'exact' : `sim=${mv.similarity}`;
      out.push(`@move ${mv.kind} ${mv.symbol}: L${mv.fromLine}-L${mv.fromEndLine} -> L${mv.toLine}-L${mv.toEndLine} (${tag})`);
      for (const edit of mv.innerEdits) {
        const prefix = edit.type === 'insert' ? '+' : '-';
        out.push(`  ${prefix} ${edit.line}`);
      }
    }
  }

  for (const hunk of result.hunks || []) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const entry of hunk.lines) {
      const prefix = entry.type === 'insert' ? '+' : entry.type === 'delete' ? '-' : ' ';
      out.push(`${prefix}${entry.line}`);
    }
  }

  return out.join('\n');
}
