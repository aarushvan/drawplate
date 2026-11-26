// Cleave structural three-way merge engine (pure isomorphic ESM)

import { detectLanguage, parseBlocks, splitLines } from './parser.mjs';
import { diffAst, diffLines } from './diff.mjs';

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Extract change spans indexed against base lines (0-based half-open [baseStart, baseEnd))
function extractBaseSpans(baseLines, targetLines) {
  const { ops } = diffLines(baseLines, targetLines);
  const spans = [];
  let basePos = 0;
  let i = 0;

  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      basePos++;
      i++;
      continue;
    }
    const baseStart = basePos;
    const inserted = [];
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'delete') {
        basePos++;
      } else if (ops[i].type === 'insert') {
        inserted.push(ops[i].line);
      }
      i++;
    }
    spans.push({ baseStart, baseEnd: basePos, lines: inserted });
  }
  return spans;
}

// Classic diff3 line-level three-way merge over Myers diffs
export function mergeLines3(baseText, leftText, rightText) {
  const t0 = nowMs();
  const base = Array.isArray(baseText) ? baseText : splitLines(baseText);
  const left = Array.isArray(leftText) ? leftText : splitLines(leftText);
  const right = Array.isArray(rightText) ? rightText : splitLines(rightText);

  if (arraysEqual(left, right)) {
    return {
      merged: left.join('\n'),
      lines: left,
      hasConflicts: false,
      conflicts: [],
      elapsedMs: Number((nowMs() - t0).toFixed(3))
    };
  }
  if (arraysEqual(base, left)) {
    return {
      merged: right.join('\n'),
      lines: right,
      hasConflicts: false,
      conflicts: [],
      elapsedMs: Number((nowMs() - t0).toFixed(3))
    };
  }
  if (arraysEqual(base, right)) {
    return {
      merged: left.join('\n'),
      lines: left,
      hasConflicts: false,
      conflicts: [],
      elapsedMs: Number((nowMs() - t0).toFixed(3))
    };
  }

  const leftSpans = extractBaseSpans(base, left);
  const rightSpans = extractBaseSpans(base, right);

  const out = [];
  const conflicts = [];
  let baseIdx = 0;
  let li = 0;
  let ri = 0;

  const spansOverlap = (a, b) => {
    if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) {
      return a.baseStart === b.baseStart;
    }
    if (a.baseStart === a.baseEnd) {
      return a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd;
    }
    if (b.baseStart === b.baseEnd) {
      return b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd;
    }
    return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
  };

  const applySpansToSlice = (sliceStart, sliceEnd, spans) => {
    const res = [];
    let pos = sliceStart;
    for (const sp of spans) {
      while (pos < sp.baseStart) {
        res.push(base[pos++]);
      }
      for (const ln of sp.lines) res.push(ln);
      pos = sp.baseEnd;
    }
    while (pos < sliceEnd) {
      res.push(base[pos++]);
    }
    return res;
  };

  while (li < leftSpans.length || ri < rightSpans.length) {
    const ls = li < leftSpans.length ? leftSpans[li] : null;
    const rs = ri < rightSpans.length ? rightSpans[ri] : null;

    if (ls && (!rs || (ls.baseEnd < rs.baseStart && !spansOverlap(ls, rs)))) {
      while (baseIdx < ls.baseStart) out.push(base[baseIdx++]);
      for (const ln of ls.lines) out.push(ln);
      baseIdx = ls.baseEnd;
      li++;
      continue;
    }

    if (rs && (!ls || (rs.baseEnd < ls.baseStart && !spansOverlap(ls, rs)))) {
      while (baseIdx < rs.baseStart) out.push(base[baseIdx++]);
      for (const ln of rs.lines) out.push(ln);
      baseIdx = rs.baseEnd;
      ri++;
      continue;
    }

    // Overlapping cluster of spans
    let clusterStart = Math.min(ls.baseStart, rs.baseStart);
    let clusterEnd = Math.max(ls.baseEnd, rs.baseEnd);
    const lCluster = [ls];
    const rCluster = [rs];
    li++;
    ri++;

    let grew = true;
    while (grew) {
      grew = false;
      while (li < leftSpans.length && leftSpans[li].baseStart <= clusterEnd) {
        lCluster.push(leftSpans[li]);
        clusterEnd = Math.max(clusterEnd, leftSpans[li].baseEnd);
        li++;
        grew = true;
      }
      while (ri < rightSpans.length && rightSpans[ri].baseStart <= clusterEnd) {
        rCluster.push(rightSpans[ri]);
        clusterEnd = Math.max(clusterEnd, rightSpans[ri].baseEnd);
        ri++;
        grew = true;
      }
    }

    while (baseIdx < clusterStart) out.push(base[baseIdx++]);

    const leftVersion = applySpansToSlice(clusterStart, clusterEnd, lCluster);
    const rightVersion = applySpansToSlice(clusterStart, clusterEnd, rCluster);

    if (arraysEqual(leftVersion, rightVersion)) {
      for (const ln of leftVersion) out.push(ln);
    } else {
      const startLine = out.length + 1;
      out.push('<<<<<<< left');
      for (const ln of leftVersion) out.push(ln);
      out.push('=======');
      for (const ln of rightVersion) out.push(ln);
      out.push('>>>>>>> right');
      const endLine = out.length;

      conflicts.push({
        id: `conflict-${conflicts.length + 1}`,
        kind: 'edit',
        symbol: null,
        startLine,
        endLine,
        baseLines: base.slice(clusterStart, clusterEnd),
        leftLines: leftVersion,
        rightLines: rightVersion
      });
    }

    baseIdx = clusterEnd;
  }

  while (baseIdx < base.length) out.push(base[baseIdx++]);

  return {
    merged: out.join('\n'),
    lines: out,
    hasConflicts: conflicts.length > 0,
    conflicts,
    elapsedMs: Number((nowMs() - t0).toFixed(3))
  };
}

// Partition a file into alternating gap segments and top-level parsed blocks
function segmentDocument(lines, topBlocks) {
  const segments = [];
  let cursor = 1; // 1-based line

  for (let i = 0; i < topBlocks.length; i++) {
    const blk = topBlocks[i];
    if (blk.startLine > cursor) {
      segments.push({
        type: 'gap',
        startLine: cursor,
        endLine: blk.startLine - 1,
        lines: lines.slice(cursor - 1, blk.startLine - 1)
      });
    }
    segments.push({
      type: 'block',
      blockIndex: i,
      block: blk,
      startLine: blk.startLine,
      endLine: blk.endLine,
      lines: blk.rawLines
    });
    cursor = blk.endLine + 1;
  }

  if (cursor <= lines.length) {
    segments.push({
      type: 'gap',
      startLine: cursor,
      endLine: lines.length,
      lines: lines.slice(cursor - 1)
    });
  }

  return segments;
}

function buildMatchMaps(baseBlocks, sideBlocks, sideDiff) {
  const baseByStart = new Map();
  for (let i = 0; i < baseBlocks.length; i++) {
    baseByStart.set(baseBlocks[i].startLine, i);
  }
  const sideByStart = new Map();
  for (let j = 0; j < sideBlocks.length; j++) {
    sideByStart.set(sideBlocks[j].startLine, j);
  }

  const baseToSide = new Map();
  const sideToBase = new Map();
  const movedBaseIndices = new Set();

  for (const m of sideDiff.matches) {
    const bi = baseByStart.get(m.fromLine);
    const si = sideByStart.get(m.toLine);
    if (bi === undefined || si === undefined) continue;
    baseToSide.set(bi, { sideIndex: si, block: sideBlocks[si], match: m });
    sideToBase.set(si, { baseIndex: bi, block: baseBlocks[bi], match: m });
    if (m.moved) movedBaseIndices.add(bi);
  }

  return { baseToSide, sideToBase, movedBaseIndices };
}

export function merge3(baseText, leftText, rightText, langInput = 'js', options = {}) {
  const t0 = nowMs();
  const lang = detectLanguage(langInput, baseText || leftText || rightText);
  const baseLines = splitLines(baseText);
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);

  const baseTop = parseBlocks(baseText, lang).filter((b) => b.depth === 0);
  const leftTop = parseBlocks(leftText, lang).filter((b) => b.depth === 0);
  const rightTop = parseBlocks(rightText, lang).filter((b) => b.depth === 0);

  const diffLeft = diffAst(baseText, leftText, lang, options);
  const diffRight = diffAst(baseText, rightText, lang, options);

  const leftMap = buildMatchMaps(baseTop, leftTop, diffLeft);
  const rightMap = buildMatchMaps(baseTop, rightTop, diffRight);

  const leftHasMoves = leftMap.movedBaseIndices.size > 0;
  const rightHasMoves = rightMap.movedBaseIndices.size > 0;

  // If neither branch moved structural blocks, perform direct line-level 3-way merge
  if (!leftHasMoves && !rightHasMoves) {
    const lineRes = mergeLines3(baseLines, leftLines, rightLines);
    return {
      merged: lineRes.merged,
      hasConflicts: lineRes.hasConflicts,
      conflicts: lineRes.conflicts,
      reconciledMoves: [],
      stats: {
        conflicts: lineRes.conflicts.length,
        reconciledMoves: 0,
        autoMergedBlocks: baseTop.length,
        elapsedMs: Number((nowMs() - t0).toFixed(3))
      }
    };
  }

  // Structural move-aware 3-way merge:
  // Choose layout driver (the side that performed the structural relocation)
  const driverSide = leftHasMoves ? 'left' : 'right';
  const otherSide = driverSide === 'left' ? 'right' : 'left';

  const driverLines = driverSide === 'left' ? leftLines : rightLines;
  const driverTop = driverSide === 'left' ? leftTop : rightTop;
  const driverMap = driverSide === 'left' ? leftMap : rightMap;

  const otherLines = otherSide === 'left' ? leftLines : rightLines;
  const otherTop = otherSide === 'left' ? leftTop : rightTop;
  const otherMap = otherSide === 'left' ? leftMap : rightMap;

  const driverSegments = segmentDocument(driverLines, driverTop);
  const baseSegments = segmentDocument(baseLines, baseTop);
  const otherSegments = segmentDocument(otherLines, otherTop);

  // Merge leading preamble (before first block) if all three start with a gap
  const preambleBase = baseSegments[0]?.type === 'gap' ? baseSegments[0].lines : [];
  const preambleDriver = driverSegments[0]?.type === 'gap' ? driverSegments[0].lines : [];
  const preambleOther = otherSegments[0]?.type === 'gap' ? otherSegments[0].lines : [];

  const mergedLines = [];
  const conflicts = [];
  const reconciledMoves = [];
  let autoMergedBlocks = 0;

  // Check if any block was moved to DIFFERENT positions by both sides
  const dualMovedBase = new Set();
  for (const bi of leftMap.movedBaseIndices) {
    if (rightMap.movedBaseIndices.has(bi)) {
      const lEntry = leftMap.baseToSide.get(bi);
      const rEntry = rightMap.baseToSide.get(bi);
      if (lEntry && rEntry && lEntry.sideIndex !== rEntry.sideIndex) {
        dualMovedBase.add(bi);
      }
    }
  }

  const emittedOtherBlocks = new Set();

  for (let segIdx = 0; segIdx < driverSegments.length; segIdx++) {
    const seg = driverSegments[segIdx];

    if (seg.type === 'gap') {
      if (segIdx === 0) {
        const pre = mergeLines3(preambleBase, preambleDriver, preambleOther);
        const offset = mergedLines.length;
        for (const ln of pre.lines) mergedLines.push(ln);
        for (const c of pre.conflicts) {
          conflicts.push({ ...c, id: `conflict-${conflicts.length + 1}`, startLine: c.startLine + offset, endLine: c.endLine + offset });
        }
      } else {
        for (const ln of seg.lines) mergedLines.push(ln);
      }
      continue;
    }

    // seg.type === 'block'
    const dBlock = seg.block;
    const baseRef = driverMap.sideToBase.get(seg.blockIndex);

    if (!baseRef) {
      // Newly added block on driver side -> keep as-is
      for (const ln of dBlock.rawLines) mergedLines.push(ln);
      autoMergedBlocks++;
      continue;
    }

    const bi = baseRef.baseIndex;
    const bBlock = baseRef.block;
    const otherRef = otherMap.baseToSide.get(bi);
    const driverMoved = driverMap.movedBaseIndices.has(bi);
    const driverEdited = !arraysEqual(bBlock.rawLines, dBlock.rawLines);

    if (!otherRef) {
      // Other side deleted this block
      if (!driverEdited && !driverMoved) {
        // Clean deletion
        continue;
      }
      // Delete vs move/edit conflict
      const startLine = mergedLines.length + 1;
      const leftVersion = driverSide === 'left' ? dBlock.rawLines : [];
      const rightVersion = driverSide === 'right' ? dBlock.rawLines : [];
      mergedLines.push('<<<<<<< left');
      for (const ln of leftVersion) mergedLines.push(ln);
      mergedLines.push('=======');
      for (const ln of rightVersion) mergedLines.push(ln);
      mergedLines.push('>>>>>>> right');
      conflicts.push({
        id: `conflict-${conflicts.length + 1}`,
        kind: 'delete-modify',
        symbol: bBlock.qualifiedName,
        startLine,
        endLine: mergedLines.length,
        baseLines: bBlock.rawLines,
        leftLines: leftVersion,
        rightLines: rightVersion
      });
      continue;
    }

    emittedOtherBlocks.add(otherRef.sideIndex);
    const oBlock = otherRef.block;
    const otherEdited = !arraysEqual(bBlock.rawLines, oBlock.rawLines);

    const leftVersion = driverSide === 'left' ? dBlock.rawLines : oBlock.rawLines;
    const rightVersion = driverSide === 'right' ? dBlock.rawLines : oBlock.rawLines;

    if (dualMovedBase.has(bi)) {
      const startLine = mergedLines.length + 1;
      mergedLines.push('<<<<<<< left');
      for (const ln of leftVersion) mergedLines.push(ln);
      mergedLines.push('=======');
      for (const ln of rightVersion) mergedLines.push(ln);
      mergedLines.push('>>>>>>> right');
      conflicts.push({
        id: `conflict-${conflicts.length + 1}`,
        kind: 'move',
        symbol: bBlock.qualifiedName,
        startLine,
        endLine: mergedLines.length,
        baseLines: bBlock.rawLines,
        leftLines: leftVersion,
        rightLines: rightVersion
      });
      continue;
    }

    // Reconcile body via 3-way line merge at driver's new position!
    const bodyMerge = mergeLines3(bBlock.rawLines, leftVersion, rightVersion);
    const offset = mergedLines.length;
    for (const ln of bodyMerge.lines) mergedLines.push(ln);

    if (bodyMerge.hasConflicts) {
      for (const c of bodyMerge.conflicts) {
        conflicts.push({
          ...c,
          id: `conflict-${conflicts.length + 1}`,
          symbol: bBlock.qualifiedName,
          startLine: c.startLine + offset,
          endLine: c.endLine + offset
        });
      }
    } else {
      autoMergedBlocks++;
      if (driverMoved) {
        let editedBy = 'none';
        if (driverEdited && otherEdited) editedBy = 'both';
        else if (driverEdited) editedBy = driverSide;
        else if (otherEdited) editedBy = otherSide;

        reconciledMoves.push({
          symbol: dBlock.qualifiedName,
          movedBy: driverSide,
          editedBy,
          fromLine: bBlock.startLine,
          toLine: offset + 1
        });
      }
    }
  }

  // Append any newly added blocks from the other side that were not in base
  for (let j = 0; j < otherTop.length; j++) {
    if (emittedOtherBlocks.has(j)) continue;
    if (otherMap.sideToBase.has(j)) continue; // existed in base, deleted by driver
    if (mergedLines.length > 0 && mergedLines[mergedLines.length - 1] !== '') {
      mergedLines.push('');
    }
    for (const ln of otherTop[j].rawLines) mergedLines.push(ln);
    autoMergedBlocks++;
  }

  return {
    merged: mergedLines.join('\n'),
    hasConflicts: conflicts.length > 0,
    conflicts,
    reconciledMoves,
    stats: {
      conflicts: conflicts.length,
      reconciledMoves: reconciledMoves.length,
      autoMergedBlocks,
      elapsedMs: Number((nowMs() - t0).toFixed(3))
    }
  };
}
