// Tapeline Cassette: Isomorphic (Browser + Node ESM) deterministic HTTP cassette schema,
// structural JSON schema drift detector, latency regression analyzer, and waterfall formatter.

export const CASSETTE_VERSION = '1.0';

const VOLATILE_HEADERS = new Set([
  'date',
  'etag',
  'x-request-id',
  'x-trace-id',
  'x-correlation-id',
  'server-timing',
  'age',
  'cf-ray',
  'x-tapeline-replay',
  'x-tapeline-entry-id',
]);

export function roundMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100) / 100;
}

export function roundSigned(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

export function sortHeaders(headers = {}) {
  const sorted = {};
  if (!headers || typeof headers !== 'object') return sorted;
  const entries = Object.entries(headers)
    .filter(([, val]) => val !== undefined && val !== null)
    .map(([key, val]) => [
      String(key).toLowerCase(),
      Array.isArray(val) ? val.join(', ') : String(val),
    ])
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    sorted[k] = v;
  }
  return sorted;
}

export function normalizePath(rawPath = '/') {
  if (!rawPath) return '/';
  const str = String(rawPath);
  return str.startsWith('/') ? str : `/${str}`;
}

export function canonicalizeQuery(rawPath = '/') {
  const normalized = normalizePath(rawPath);
  const qIndex = normalized.indexOf('?');
  if (qIndex === -1) return normalized;
  const pathname = normalized.slice(0, qIndex);
  const query = normalized.slice(qIndex + 1);
  if (!query) return pathname;
  const params = new URLSearchParams(query);
  const pairs = [...params.entries()].sort(([aK, aV], [bK, bV]) => {
    const kCmp = aK.localeCompare(bK);
    return kCmp !== 0 ? kCmp : aV.localeCompare(bV);
  });
  const canonical = new URLSearchParams();
  for (const [k, v] of pairs) canonical.append(k, v);
  return `${pathname}?${canonical.toString()}`;
}

export function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortObjectKeys(value[key]);
    }
    return out;
  }
  return value;
}

export function tryParseBody(rawBody, headers = {}) {
  if (rawBody === null || rawBody === undefined) return null;
  if (typeof rawBody === 'object' && !(rawBody instanceof Uint8Array)) {
    return sortObjectKeys(rawBody);
  }
  const text = typeof rawBody === 'string'
    ? rawBody
    : new TextDecoder().decode(rawBody);
  if (text.length === 0) return null;

  const normalizedHeaders = sortHeaders(headers);
  const contentType = normalizedHeaders['content-type'] || '';
  const looksJson = contentType.includes('json') ||
    (text.trim().startsWith('{') && text.trim().endsWith('}')) ||
    (text.trim().startsWith('[') && text.trim().endsWith(']'));

  if (looksJson) {
    try {
      return sortObjectKeys(JSON.parse(text));
    } catch {
      return text;
    }
  }
  return text;
}

export function createEntry(raw, index = 0) {
  const id = raw.id ? String(raw.id) : String(index + 1).padStart(3, '0');
  const method = String(raw.method || 'GET').toUpperCase();
  const path = normalizePath(raw.path || '/');
  const status = Number.isFinite(Number(raw.status)) ? Number(raw.status) : 200;
  const ttfbMs = roundMs(raw.ttfbMs ?? 0);
  const totalMs = roundMs(Math.max(ttfbMs, Number(raw.totalMs ?? ttfbMs)));
  const reqHeaders = sortHeaders(raw.reqHeaders || {});
  const resHeaders = sortHeaders(raw.resHeaders || {});
  const reqBody = tryParseBody(raw.reqBody, reqHeaders);
  const resBody = tryParseBody(raw.resBody, resHeaders);

  return {
    id,
    method,
    path,
    status,
    ttfbMs,
    totalMs,
    reqHeaders,
    reqBody,
    resHeaders,
    resBody,
  };
}

export function createCassette({
  version = CASSETTE_VERSION,
  recordedAt = new Date().toISOString(),
  target = 'http://127.0.0.1:0',
  entries = [],
} = {}) {
  return {
    version: String(version),
    recordedAt: String(recordedAt),
    target: String(target),
    entries: entries.map((entry, idx) => createEntry(entry, idx)),
  };
}

export function canonicalizeCassette(cassette) {
  if (!cassette || typeof cassette !== 'object') {
    throw new TypeError('Invalid cassette: expected an object');
  }
  return createCassette({
    version: cassette.version || CASSETTE_VERSION,
    recordedAt: cassette.recordedAt || new Date(0).toISOString(),
    target: cassette.target || 'http://127.0.0.1:0',
    entries: Array.isArray(cassette.entries) ? cassette.entries : [],
  });
}

export function serializeCassette(cassette) {
  return `${JSON.stringify(canonicalizeCassette(cassette), null, 2)}\n`;
}

export function parseCassette(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.entries)) {
    throw new Error('Invalid Tapeline cassette format: missing entries array');
  }
  return canonicalizeCassette(obj);
}

export function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function inferSchema(value) {
  const type = valueType(value);
  if (type === 'object') {
    const properties = {};
    for (const key of Object.keys(value).sort()) {
      properties[key] = inferSchema(value[key]);
    }
    return { type: 'object', properties };
  }
  if (type === 'array') {
    if (value.length === 0) {
      return { type: 'array', itemTypes: [], items: null };
    }
    const itemTypes = [...new Set(value.map(valueType))].sort();
    // Merge object properties across array items for stable schema comparison
    const objectItems = value.filter((item) => valueType(item) === 'object');
    let mergedItem = null;
    if (objectItems.length > 0) {
      const mergedProps = {};
      for (const item of objectItems) {
        for (const key of Object.keys(item).sort()) {
          if (!(key in mergedProps)) {
            mergedProps[key] = inferSchema(item[key]);
          }
        }
      }
      mergedItem = { type: 'object', properties: mergedProps };
    } else {
      mergedItem = inferSchema(value[0]);
    }
    return { type: 'array', itemTypes, items: mergedItem };
  }
  return { type };
}

export function diffJsonSchema(beforeVal, afterVal, jsonPath = '$') {
  const drifts = [];
  const beforeType = valueType(beforeVal);
  const afterType = valueType(afterVal);

  if (beforeType !== afterType) {
    drifts.push({
      kind: 'type_changed',
      path: jsonPath,
      beforeType,
      afterType,
      breaking: true,
    });
    return drifts;
  }

  if (beforeType === 'object') {
    const beforeKeys = new Set(Object.keys(beforeVal));
    const afterKeys = new Set(Object.keys(afterVal));
    const allKeys = [...new Set([...beforeKeys, ...afterKeys])].sort();

    for (const key of allKeys) {
      const childPath = `${jsonPath}.${key}`;
      const inBefore = beforeKeys.has(key);
      const inAfter = afterKeys.has(key);
      if (inBefore && !inAfter) {
        drifts.push({
          kind: 'removed',
          path: childPath,
          beforeType: valueType(beforeVal[key]),
          afterType: null,
          breaking: true,
        });
      } else if (!inBefore && inAfter) {
        drifts.push({
          kind: 'added',
          path: childPath,
          beforeType: null,
          afterType: valueType(afterVal[key]),
          breaking: false,
        });
      } else {
        drifts.push(...diffJsonSchema(beforeVal[key], afterVal[key], childPath));
      }
    }
    return drifts;
  }

  if (beforeType === 'array') {
    const beforeSample = mergeArrayObjects(beforeVal);
    const afterSample = mergeArrayObjects(afterVal);
    if (beforeSample !== undefined && afterSample !== undefined) {
      drifts.push(...diffJsonSchema(beforeSample, afterSample, `${jsonPath}[]`));
    }
    return drifts;
  }

  return drifts;
}

function mergeArrayObjects(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const objects = arr.filter((v) => valueType(v) === 'object');
  if (objects.length === arr.length) {
    const merged = {};
    for (const obj of objects) {
      for (const k of Object.keys(obj)) {
        if (!(k in merged) || merged[k] === null) {
          merged[k] = obj[k];
        }
      }
    }
    return merged;
  }
  return arr[0];
}

function buildRouteMap(entries) {
  const counts = new Map();
  const map = new Map();
  for (const entry of entries) {
    const baseKey = `${entry.method} ${entry.path}`;
    const occ = (counts.get(baseKey) || 0) + 1;
    counts.set(baseKey, occ);
    const key = occ === 1 ? baseKey : `${baseKey} #${occ}`;
    map.set(key, entry);
  }
  return map;
}

function diffHeaders(beforeHeaders = {}, afterHeaders = {}, ignoreVolatile = true) {
  const b = sortHeaders(beforeHeaders);
  const a = sortHeaders(afterHeaders);
  const changes = [];
  const allKeys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  for (const key of allKeys) {
    if (ignoreVolatile && VOLATILE_HEADERS.has(key)) continue;
    if (!(key in b)) {
      changes.push({ kind: 'added', header: key, before: null, after: a[key] });
    } else if (!(key in a)) {
      changes.push({ kind: 'removed', header: key, before: b[key], after: null });
    } else if (b[key] !== a[key]) {
      changes.push({ kind: 'changed', header: key, before: b[key], after: a[key] });
    }
  }
  return changes;
}

export function diffCassettes(beforeInput, afterInput, options = {}) {
  const before = parseCassette(beforeInput);
  const after = parseCassette(afterInput);
  const ignoreVolatileHeaders = options.ignoreVolatileHeaders !== false;
  const regressionThresholdPct = Number.isFinite(options.regressionThresholdPct)
    ? options.regressionThresholdPct
    : 20;

  const beforeMap = buildRouteMap(before.entries);
  const afterMap = buildRouteMap(after.entries);

  const addedRoutes = [];
  const removedRoutes = [];
  const statusChanges = [];
  const schemaChanges = [];
  const headerChanges = [];
  const latencyDeltas = [];
  let matchedCount = 0;

  for (const [key, bEntry] of beforeMap.entries()) {
    if (!afterMap.has(key)) {
      removedRoutes.push({
        key,
        method: bEntry.method,
        path: bEntry.path,
        status: bEntry.status,
      });
    }
  }

  for (const [key, aEntry] of afterMap.entries()) {
    if (!beforeMap.has(key)) {
      addedRoutes.push({
        key,
        method: aEntry.method,
        path: aEntry.path,
        status: aEntry.status,
      });
      continue;
    }

    matchedCount += 1;
    const bEntry = beforeMap.get(key);

    if (bEntry.status !== aEntry.status) {
      statusChanges.push({
        key,
        method: aEntry.method,
        path: aEntry.path,
        beforeStatus: bEntry.status,
        afterStatus: aEntry.status,
        breaking: aEntry.status >= 400 || Math.floor(bEntry.status / 100) !== Math.floor(aEntry.status / 100),
      });
    }

    const drifts = diffJsonSchema(bEntry.resBody, aEntry.resBody, '$');
    if (drifts.length > 0) {
      schemaChanges.push({
        key,
        method: aEntry.method,
        path: aEntry.path,
        drifts,
        breaking: drifts.some((d) => d.breaking),
      });
    }

    const hDiffs = diffHeaders(bEntry.resHeaders, aEntry.resHeaders, ignoreVolatileHeaders);
    if (hDiffs.length > 0) {
      headerChanges.push({
        key,
        method: aEntry.method,
        path: aEntry.path,
        changes: hDiffs,
      });
    }

    const ttfbDeltaMs = roundSigned(aEntry.ttfbMs - bEntry.ttfbMs);
    const totalDeltaMs = roundSigned(aEntry.totalMs - bEntry.totalMs);
    const ttfbDeltaPct = bEntry.ttfbMs > 0
      ? roundSigned(((aEntry.ttfbMs - bEntry.ttfbMs) / bEntry.ttfbMs) * 100)
      : (aEntry.ttfbMs > 0 ? 100 : 0);
    const totalDeltaPct = bEntry.totalMs > 0
      ? roundSigned(((aEntry.totalMs - bEntry.totalMs) / bEntry.totalMs) * 100)
      : (aEntry.totalMs > 0 ? 100 : 0);

    latencyDeltas.push({
      key,
      method: aEntry.method,
      path: aEntry.path,
      beforeTtfbMs: bEntry.ttfbMs,
      afterTtfbMs: aEntry.ttfbMs,
      ttfbDeltaMs,
      ttfbDeltaPct,
      beforeTotalMs: bEntry.totalMs,
      afterTotalMs: aEntry.totalMs,
      totalDeltaMs,
      totalDeltaPct,
      regressed: totalDeltaPct >= regressionThresholdPct && totalDeltaMs >= 2,
    });
  }

  const totalSchemaDrifts = schemaChanges.reduce((acc, sc) => acc + sc.drifts.length, 0);
  const breakingSchemaDrifts = schemaChanges.reduce(
    (acc, sc) => acc + sc.drifts.filter((d) => d.breaking).length,
    0,
  );
  const breakingCount = removedRoutes.length +
    statusChanges.filter((s) => s.breaking).length +
    breakingSchemaDrifts;

  const avgLatencyDeltaPct = latencyDeltas.length > 0
    ? roundSigned(latencyDeltas.reduce((acc, l) => acc + l.totalDeltaPct, 0) / latencyDeltas.length)
    : 0;
  const maxLatencyDeltaPct = latencyDeltas.length > 0
    ? Math.max(...latencyDeltas.map((l) => l.totalDeltaPct))
    : 0;

  return {
    beforeTarget: before.target,
    afterTarget: after.target,
    addedRoutes,
    removedRoutes,
    statusChanges,
    schemaChanges,
    headerChanges,
    latencyDeltas,
    summary: {
      totalBefore: before.entries.length,
      totalAfter: after.entries.length,
      matched: matchedCount,
      added: addedRoutes.length,
      removed: removedRoutes.length,
      statusChanges: statusChanges.length,
      schemaDrifts: totalSchemaDrifts,
      breakingChanges: breakingCount,
      avgLatencyDeltaPct,
      maxLatencyDeltaPct,
      hasBreakingChanges: breakingCount > 0,
    },
  };
}

export function estimateBodyBytes(body) {
  if (body === null || body === undefined) return 0;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new TextEncoder().encode(text).byteLength;
}

export function computeWaterfall(cassetteInput) {
  const cassette = parseCassette(cassetteInput);
  const maxTotalMs = Math.max(
    1,
    ...cassette.entries.map((e) => e.totalMs || 0),
  );
  let cumulativeStartMs = 0;

  const rows = cassette.entries.map((entry) => {
    const downloadMs = roundMs(Math.max(0, entry.totalMs - entry.ttfbMs));
    const ttfbPct = roundMs((entry.ttfbMs / maxTotalMs) * 100);
    const downloadPct = roundMs((downloadMs / maxTotalMs) * 100);
    const totalPct = roundMs((entry.totalMs / maxTotalMs) * 100);
    const statusGroup = `${Math.floor(entry.status / 100)}xx`;
    const resBytes = estimateBodyBytes(entry.resBody);
    const reqBytes = estimateBodyBytes(entry.reqBody);
    const row = {
      id: entry.id,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      statusGroup,
      ttfbMs: entry.ttfbMs,
      downloadMs,
      totalMs: entry.totalMs,
      offsetMs: roundMs(cumulativeStartMs),
      ttfbPct,
      downloadPct,
      totalPct,
      reqBytes,
      resBytes,
    };
    cumulativeStartMs += entry.totalMs;
    return row;
  });

  return {
    target: cassette.target,
    recordedAt: cassette.recordedAt,
    count: rows.length,
    maxTotalMs: roundMs(maxTotalMs),
    cumulativeMs: roundMs(cumulativeStartMs),
    rows,
  };
}

export function formatWaterfall(cassetteInput, options = {}) {
  const barWidth = Math.max(10, Number(options.barWidth) || 28);
  const wf = computeWaterfall(cassetteInput);
  if (wf.rows.length === 0) {
    return 'Tapeline Waterfall (0 entries)\n';
  }

  const lines = [
    `Tapeline Waterfall | target=${wf.target} | entries=${wf.count} | max=${wf.maxTotalMs.toFixed(2)}ms`,
    'ID   METHOD  STATUS  TTFB(ms)  TOTAL(ms)  TIMELINE                         PATH',
    '---  ------  ------  --------  ---------  -------------------------------  ----',
  ];

  for (const row of wf.rows) {
    const ttfbCols = Math.min(barWidth, Math.max(1, Math.round((row.ttfbMs / wf.maxTotalMs) * barWidth)));
    const totalCols = Math.min(barWidth, Math.max(ttfbCols, Math.round((row.totalMs / wf.maxTotalMs) * barWidth)));
    const dlCols = Math.max(0, totalCols - ttfbCols);
    const padCols = Math.max(0, barWidth - totalCols);
    const bar = `[${'#'.repeat(ttfbCols)}${'='.repeat(dlCols)}${'.'.repeat(padCols)}]`;

    lines.push(
      `${row.id.padEnd(3)}  ` +
      `${row.method.padEnd(6)}  ` +
      `${String(row.status).padEnd(6)}  ` +
      `${row.ttfbMs.toFixed(2).padStart(8)}  ` +
      `${row.totalMs.toFixed(2).padStart(9)}  ` +
      `${bar}  ` +
      `${row.path}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

export function formatDiffReport(diff) {
  const s = diff.summary;
  const lines = [
    `Tapeline Diff | before=${s.totalBefore} entries | after=${s.totalAfter} entries | matched=${s.matched}`,
    `Summary: +${s.added} added, -${s.removed} removed, ${s.statusChanges} status changes, ${s.schemaDrifts} schema drifts, ${s.breakingChanges} breaking`,
  ];

  if (diff.addedRoutes.length > 0) {
    lines.push('', 'Added Routes:');
    for (const r of diff.addedRoutes) {
      lines.push(`  + ${r.method} ${r.path} (${r.status})`);
    }
  }
  if (diff.removedRoutes.length > 0) {
    lines.push('', 'Removed Routes (breaking):');
    for (const r of diff.removedRoutes) {
      lines.push(`  - ${r.method} ${r.path} (${r.status})`);
    }
  }
  if (diff.statusChanges.length > 0) {
    lines.push('', 'Status Changes:');
    for (const sc of diff.statusChanges) {
      lines.push(`  ! ${sc.key}: ${sc.beforeStatus} -> ${sc.afterStatus}`);
    }
  }
  if (diff.schemaChanges.length > 0) {
    lines.push('', 'Schema Drift:');
    for (const sc of diff.schemaChanges) {
      lines.push(`  * ${sc.key}`);
      for (const d of sc.drifts) {
        if (d.kind === 'type_changed') {
          lines.push(`      ~ ${d.path}: ${d.beforeType} -> ${d.afterType} [breaking]`);
        } else if (d.kind === 'removed') {
          lines.push(`      - ${d.path} (${d.beforeType}) [breaking]`);
        } else {
          lines.push(`      + ${d.path} (${d.afterType})`);
        }
      }
    }
  }
  if (diff.latencyDeltas.length > 0) {
    lines.push('', 'Latency Deltas:');
    for (const l of diff.latencyDeltas) {
      const sign = l.totalDeltaPct >= 0 ? '+' : '';
      const flag = l.regressed ? ' [REGRESSION]' : '';
      lines.push(
        `  t ${l.key}: ${l.beforeTotalMs.toFixed(2)}ms -> ${l.afterTotalMs.toFixed(2)}ms (${sign}${l.totalDeltaPct.toFixed(1)}%)${flag}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function matchCassetteEntry(cassette, method, rawPath, cursorMap = null) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const normalized = normalizePath(rawPath || '/');
  const canonical = canonicalizeQuery(normalized);

  // First try exact method + path match
  let matches = cassette.entries.filter(
    (entry) => entry.method === upperMethod && entry.path === normalized,
  );
  // Fallback to canonicalized query order match
  if (matches.length === 0) {
    matches = cassette.entries.filter(
      (entry) => entry.method === upperMethod && canonicalizeQuery(entry.path) === canonical,
    );
  }
  if (matches.length === 0) return null;

  if (!cursorMap) return matches[0];
  const key = `${upperMethod} ${canonical}`;
  const seen = cursorMap.get(key) || 0;
  cursorMap.set(key, seen + 1);
  return matches[Math.min(seen, matches.length - 1)];
}
