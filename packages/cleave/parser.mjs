// Cleave structural parser and tokenizer (pure isomorphic ESM: Node + Browser)

const LANG_ALIASES = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',
  javascript: 'js',
  ts: 'ts',
  tsx: 'ts',
  typescript: 'ts',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  'c++': 'cpp'
};

const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'finally',
  'try', 'return', 'throw', 'new', 'delete', 'typeof', 'sizeof', 'match',
  'loop', 'select', 'defer', 'go', 'with', 'assert', 'elif', 'except',
  'where', 'yield', 'await', 'default'
]);

const MODIFIER_KEYWORDS = new Set([
  'export', 'default', 'async', 'static', 'public', 'private', 'protected',
  'readonly', 'abstract', 'override', 'virtual', 'inline', 'constexpr',
  'const', 'extern', 'friend', 'explicit', 'pub', 'unsafe', 'get', 'set',
  'declare', 'final', 'noexcept'
]);

export function detectLanguage(hint = '', source = '') {
  if (hint) {
    const clean = String(hint).trim().toLowerCase();
    if (LANG_ALIASES[clean]) return LANG_ALIASES[clean];
    const extMatch = clean.match(/\.([a-z0-9+]+)$/);
    if (extMatch && LANG_ALIASES[extMatch[1]]) {
      return LANG_ALIASES[extMatch[1]];
    }
  }
  if (source) {
    if (/^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_]\w*\s*(?:<[^>]*>)?\s*\(/m.test(source)) return 'rust';
    if (/^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(/m.test(source)) return 'go';
    if (/^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/m.test(source)) return 'python';
    if (/^\s*#include\s+[<"]/m.test(source)) return 'cpp';
    if (/:\s*(?:string|number|boolean|Promise<|Record<)|interface\s+[A-Za-z_]\w*/m.test(source)) return 'ts';
  }
  return 'js';
}

export function splitLines(text) {
  if (!text) return [];
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function hashTokens(tokens) {
  // Deterministic 64-bit FNV-1a implemented with two 32-bit halves (works everywhere)
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < tokens.length; i++) {
    const str = typeof tokens[i] === 'string' ? tokens[i] : tokens[i].value;
    for (let j = 0; j < str.length; j++) {
      const c = str.charCodeAt(j);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + ((i + 1) & 0xff);
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    h1 ^= 0x1f;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= 0x2f;
    h2 = Math.imul(h2, 0xc2b2ae35);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return hex1 + hex2;
}

export function normalizeTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'comment' || t.type === 'whitespace' || t.type === 'newline') continue;
    out.push(t.value);
  }
  return out;
}

export function tokenSimilarity(tokensA, tokensB) {
  if (!tokensA.length && !tokensB.length) return 1;
  if (!tokensA.length || !tokensB.length) return 0;

  if (tokensA.length === tokensB.length) {
    let same = true;
    for (let i = 0; i < tokensA.length; i++) {
      if (tokensA[i] !== tokensB[i]) {
        same = false;
        break;
      }
    }
    if (same) return 1;
  }

  const diceMultiset = (arrA, arrB) => {
    if (!arrA.length && !arrB.length) return 1;
    if (!arrA.length || !arrB.length) return 0;
    const counts = new Map();
    for (let i = 0; i < arrA.length; i++) {
      counts.set(arrA[i], (counts.get(arrA[i]) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < arrB.length; i++) {
      const c = counts.get(arrB[i]) || 0;
      if (c > 0) {
        overlap++;
        counts.set(arrB[i], c - 1);
      }
    }
    return (2 * overlap) / (arrA.length + arrB.length);
  };

  const unigram = diceMultiset(tokensA, tokensB);
  if (tokensA.length < 2 || tokensB.length < 2) return unigram;

  const bigramsA = [];
  for (let i = 0; i < tokensA.length - 1; i++) {
    bigramsA.push(tokensA[i] + '\u0001' + tokensA[i + 1]);
  }
  const bigramsB = [];
  for (let i = 0; i < tokensB.length - 1; i++) {
    bigramsB.push(tokensB[i] + '\u0001' + tokensB[i + 1]);
  }
  const bigram = diceMultiset(bigramsA, bigramsB);
  return 0.45 * unigram + 0.55 * bigram;
}

export function tokenize(source, langInput = 'js') {
  const lang = detectLanguage(langInput, source);
  const src = String(source || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tokens = [];
  const len = src.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (count = 1) => {
    for (let k = 0; k < count; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : '';

    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', line, col });
      advance(1);
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\f' || src[i] === '\v')) {
        advance(1);
      }
      tokens.push({ type: 'whitespace', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Comments
    if (lang === 'python' && ch === '#') {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < len && src[i] !== '\n') advance(1);
      tokens.push({ type: 'comment', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    if (lang !== 'python' && ch === '/' && next === '/') {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < len && src[i] !== '\n') advance(1);
      tokens.push({ type: 'comment', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    if (lang !== 'python' && ch === '/' && next === '*') {
      const startLine = line;
      const startCol = col;
      const start = i;
      advance(2);
      let depth = 1;
      while (i < len && depth > 0) {
        if (lang === 'rust' && src[i] === '/' && src[i + 1] === '*') {
          depth++;
          advance(2);
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          advance(2);
        } else {
          advance(1);
        }
      }
      tokens.push({ type: 'comment', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Python triple-quoted strings
    if (lang === 'python' && (ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
      const startLine = line;
      const startCol = col;
      const start = i;
      const quote = ch;
      advance(3);
      while (i < len) {
        if (src[i] === '\\') {
          advance(Math.min(2, len - i));
          continue;
        }
        if (src[i] === quote && src[i + 1] === quote && src[i + 2] === quote) {
          advance(3);
          break;
        }
        advance(1);
      }
      tokens.push({ type: 'string', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Rust raw strings r#"..."#
    if (lang === 'rust' && ch === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let probe = i + 1;
      while (probe < len && src[probe] === '#') {
        hashes++;
        probe++;
      }
      if (probe < len && src[probe] === '"') {
        const startLine = line;
        const startCol = col;
        const start = i;
        advance(probe - i + 1);
        while (i < len) {
          if (src[i] === '"') {
            let matchHashes = 0;
            while (matchHashes < hashes && src[i + 1 + matchHashes] === '#') {
              matchHashes++;
            }
            if (matchHashes === hashes) {
              advance(1 + hashes);
              break;
            }
          }
          advance(1);
        }
        tokens.push({ type: 'string', value: src.slice(start, i), line: startLine, col: startCol });
        continue;
      }
    }

    // Rust lifetimes like 'a vs char literals 'x'
    if (lang === 'rust' && ch === "'") {
      const startLine = line;
      const startCol = col;
      const start = i;
      if (src[i + 1] === '\\') {
        advance(2);
        while (i < len && src[i] !== "'" && src[i] !== '\n') advance(1);
        if (i < len && src[i] === "'") advance(1);
        tokens.push({ type: 'string', value: src.slice(start, i), line: startLine, col: startCol });
        continue;
      }
      if (i + 2 < len && src[i + 2] === "'") {
        advance(3);
        tokens.push({ type: 'string', value: src.slice(start, i), line: startLine, col: startCol });
        continue;
      }
      // Lifetime token
      advance(1);
      while (i < len && /[A-Za-z0-9_]/.test(src[i])) advance(1);
      tokens.push({ type: 'identifier', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Strings and template literals
    if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'js' || lang === 'ts' || lang === 'go'))) {
      const startLine = line;
      const startCol = col;
      const start = i;
      const quote = ch;
      advance(1);
      while (i < len) {
        if (src[i] === '\\' && !(lang === 'go' && quote === '`')) {
          advance(Math.min(2, len - i));
          continue;
        }
        if (src[i] === quote) {
          advance(1);
          break;
        }
        if (src[i] === '\n' && quote !== '`') break;
        advance(1);
      }
      tokens.push({ type: 'string', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < len && /[0-9a-fA-FxXoObB._eE]/.test(src[i])) {
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-')) {
          advance(2);
          continue;
        }
        advance(1);
      }
      tokens.push({ type: 'number', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Identifiers
    if (/[A-Za-z_$]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      const start = i;
      while (i < len && /[A-Za-z0-9_$]/.test(src[i])) advance(1);
      tokens.push({ type: 'identifier', value: src.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Multi-char operators
    const two = ch + next;
    const three = two + (i + 2 < len ? src[i + 2] : '');
    if (three === '===' || three === '!==' || three === '...' || three === '<<=' || three === '>>=') {
      tokens.push({ type: 'punct', value: three, line, col });
      advance(3);
      continue;
    }
    if (
      two === '=>' || two === '->' || two === '::' || two === '==' || two === '!=' ||
      two === '<=' || two === '>=' || two === '&&' || two === '||' || two === ':=' ||
      two === '+=' || two === '-=' || two === '*=' || two === '/='
    ) {
      tokens.push({ type: 'punct', value: two, line, col });
      advance(2);
      continue;
    }

    tokens.push({ type: 'punct', value: ch, line, col });
    advance(1);
  }

  return tokens;
}

function makeBlock({ kind, name, parent, depth, startLine, endLine, signature, rawLines, codeTokens }) {
  const qualifiedName = parent ? `${parent}.${name}` : name;
  const norm = codeTokens.map((t) => t.value);
  // Body hash strips the declared name so renamed-and-moved blocks can still match if needed
  const bodyTokens = norm.filter((v) => v !== name);
  return {
    id: `${kind}:${qualifiedName}@${startLine}`,
    kind,
    name,
    qualifiedName,
    parent: parent || null,
    depth,
    startLine,
    endLine,
    signature: signature.trim(),
    tokens: norm,
    tokenHash: hashTokens(norm),
    bodyHash: hashTokens(bodyTokens),
    rawLines,
    rawText: rawLines.join('\n')
  };
}

function findMatchingBrace(codeTokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < codeTokens.length; i++) {
    const v = codeTokens[i].value;
    if (v === '{') depth++;
    else if (v === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingDelim(codeTokens, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < codeTokens.length; i++) {
    const v = codeTokens[i].value;
    if (v === openChar) depth++;
    else if (v === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parsePythonBlocks(source, lines, allTokens) {
  const blocks = [];
  const codeTokensByLine = new Map();
  for (const t of allTokens) {
    if (t.type === 'whitespace' || t.type === 'newline' || t.type === 'comment') continue;
    if (!codeTokensByLine.has(t.line)) codeTokensByLine.set(t.line, []);
    codeTokensByLine.get(t.line).push(t);
  }

  const getIndent = (lineStr) => {
    let n = 0;
    for (let i = 0; i < lineStr.length; i++) {
      if (lineStr[i] === ' ') n += 1;
      else if (lineStr[i] === '\t') n += 4;
      else break;
    }
    return n;
  };

  // Precompute meaningful (non-blank, non-comment-only) lines
  const isCodeLine = (idx0) => {
    const t = lines[idx0].trim();
    return t.length > 0 && !t.startsWith('#');
  };

  const stack = []; // { indent, qualifiedName, kind }

  for (let idx = 0; idx < lines.length; idx++) {
    const lineStr = lines[idx];
    const trimmed = lineStr.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = getIndent(lineStr);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const match = trimmed.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!match) continue;

    const kw = match[1];
    const name = match[2];
    const parentFrame = stack.length > 0 ? stack[stack.length - 1] : null;
    const kind = kw === 'class' ? 'class' : (parentFrame && parentFrame.kind === 'class' ? 'method' : 'function');
    const depth = stack.length;

    // Include immediately preceding decorators at the same indentation
    let startIdx = idx;
    while (startIdx > 0) {
      const prev = lines[startIdx - 1];
      if (prev.trim().startsWith('@') && getIndent(prev) === indent) {
        startIdx--;
      } else {
        break;
      }
    }

    // Find end of multi-line header (colon ending signature)
    let headerEndIdx = idx;
    let parenDepth = 0;
    for (let j = idx; j < lines.length; j++) {
      const ltoks = codeTokensByLine.get(j + 1) || [];
      for (const tok of ltoks) {
        if (tok.value === '(' || tok.value === '[' || tok.value === '{') parenDepth++;
        else if (tok.value === ')' || tok.value === ']' || tok.value === '}') parenDepth = Math.max(0, parenDepth - 1);
      }
      headerEndIdx = j;
      if (parenDepth === 0 && ltoks.length > 0 && ltoks[ltoks.length - 1].value === ':') {
        break;
      }
    }

    // Scan forward for end of indented body
    let endIdx = headerEndIdx;
    for (let j = headerEndIdx + 1; j < lines.length; j++) {
      if (!isCodeLine(j)) continue;
      const nextIndent = getIndent(lines[j]);
      if (nextIndent <= indent) break;
      endIdx = j;
    }

    const startLine = startIdx + 1;
    const endLine = endIdx + 1;
    const rawLines = lines.slice(startIdx, endIdx + 1);
    const blockTokens = [];
    for (let ln = startLine; ln <= endLine; ln++) {
      const ltoks = codeTokensByLine.get(ln);
      if (ltoks) blockTokens.push(...ltoks);
    }

    const sig = lines.slice(idx, headerEndIdx + 1).map((s) => s.trim()).join(' ');
    const block = makeBlock({
      kind,
      name,
      parent: parentFrame ? parentFrame.qualifiedName : null,
      depth,
      startLine,
      endLine,
      signature: sig,
      rawLines,
      codeTokens: blockTokens
    });

    blocks.push(block);
    stack.push({ indent, qualifiedName: block.qualifiedName, kind });
  }

  return blocks;
}

function parseBraceBlocks(source, lang, lines, allTokens) {
  const codeTokens = allTokens.filter(
    (t) => t.type !== 'whitespace' && t.type !== 'newline' && t.type !== 'comment'
  );
  const blocks = [];

  const lineHasOnlyAttributes = (lineNum) => {
    const trimmed = (lines[lineNum - 1] || '').trim();
    if (!trimmed) return false;
    if (lang === 'rust' && trimmed.startsWith('#[')) return true;
    if ((lang === 'js' || lang === 'ts') && trimmed.startsWith('@')) return true;
    return false;
  };

  const expandStartLine = (declLine) => {
    let ln = declLine;
    while (ln > 1 && lineHasOnlyAttributes(ln - 1)) {
      ln--;
    }
    return ln;
  };

  const scanRange = (startIdx, endIdx, parentName, parentKind, depth) => {
    let i = startIdx;
    while (i <= endIdx) {
      const tok = codeTokens[i];
      if (!tok) break;

      // Skip stray closing braces
      if (tok.value === '}') {
        i++;
        continue;
      }

      // Skip statements ending at semicolon or scan declaration headers
      let detected = null;

      if (lang === 'js' || lang === 'ts') {
        detected = tryMatchJsTs(codeTokens, i, endIdx, parentKind);
      } else if (lang === 'rust') {
        detected = tryMatchRust(codeTokens, i, endIdx, parentKind);
      } else if (lang === 'go') {
        detected = tryMatchGo(codeTokens, i, endIdx);
      } else if (lang === 'cpp') {
        detected = tryMatchCpp(codeTokens, i, endIdx, parentKind);
      }

      if (detected) {
        const closeBraceIdx = findMatchingBrace(codeTokens, detected.openBraceIdx);
        if (closeBraceIdx !== -1 && closeBraceIdx <= endIdx) {
          let finalEndIdx = closeBraceIdx;
          if (finalEndIdx + 1 <= endIdx && codeTokens[finalEndIdx + 1].value === ';') {
            finalEndIdx++;
          }
          const startLine = expandStartLine(codeTokens[detected.declStartIdx].line);
          const endLine = codeTokens[finalEndIdx].line;
          const rawLines = lines.slice(startLine - 1, endLine);
          const sliceTokens = codeTokens.slice(detected.declStartIdx, finalEndIdx + 1);
          const sigStartLine = codeTokens[detected.declStartIdx].line;
          const sigEndLine = codeTokens[detected.openBraceIdx].line;
          const signature = lines
            .slice(sigStartLine - 1, sigEndLine)
            .map((s) => s.trim())
            .join(' ')
            .replace(/\{[\s\S]*$/, '')
            .trim();

          const block = makeBlock({
            kind: detected.kind,
            name: detected.name,
            parent: parentName,
            depth,
            startLine,
            endLine,
            signature,
            rawLines,
            codeTokens: sliceTokens
          });
          blocks.push(block);

          // Recurse into containers (class, impl, trait, mod, namespace, struct) to extract nested methods
          if (detected.isContainer && closeBraceIdx - detected.openBraceIdx > 1) {
            scanRange(detected.openBraceIdx + 1, closeBraceIdx - 1, block.qualifiedName, detected.kind, depth + 1);
          }

          i = finalEndIdx + 1;
          continue;
        }
      }

      // If we hit an unmatched block (e.g., if/for/while), jump over its brace body at top level?
      // No, advance token by token, except skip inside parens/brackets for cleaner scanning.
      i++;
    }
  };

  scanRange(0, codeTokens.length - 1, null, null, 0);
  return blocks;
}

function tryMatchJsTs(tokens, idx, endIdx, parentKind) {
  let cursor = idx;
  const declStartIdx = idx;

  // Consume modifiers
  while (cursor <= endIdx && MODIFIER_KEYWORDS.has(tokens[cursor].value)) {
    cursor++;
  }
  if (cursor > endIdx) return null;

  const kw = tokens[cursor].value;

  // 1. function declarations: [export] [default] [async] function [*] name(...) { ... }
  if (kw === 'function') {
    let p = cursor + 1;
    if (p <= endIdx && tokens[p].value === '*') p++;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    p++;
    if (p <= endIdx && tokens[p].value === '<') {
      const closeAngle = findMatchingDelim(tokens, p, '<', '>');
      if (closeAngle !== -1) p = closeAngle + 1;
    }
    if (p > endIdx || tokens[p].value !== '(') return null;
    const closeParen = findMatchingDelim(tokens, p, '(', ')');
    if (closeParen === -1) return null;
    let brace = closeParen + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      return { kind: 'function', name, declStartIdx, openBraceIdx: brace, isContainer: false };
    }
    return null;
  }

  // 2. class / interface declarations
  if (kw === 'class' || kw === 'interface') {
    const p = cursor + 1;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    let brace = p + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      return { kind: kw, name, declStartIdx, openBraceIdx: brace, isContainer: kw === 'class' };
    }
    return null;
  }

  // 3. const/let/var name = [async] (...) => { ... } OR function(...) { ... }
  if ((kw === 'const' || kw === 'let' || kw === 'var') && !parentKind) {
    // Rewind if 'const' was consumed as modifier
    const p = cursor + 1;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    let q = p + 1;
    // Skip optional TS type annotation up to '='
    while (q <= endIdx && tokens[q].value !== '=' && tokens[q].value !== ';' && tokens[q].value !== '{') q++;
    if (q > endIdx || tokens[q].value !== '=') return null;
    q++;
    if (q <= endIdx && tokens[q].value === 'async') q++;
    if (q <= endIdx && tokens[q].value === 'function') {
      let r = q + 1;
      if (r <= endIdx && tokens[r].value === '*') r++;
      if (r <= endIdx && tokens[r].type === 'identifier') r++;
      if (r <= endIdx && tokens[r].value === '(') {
        const closeP = findMatchingDelim(tokens, r, '(', ')');
        if (closeP !== -1) {
          let brace = closeP + 1;
          while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
          if (brace <= endIdx && tokens[brace].value === '{') {
            return { kind: 'function', name, declStartIdx, openBraceIdx: brace, isContainer: false };
          }
        }
      }
    }
    if (q <= endIdx && (tokens[q].value === '(' || tokens[q].type === 'identifier')) {
      let afterParams = q;
      if (tokens[q].value === '(') {
        const closeP = findMatchingDelim(tokens, q, '(', ')');
        if (closeP === -1) return null;
        afterParams = closeP + 1;
      } else {
        afterParams = q + 1;
      }
      // Scan past optional TS return type to '=>'
      let arrow = afterParams;
      while (arrow <= endIdx && tokens[arrow].value !== '=>' && tokens[arrow].value !== ';' && tokens[arrow].value !== '{') {
        arrow++;
      }
      if (arrow <= endIdx && tokens[arrow].value === '=>' && arrow + 1 <= endIdx && tokens[arrow + 1].value === '{') {
        return { kind: 'function', name, declStartIdx, openBraceIdx: arrow + 1, isContainer: false };
      }
    }
    return null;
  }

  // Handle 'const' which is in MODIFIER_KEYWORDS (e.g. export const foo = () => {})
  if (idx <= endIdx && !parentKind) {
    let c = idx;
    if (tokens[c].value === 'export') c++;
    if (c <= endIdx && (tokens[c].value === 'const' || tokens[c].value === 'let' || tokens[c].value === 'var')) {
      const p = c + 1;
      if (p <= endIdx && tokens[p].type === 'identifier') {
        const name = tokens[p].value;
        let q = p + 1;
        while (q <= endIdx && tokens[q].value !== '=' && tokens[q].value !== ';' && tokens[q].value !== '{') q++;
        if (q <= endIdx && tokens[q].value === '=') {
          q++;
          if (q <= endIdx && tokens[q].value === 'async') q++;
          if (q <= endIdx && tokens[q].value === 'function') {
            let r = q + 1;
            if (r <= endIdx && tokens[r].value === '*') r++;
            if (r <= endIdx && tokens[r].type === 'identifier') r++;
            if (r <= endIdx && tokens[r].value === '(') {
              const closeP = findMatchingDelim(tokens, r, '(', ')');
              if (closeP !== -1) {
                let brace = closeP + 1;
                while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
                if (brace <= endIdx && tokens[brace].value === '{') {
                  return { kind: 'function', name, declStartIdx: idx, openBraceIdx: brace, isContainer: false };
                }
              }
            }
          }
          if (q <= endIdx && (tokens[q].value === '(' || tokens[q].type === 'identifier')) {
            let afterParams = q;
            if (tokens[q].value === '(') {
              const closeP = findMatchingDelim(tokens, q, '(', ')');
              if (closeP === -1) return null;
              afterParams = closeP + 1;
            } else {
              afterParams = q + 1;
            }
            let arrow = afterParams;
            while (arrow <= endIdx && tokens[arrow].value !== '=>' && tokens[arrow].value !== ';' && tokens[arrow].value !== '{') {
              arrow++;
            }
            if (arrow <= endIdx && tokens[arrow].value === '=>' && arrow + 1 <= endIdx && tokens[arrow + 1].value === '{') {
              return { kind: 'function', name, declStartIdx: idx, openBraceIdx: arrow + 1, isContainer: false };
            }
          }
        }
      }
    }
  }

  // 4. Class methods: [static] [async] [get|set] name(...) { ... }
  if (parentKind === 'class' && tokens[cursor].type === 'identifier' && !CONTROL_KEYWORDS.has(kw)) {
    const name = kw;
    let p = cursor + 1;
    if (p <= endIdx && tokens[p].value === '<') {
      const closeAngle = findMatchingDelim(tokens, p, '<', '>');
      if (closeAngle !== -1) p = closeAngle + 1;
    }
    if (p <= endIdx && tokens[p].value === '(') {
      const closeP = findMatchingDelim(tokens, p, '(', ')');
      if (closeP !== -1) {
        let brace = closeP + 1;
        while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
        if (brace <= endIdx && tokens[brace].value === '{') {
          return { kind: 'method', name, declStartIdx, openBraceIdx: brace, isContainer: false };
        }
      }
    }
  }

  return null;
}

function tryMatchRust(tokens, idx, endIdx, parentKind) {
  let cursor = idx;
  const declStartIdx = idx;

  // Handle pub, pub(crate), async, unsafe, const, extern "C"
  while (cursor <= endIdx) {
    const v = tokens[cursor].value;
    if (v === 'pub') {
      cursor++;
      if (cursor <= endIdx && tokens[cursor].value === '(') {
        const closeP = findMatchingDelim(tokens, cursor, '(', ')');
        if (closeP !== -1) cursor = closeP + 1;
      }
      continue;
    }
    if (v === 'async' || v === 'unsafe' || v === 'const' || v === 'default') {
      cursor++;
      continue;
    }
    if (v === 'extern') {
      cursor++;
      if (cursor <= endIdx && tokens[cursor].type === 'string') cursor++;
      continue;
    }
    break;
  }

  if (cursor > endIdx) return null;
  const kw = tokens[cursor].value;

  if (kw === 'fn') {
    const p = cursor + 1;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    let brace = p + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      const kind = parentKind === 'impl' || parentKind === 'trait' ? 'method' : 'function';
      return { kind, name, declStartIdx, openBraceIdx: brace, isContainer: false };
    }
    return null;
  }

  if (kw === 'struct' || kw === 'enum' || kw === 'trait' || kw === 'mod') {
    const p = cursor + 1;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    let brace = p + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      return {
        kind: kw,
        name,
        declStartIdx,
        openBraceIdx: brace,
        isContainer: kw === 'trait' || kw === 'mod'
      };
    }
    return null;
  }

  if (kw === 'impl') {
    let p = cursor + 1;
    if (p <= endIdx && tokens[p].value === '<') {
      const closeA = findMatchingDelim(tokens, p, '<', '>');
      if (closeA !== -1) p = closeA + 1;
    }
    const nameParts = [];
    let brace = p;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') {
      if (tokens[brace].type === 'identifier' && tokens[brace].value !== 'where') {
        nameParts.push(tokens[brace].value);
      }
      if (tokens[brace].value === 'where') break;
      brace++;
    }
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      const name = nameParts.length ? nameParts[nameParts.length - 1] : 'impl';
      return { kind: 'impl', name, declStartIdx, openBraceIdx: brace, isContainer: true };
    }
  }

  return null;
}

function tryMatchGo(tokens, idx, endIdx) {
  const kw = tokens[idx].value;
  if (kw === 'func') {
    let p = idx + 1;
    let receiver = '';
    if (p <= endIdx && tokens[p].value === '(') {
      const closeRecv = findMatchingDelim(tokens, p, '(', ')');
      if (closeRecv === -1) return null;
      // Extract receiver type identifier
      for (let k = closeRecv - 1; k > p; k--) {
        if (tokens[k].type === 'identifier') {
          receiver = tokens[k].value;
          break;
        }
      }
      p = closeRecv + 1;
    }
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const fnName = tokens[p].value;
    const name = receiver ? `${receiver}.${fnName}` : fnName;
    let brace = p + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      return {
        kind: receiver ? 'method' : 'function',
        name,
        declStartIdx: idx,
        openBraceIdx: brace,
        isContainer: false
      };
    }
    return null;
  }

  if (kw === 'type') {
    const p = idx + 1;
    if (p + 1 > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    const nextKw = tokens[p + 1].value;
    if (nextKw === 'struct' || nextKw === 'interface') {
      let brace = p + 2;
      while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
      if (brace <= endIdx && tokens[brace].value === '{') {
        return { kind: nextKw, name, declStartIdx: idx, openBraceIdx: brace, isContainer: false };
      }
    }
  }

  return null;
}

function tryMatchCpp(tokens, idx, endIdx, parentKind) {
  // Ensure we are at the start of a statement or declaration
  if (idx > 0) {
    const prev = tokens[idx - 1].value;
    if (prev !== ';' && prev !== '}' && prev !== '{' && prev !== ':') {
      // Allow template<...> before declaration
      if (prev !== '>') return null;
    }
  }

  const declStartIdx = idx;
  let cursor = idx;

  // Skip template<...>
  if (tokens[cursor].value === 'template') {
    cursor++;
    if (cursor <= endIdx && tokens[cursor].value === '<') {
      const closeA = findMatchingDelim(tokens, cursor, '<', '>');
      if (closeA !== -1) cursor = closeA + 1;
    }
  }

  if (cursor > endIdx) return null;
  const kw = tokens[cursor].value;

  if (kw === 'class' || kw === 'struct' || kw === 'namespace' || kw === 'enum') {
    let p = cursor + 1;
    if (kw === 'enum' && p <= endIdx && tokens[p].value === 'class') p++;
    if (p > endIdx || tokens[p].type !== 'identifier') return null;
    const name = tokens[p].value;
    let brace = p + 1;
    while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
    if (brace <= endIdx && tokens[brace].value === '{') {
      return {
        kind: kw,
        name,
        declStartIdx,
        openBraceIdx: brace,
        isContainer: kw === 'class' || kw === 'struct' || kw === 'namespace'
      };
    }
    return null;
  }

  // Function or method: look ahead within 12 tokens for identifier followed by '(' ... ')' ... '{'
  if (CONTROL_KEYWORDS.has(kw) || tokens[cursor].value === '#') return null;
  if (tokens[cursor].type !== 'identifier' && tokens[cursor].value !== '~') return null;

  let scan = cursor;
  let openParen = -1;
  let nameIdx = -1;
  const limit = Math.min(endIdx, cursor + 14);
  while (scan <= limit) {
    const v = tokens[scan].value;
    if (v === ';' || v === '{' || v === '}' || v === '=') return null;
    if (v === '<') {
      const closeA = findMatchingDelim(tokens, scan, '<', '>');
      if (closeA !== -1) {
        scan = closeA + 1;
        continue;
      }
    }
    if (v === '(') {
      openParen = scan;
      nameIdx = scan - 1;
      break;
    }
    scan++;
  }

  if (openParen === -1 || nameIdx < cursor) return null;
  const nameTok = tokens[nameIdx];
  if (nameTok.type !== 'identifier' || CONTROL_KEYWORDS.has(nameTok.value)) return null;

  const closeParen = findMatchingDelim(tokens, openParen, '(', ')');
  if (closeParen === -1) return null;

  // Check qualifiers after ')' before '{'
  let brace = closeParen + 1;
  while (brace <= endIdx) {
    const v = tokens[brace].value;
    if (v === '{') break;
    if (v === ';' || v === '}') return null;
    // Constructor initializer list ': member(val)'
    if (v === ':') {
      brace++;
      while (brace <= endIdx && tokens[brace].value !== '{' && tokens[brace].value !== ';') brace++;
      break;
    }
    brace++;
  }

  if (brace <= endIdx && tokens[brace].value === '{') {
    let fullName = nameTok.value;
    if (nameIdx >= 2 && tokens[nameIdx - 1].value === '::' && tokens[nameIdx - 2].type === 'identifier') {
      fullName = `${tokens[nameIdx - 2].value}::${fullName}`;
    }
    const kind = parentKind === 'class' || parentKind === 'struct' ? 'method' : 'function';
    return { kind, name: fullName, declStartIdx, openBraceIdx: brace, isContainer: false };
  }

  return null;
}

export function parseBlocks(source, langInput = 'js') {
  const lang = detectLanguage(langInput, source);
  const lines = splitLines(source);
  if (!lines.length) return [];
  const allTokens = tokenize(source, lang);
  if (lang === 'python') {
    return parsePythonBlocks(source, lines, allTokens);
  }
  return parseBraceBlocks(source, lang, lines, allTokens);
}

export const parseSymbols = parseBlocks;
