// Cadastre code symbol, import, call-graph extractor and 128-dim int8 feature-hashed embedder
// Pure isomorphic ESM: zero Node-specific dependencies (works identically in Node and Browser)

export const EMBEDDING_DIMS = 128;

const EXT_TO_LANG = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  ts: 'ts',
  tsx: 'ts',
  py: 'python',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  wgsl: 'glsl',
  rs: 'rust',
  go: 'go'
};

const CALL_STOPWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'finally',
  'try', 'return', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'sizeof',
  'void', 'await', 'async', 'yield', 'function', 'class', 'super', 'this',
  'import', 'export', 'from', 'as', 'in', 'of', 'const', 'let', 'var',
  'def', 'elif', 'except', 'with', 'lambda', 'assert', 'print', 'pass',
  'fn', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'loop', 'where',
  'func', 'type', 'interface', 'defer', 'go', 'select', 'range', 'make',
  'int', 'float', 'double', 'bool', 'char', 'auto', 'static', 'inline',
  'constexpr', 'template', 'typename', 'namespace', 'using', 'vec2', 'vec3',
  'vec4', 'mat2', 'mat3', 'mat4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3',
  'uvec4', 'sampler2D', 'layout', 'uniform', 'varying', 'attribute', 'precision',
  'require', 'define', 'include', 'pragma'
]);

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function vectorToBase64(vec) {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(triplet >> 18) & 63];
    out += B64_CHARS[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64_CHARS[(triplet >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[triplet & 63] : '=';
  }
  return out;
}

export function base64ToVector(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;
  const byteLen = (clean.length * 3) / 4 - pad;
  const bytes = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)] & 63;
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)] & 63;
    const c2 = clean[i + 2] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)] & 63;
    const c3 = clean[i + 3] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)] & 63;
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (p < byteLen) bytes[p++] = (triplet >> 16) & 255;
    if (p < byteLen) bytes[p++] = (triplet >> 8) & 255;
    if (p < byteLen) bytes[p++] = triplet & 255;
  }
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function detectCodeLanguage(filePath = '') {
  const m = String(filePath).toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m && EXT_TO_LANG[m[1]]) return EXT_TO_LANG[m[1]];
  return 'js';
}

// Split code identifiers into normalized searchable tokens (camelCase + snake_case + whole token)
export function tokenizeIdentifierText(text) {
  if (!text) return [];
  const rawMatches = String(text).match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  const tokens = [];
  for (let i = 0; i < rawMatches.length; i++) {
    const raw = rawMatches[i];
    const lower = raw.toLowerCase();
    if (lower.length >= 2) tokens.push(lower);
    // Split camelCase and snake_case into sub-tokens
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .split('_');
    if (parts.length > 1) {
      for (const p of parts) {
        const pl = p.toLowerCase();
        if (pl.length >= 2 && pl !== lower) tokens.push(pl);
      }
    }
  }
  return tokens;
}

function fnv1a32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mixHash32(str) {
  let h = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) + ((h << 6) >>> 0) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  }
  return (h ^ (h >>> 13)) >>> 0;
}

// Deterministic 128-dim signed Int8Array quantized feature-hashed embedding
export function embedText(text, dims = EMBEDDING_DIMS) {
  const tokens = tokenizeIdentifierText(text);
  const acc = new Float32Array(dims);
  if (!tokens.length) return new Int8Array(dims);

  const addFeature = (feat, weight) => {
    const bucket = fnv1a32(feat) % dims;
    const sign = (mixHash32(feat) & 1) === 0 ? 1 : -1;
    acc[bucket] += sign * weight;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    addFeature('t:' + tok, 2.0);

    // Adjacent token bigrams capture multi-word code phrases
    if (i + 1 < tokens.length) {
      addFeature('b:' + tok + '_' + tokens[i + 1], 1.4);
    }

    // Character trigrams provide morphological / typo / stem resilience
    if (tok.length >= 3) {
      const padded = '^' + tok + '$';
      for (let j = 0; j <= padded.length - 3; j++) {
        addFeature('g:' + padded.slice(j, j + 3), 0.65);
      }
    }
  }

  // Symmetric absmax int8 quantization preserves cosine direction at full 8-bit dynamic range
  let maxAbs = 0;
  for (let i = 0; i < dims; i++) {
    const a = Math.abs(acc[i]);
    if (a > maxAbs) maxAbs = a;
  }

  const out = new Int8Array(dims);
  if (maxAbs <= 1e-9) return out;

  const scale = 127 / maxAbs;
  for (let i = 0; i < dims; i++) {
    const q = Math.round(acc[i] * scale);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}

// Replace comments and string literal bodies with spaces while preserving line structure
function maskCommentsAndStrings(src, lang) {
  const chars = src.split('');
  const n = chars.length;
  let i = 0;

  while (i < n) {
    const ch = chars[i];
    const next = i + 1 < n ? chars[i + 1] : '';

    // Python line comments
    if (lang === 'python' && ch === '#') {
      while (i < n && chars[i] !== '\n') {
        chars[i++] = ' ';
      }
      continue;
    }

    // C-style line comments
    if (lang !== 'python' && ch === '/' && next === '/') {
      while (i < n && chars[i] !== '\n') {
        chars[i++] = ' ';
      }
      continue;
    }

    // Block comments
    if (lang !== 'python' && ch === '/' && next === '*') {
      chars[i++] = ' ';
      chars[i++] = ' ';
      while (i < n) {
        if (chars[i] === '*' && i + 1 < n && chars[i + 1] === '/') {
          chars[i++] = ' ';
          chars[i++] = ' ';
          break;
        }
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Python triple-quoted strings
    if (lang === 'python' && (ch === '"' || ch === "'") && chars[i + 1] === ch && chars[i + 2] === ch) {
      const q = ch;
      chars[i++] = ' ';
      chars[i++] = ' ';
      chars[i++] = ' ';
      while (i < n) {
        if (chars[i] === '\\' && i + 1 < n) {
          if (chars[i] !== '\n') chars[i] = ' ';
          i++;
          if (chars[i] !== '\n') chars[i] = ' ';
          i++;
          continue;
        }
        if (chars[i] === q && chars[i + 1] === q && chars[i + 2] === q) {
          chars[i++] = ' ';
          chars[i++] = ' ';
          chars[i++] = ' ';
          break;
        }
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Quoted strings (keep quotes masked too so call scanning ignores strings)
    if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'js' || lang === 'ts' || lang === 'go'))) {
      const q = ch;
      chars[i++] = ' ';
      while (i < n) {
        if (chars[i] === '\\' && i + 1 < n) {
          if (chars[i] !== '\n') chars[i] = ' ';
          i++;
          if (chars[i] !== '\n') chars[i] = ' ';
          i++;
          continue;
        }
        if (chars[i] === q) {
          chars[i++] = ' ';
          break;
        }
        if (chars[i] === '\n' && q !== '`') break;
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      continue;
    }

    i++;
  }

  return chars.join('');
}

function findBlockEndBrace(maskedLines, startIdx, afterParams = false, minCol = 0) {
  let depth = 0;
  let seenOpen = false;
  let parenDepth = 0;
  let seenParen = !afterParams;
  let paramsDone = !afterParams;

  for (let i = startIdx; i < maskedLines.length; i++) {
    const ln = maskedLines[i];
    const startJ = i === startIdx ? minCol : 0;
    for (let j = startJ; j < ln.length; j++) {
      const c = ln[j];
      if (!paramsDone) {
        if (c === '(') {
          parenDepth++;
          seenParen = true;
        } else if (c === ')') {
          parenDepth--;
          if (seenParen && parenDepth <= 0) {
            paramsDone = true;
          }
        }
        continue;
      }
      if (c === '{') {
        depth++;
        seenOpen = true;
      } else if (c === '}') {
        depth--;
        if (seenOpen && depth <= 0) return i;
      }
    }
  }
  return Math.min(maskedLines.length - 1, startIdx + 20);
}

function extractImports(lines, lang) {
  const imports = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (lang === 'js' || lang === 'ts') {
      const mFrom = ln.match(/^(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/);
      if (mFrom) {
        imports.push({ source: mFrom[1], line: i + 1 });
        continue;
      }
      const mBare = ln.match(/^import\s+['"]([^'"]+)['"]/);
      if (mBare) {
        imports.push({ source: mBare[1], line: i + 1 });
        continue;
      }
      const mReq = ln.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
      if (mReq) {
        imports.push({ source: mReq[1], line: i + 1 });
      }
    } else if (lang === 'python') {
      const mPyFrom = ln.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+/);
      if (mPyFrom) {
        imports.push({ source: mPyFrom[1], line: i + 1 });
        continue;
      }
      const mPyImp = ln.match(/^import\s+([A-Za-z0-9_.]+)/);
      if (mPyImp) {
        imports.push({ source: mPyImp[1], line: i + 1 });
      }
    } else if (lang === 'cpp' || lang === 'glsl') {
      const mInc = ln.match(/^#include\s+[<"]([^>"]+)[>"]/);
      if (mInc) {
        imports.push({ source: mInc[1], line: i + 1 });
      }
    } else if (lang === 'rust') {
      const mUse = ln.match(/^use\s+([^;]+);/);
      if (mUse) {
        imports.push({ source: mUse[1].trim(), line: i + 1 });
      }
    }
  }
  return imports;
}

function buildTermFreqs(tokens) {
  const tf = Object.create(null);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    tf[t] = (tf[t] || 0) + 1;
  }
  return tf;
}

function extractRawSymbols(lines, maskedLines, lang) {
  const found = [];

  if (lang === 'python') {
    const getIndent = (s) => {
      let n = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === ' ') n++;
        else if (s[i] === '\t') n += 4;
        else break;
      }
      return n;
    };
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = getIndent(lines[i]);
      while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();

      const m = trimmed.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
      if (!m) continue;
      const kw = m[1];
      const name = m[2];
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const kind = kw === 'class' ? 'class' : parent && parent.kind === 'class' ? 'method' : 'function';
      const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;

      let endIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        const t2 = lines[j].trim();
        if (!t2 || t2.startsWith('#')) continue;
        if (getIndent(lines[j]) <= indent) break;
        endIdx = j;
      }

      found.push({
        name,
        qualifiedName,
        kind,
        startLine: i + 1,
        endLine: endIdx + 1,
        signature: trimmed,
        exported: !name.startsWith('_')
      });
      stack.push({ indent, qualifiedName, kind });
    }
    return found;
  }

  // Brace-scoped languages: JS, TS, C/C++, GLSL, Rust, Go
  const classScopes = []; // { name, endIdx }

  for (let i = 0; i < lines.length; i++) {
    while (classScopes.length > 0 && i > classScopes[classScopes.length - 1].endIdx) {
      classScopes.pop();
    }

    const rawLine = lines[i];
    const masked = maskedLines[i];
    const trimmed = rawLine.trim();
    const mTrimmed = masked.trim();
    if (!mTrimmed) continue;

    const currentParent = classScopes.length > 0 ? classScopes[classScopes.length - 1].name : null;

    if (lang === 'js' || lang === 'ts') {
      // Class or interface
      const mClass = mTrimmed.match(/^(export\s+(?:default\s+)?)?(?:abstract\s+)?(class|interface)\s+([A-Za-z_$]\w*)/);
      if (mClass) {
        const endIdx = findBlockEndBrace(maskedLines, i);
        const name = mClass[3];
        found.push({
          name,
          qualifiedName: name,
          kind: mClass[2],
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: Boolean(mClass[1])
        });
        if (mClass[2] === 'class') classScopes.push({ name, endIdx });
        continue;
      }

      // Function declaration
      const mFn = mTrimmed.match(/^(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$]\w*)\s*(?:<[^>]*>)?\s*\(/);
      if (mFn) {
        const endIdx = findBlockEndBrace(maskedLines, i, true);
        const name = mFn[2];
        found.push({
          name,
          qualifiedName: currentParent ? `${currentParent}.${name}` : name,
          kind: 'function',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{\s*$/, '').trim(),
          exported: Boolean(mFn[1])
        });
        continue;
      }

      // Const arrow function or exported constant
      const mConst = mTrimmed.match(/^(export\s+)?(const|let|var)\s+([A-Za-z_$]\w*)\s*(?::[^=]+)?=\s*(.*)$/);
      if (mConst && !currentParent) {
        const isExport = Boolean(mConst[1]);
        const name = mConst[3];
        const rhs = mConst[4] || '';
        const isFnExpr = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$]\w*)\s*=>/.test(rhs) || /^(?:async\s+)?function\b/.test(rhs);
        if (isFnExpr) {
          const hasParen = rhs.includes('(');
          const eqCol = Math.max(0, masked.indexOf('='));
          const endIdx = mTrimmed.includes('{') ? findBlockEndBrace(maskedLines, i, hasParen, eqCol) : i;
          found.push({
            name,
            qualifiedName: name,
            kind: 'function',
            startLine: i + 1,
            endLine: endIdx + 1,
            signature: trimmed.replace(/\{\s*$/, '').trim(),
            exported: isExport
          });
          continue;
        }
        if (isExport) {
          const endIdx = mTrimmed.includes('{') ? findBlockEndBrace(maskedLines, i) : i;
          found.push({
            name,
            qualifiedName: name,
            kind: 'const',
            startLine: i + 1,
            endLine: endIdx + 1,
            signature: trimmed.slice(0, 120),
            exported: true
          });
          continue;
        }
      }

      // Class method
      if (currentParent) {
        const mMethod = mTrimmed.match(/^(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$]\w*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;]+)?\{/);
        if (mMethod && !CALL_STOPWORDS.has(mMethod[1])) {
          const endIdx = findBlockEndBrace(maskedLines, i, true);
          const name = mMethod[1];
          found.push({
            name,
            qualifiedName: `${currentParent}.${name}`,
            kind: 'method',
            startLine: i + 1,
            endLine: endIdx + 1,
            signature: trimmed.replace(/\{\s*$/, '').trim(),
            exported: true
          });
          continue;
        }
      }
      continue;
    }

    if (lang === 'glsl') {
      const mGlslFn = mTrimmed.match(/^(?:void|float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|mat[234]|fn)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:->\s*[A-Za-z0-9_<>]+\s*)?\{/);
      if (mGlslFn && !CALL_STOPWORDS.has(mGlslFn[1])) {
        const endIdx = findBlockEndBrace(maskedLines, i, true);
        const name = mGlslFn[1];
        found.push({
          name,
          qualifiedName: name,
          kind: 'shader_fn',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: name === 'main'
        });
        continue;
      }
      const mUniform = mTrimmed.match(/^uniform\s+(?:[A-Za-z0-9_]+\s+)+([A-Za-z_]\w*)\s*;/);
      if (mUniform) {
        found.push({
          name: mUniform[1],
          qualifiedName: mUniform[1],
          kind: 'const',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          exported: true
        });
      }
      continue;
    }

    if (lang === 'cpp') {
      const mStruct = mTrimmed.match(/^(?:class|struct|namespace)\s+([A-Za-z_]\w*)/);
      if (mStruct && (mTrimmed.includes('{') || (maskedLines[i + 1] || '').trim().startsWith('{'))) {
        const endIdx = findBlockEndBrace(maskedLines, i);
        found.push({
          name: mStruct[1],
          qualifiedName: mStruct[1],
          kind: 'struct',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: true
        });
        classScopes.push({ name: mStruct[1], endIdx });
        continue;
      }
      const mCppFn = mTrimmed.match(/^(?:(?:static|inline|constexpr|virtual|explicit|extern|const|unsigned|signed|long|short)\s+)*(?:[A-Za-z_][\w:<>]*[\s*&]+)+([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const|override|noexcept|\s)*\{/);
      if (mCppFn) {
        const fullName = mCppFn[1];
        const shortName = fullName.includes('::') ? fullName.split('::').pop() : fullName;
        if (!CALL_STOPWORDS.has(shortName)) {
          const endIdx = findBlockEndBrace(maskedLines, i, true);
          found.push({
            name: shortName,
            qualifiedName: currentParent && !fullName.includes('::') ? `${currentParent}::${shortName}` : fullName,
            kind: currentParent ? 'method' : 'function',
            startLine: i + 1,
            endLine: endIdx + 1,
            signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
            exported: true
          });
        }
      }
      continue;
    }

    if (lang === 'rust') {
      const mRsFn = mTrimmed.match(/^(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/);
      if (mRsFn) {
        const fnCol = Math.max(0, masked.indexOf('fn '));
        const endIdx = findBlockEndBrace(maskedLines, i, true, fnCol);
        const name = mRsFn[2];
        found.push({
          name,
          qualifiedName: currentParent ? `${currentParent}.${name}` : name,
          kind: currentParent ? 'method' : 'function',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: Boolean(mRsFn[1])
        });
        continue;
      }
      const mRsType = mTrimmed.match(/^(pub(?:\([^)]*\))?\s+)?(struct|enum|trait|impl)\s+([A-Za-z_]\w*)/);
      if (mRsType && mTrimmed.includes('{')) {
        const endIdx = findBlockEndBrace(maskedLines, i);
        found.push({
          name: mRsType[3],
          qualifiedName: mRsType[3],
          kind: mRsType[2] === 'struct' ? 'struct' : 'class',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: Boolean(mRsType[1])
        });
        if (mRsType[2] === 'impl' || mRsType[2] === 'trait') {
          classScopes.push({ name: mRsType[3], endIdx });
        }
      }
      continue;
    }

    if (lang === 'go') {
      const mGoFn = mTrimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
      if (mGoFn) {
        const endIdx = findBlockEndBrace(maskedLines, i);
        const name = mGoFn[1];
        found.push({
          name,
          qualifiedName: name,
          kind: 'function',
          startLine: i + 1,
          endLine: endIdx + 1,
          signature: trimmed.replace(/\{[\s\S]*$/, '').trim(),
          exported: /^[A-Z]/.test(name)
        });
      }
    }
  }

  return found;
}

function extractCallEdges(filePath, maskedLines, symbols) {
  const edges = [];
  const edgeKeySet = new Set();

  // Map each line to the innermost enclosing function/method symbol
  const callableSymbols = symbols
    .filter((s) => s.kind === 'function' || s.kind === 'method' || s.kind === 'shader_fn')
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));

  const ownerForLine = (lineNum) => {
    for (let i = 0; i < callableSymbols.length; i++) {
      const s = callableSymbols[i];
      if (lineNum >= s.startLine && lineNum <= s.endLine) return s;
    }
    return null;
  };

  const callRe = /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

  for (let i = 0; i < maskedLines.length; i++) {
    const lineNum = i + 1;
    const owner = ownerForLine(lineNum);
    const callerId = owner ? owner.id : `${filePath}::<module>`;
    const callerName = owner ? owner.qualifiedName : `<module:${filePath}>`;

    const ln = maskedLines[i];
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(ln)) !== null) {
      const callee = m[1];
      if (CALL_STOPWORDS.has(callee)) continue;

      // Skip declaration header of the symbol itself
      if (owner && lineNum === owner.startLine && callee === owner.name) continue;

      // Avoid matching `function foo(` or `def foo(` or `fn foo(`
      const prefix = ln.slice(0, m.index).trimEnd();
      if (/\b(?:function|def|fn|func|class|struct)$/.test(prefix)) continue;

      const dedupKey = `${callerId}->${callee}`;
      if (edgeKeySet.has(dedupKey)) continue;
      edgeKeySet.add(dedupKey);

      edges.push({
        callerId,
        caller: callerName,
        callerFile: filePath,
        callee,
        line: lineNum,
        weight: 1.0
      });
    }
  }

  return edges;
}

export function extractFile(filePath, content, langOverride = null) {
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  const lang = langOverride || detectCodeLanguage(normalizedPath);
  const src = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = src.split('\n');
  const masked = maskCommentsAndStrings(src, lang);
  const maskedLines = masked.split('\n');

  const imports = extractImports(lines, lang);
  const rawSymbols = extractRawSymbols(lines, maskedLines, lang);

  const symbols = rawSymbols.map((raw) => {
    const id = `${normalizedPath}::${raw.qualifiedName}@${raw.startLine}`;
    const bodyLines = lines.slice(raw.startLine - 1, raw.endLine);
    const snippetLines = bodyLines.slice(0, 14);
    const snippet = snippetLines.join('\n').slice(0, 650);
    const bodyText = bodyLines.join('\n');

    // Weight symbol name and signature strongly in both BM25 and vector embedding
    const searchDoc = [
      raw.qualifiedName,
      raw.qualifiedName,
      raw.name,
      raw.kind,
      normalizedPath,
      raw.signature,
      bodyText.slice(0, 2400)
    ].join(' ');

    const tokens = tokenizeIdentifierText(searchDoc);
    const termFreqs = buildTermFreqs(tokens);
    const vector = embedText(searchDoc, EMBEDDING_DIMS);

    return {
      id,
      name: raw.name,
      qualifiedName: raw.qualifiedName,
      kind: raw.kind,
      file: normalizedPath,
      lang,
      startLine: raw.startLine,
      endLine: raw.endLine,
      signature: raw.signature,
      exported: raw.exported,
      snippet,
      termFreqs,
      tokenCount: tokens.length,
      vector
    };
  });

  const edges = extractCallEdges(normalizedPath, maskedLines, symbols);

  return {
    file: normalizedPath,
    lang,
    lines: lines.length,
    imports,
    symbols,
    edges
  };
}
