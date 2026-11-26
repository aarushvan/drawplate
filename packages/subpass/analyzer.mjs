// Drawplate Subpass: Static GLSL / WGSL Shader Analyzer, Validator, and CLI Runner
// Pure isomorphic ESM (safe to import in both Browser and Node 22+).

import { SHADER_PRESETS, POST_SHADERS } from './shaders.mjs';

const GLSL_SAMPLER_TYPES = new Set([
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'sampler2DShadow',
  'isampler2D', 'usampler2D', 'isampler3D', 'usampler3D', 'image2D', 'image3D',
]);

const WGSL_TEXTURE_RE = /\b(texture_(?:1d|2d|2d_array|3d|cube|cube_array|multisampled_2d|storage_2d|depth_2d)|sampler|sampler_comparison)\b/;

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'else', 'return', 'discard', 'break', 'continue']);

function stripCommentsPreserveLines(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function detectLanguage(cleanSource) {
  if (
    /@(?:vertex|fragment|compute|group|binding|workgroup_size)\b/.test(cleanSource) ||
    /\bfn\s+[A-Za-z_]\w*\s*\(/.test(cleanSource) ||
    /\bvar<\s*(?:uniform|storage|private|workgroup)\b/.test(cleanSource)
  ) {
    return 'wgsl';
  }
  return 'glsl';
}

function checkDelimiters(cleanSource, diagnostics) {
  const stack = [];
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const closing = { ')': '(', '}': '{', ']': '[' };
  let line = 1;
  let maxBraceDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < cleanSource.length; i++) {
    const ch = cleanSource[i];
    if (ch === '\n') {
      line++;
      continue;
    }
    if (pairs[ch]) {
      stack.push({ ch, line });
      if (ch === '{') {
        braceDepth++;
        if (braceDepth > maxBraceDepth) maxBraceDepth = braceDepth;
      }
    } else if (closing[ch]) {
      if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
      if (stack.length === 0) {
        diagnostics.push({
          severity: 'error',
          line,
          message: `Unmatched closing '${ch}'`,
        });
      } else {
        const top = stack[stack.length - 1];
        if (top.ch !== closing[ch]) {
          diagnostics.push({
            severity: 'error',
            line,
            message: `Mismatched '${ch}' (expected '${pairs[top.ch]}' for '${top.ch}' opened at line ${top.line})`,
          });
        } else {
          stack.pop();
        }
      }
    }
  }

  for (const unclosed of stack) {
    diagnostics.push({
      severity: 'error',
      line: unclosed.line,
      message: `Unclosed '${unclosed.ch}' (missing '${pairs[unclosed.ch]}')`,
    });
  }

  return maxBraceDepth;
}

function checkPreprocessorBalance(lines, diagnostics) {
  const ifStack = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    const lineNo = idx + 1;
    if (/^#\s*(?:if|ifdef|ifndef)\b/.test(trimmed)) {
      ifStack.push(lineNo);
    } else if (/^#\s*endif\b/.test(trimmed)) {
      if (ifStack.length === 0) {
        diagnostics.push({
          severity: 'error',
          line: lineNo,
          message: 'Unexpected #endif without matching #if/#ifdef',
        });
      } else {
        ifStack.pop();
      }
    }
  }
  for (const openLine of ifStack) {
    diagnostics.push({
      severity: 'error',
      line: openLine,
      message: 'Unclosed preprocessor #if/#ifdef directive (missing #endif)',
    });
  }
}

function checkMissingSemicolons(lines, language, diagnostics) {
  let parenDepth = 0;
  let insideStructOrBlockHeader = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx].trim();
    if (!raw) continue;
    if (raw.startsWith('#')) continue;

    // Count paren change across this line
    let deltaParen = 0;
    for (let j = 0; j < raw.length; j++) {
      if (raw[j] === '(') deltaParen++;
      else if (raw[j] === ')') deltaParen--;
    }

    const prevParenDepth = parenDepth;
    parenDepth = Math.max(0, parenDepth + deltaParen);

    // Skip multi-line expressions inside parentheses or trailing operators/commas
    if (prevParenDepth > 0 || parenDepth > 0) continue;
    if (/[;{},:\\]$/.test(raw)) {
      insideStructOrBlockHeader = false;
      continue;
    }
    if (/^(?:@|layout\b|struct\b|if\b|else\b|for\b|while\b|switch\b|case\b|default\b|fn\b)/.test(raw)) {
      insideStructOrBlockHeader = true;
      continue;
    }
    if (/[+\-*/%&|^=<>?!]\s*$/.test(raw)) continue;

    // Look ahead to next non-empty line to see if it starts with '{', '.', '?', ':', or an operator
    let nextNonEmpty = '';
    for (let k = idx + 1; k < lines.length; k++) {
      const candidate = lines[k].trim();
      if (candidate) {
        nextNonEmpty = candidate;
        break;
      }
    }
    if (!nextNonEmpty) {
      // Last non-empty statement without semicolon
      diagnostics.push({
        severity: 'error',
        line: lineNo,
        message: 'Possible missing semicolon at end of statement',
      });
      continue;
    }
    if (
      nextNonEmpty.startsWith('{') ||
      nextNonEmpty.startsWith(')') ||
      nextNonEmpty.startsWith(']') ||
      nextNonEmpty.startsWith('.') ||
      nextNonEmpty.startsWith('?') ||
      nextNonEmpty.startsWith(':') ||
      /^[+\-*/%&|^=<>]/.test(nextNonEmpty)
    ) {
      continue;
    }

    // Check if this line is a function signature whose opening brace is on next line (already handled above)
    // Otherwise flag clear declaration/assignment/return/call statements missing ';'
    const looksLikeStatement =
      language === 'glsl'
        ? /^(?:uniform|in|out|const|precision|return|discard|break|continue|float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?|sampler\w+|[A-Za-z_]\w*\s*(?:\[[^\]]*\]|\.[xyzwrgba]+)?\s*(?:[+\-*/]?=|\+\+|--|\())/.test(raw)
        : /^(?:let|var|const|return|break|continue|[A-Za-z_]\w*\s*(?:[+\-*/]?=|\())/.test(raw);

    if (looksLikeStatement && !insideStructOrBlockHeader) {
      diagnostics.push({
        severity: 'error',
        line: lineNo,
        message: `Missing semicolon at end of statement: "${raw.slice(0, 48)}"`,
      });
    }
    insideStructOrBlockHeader = false;
  }
}

export function analyzeShader(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('analyzeShader expects a string shader source');
  }

  const clean = stripCommentsPreserveLines(source);
  const lines = clean.split('\n');
  const language = options.language || detectLanguage(clean);
  const diagnostics = [];

  const maxNestingDepth = checkDelimiters(clean, diagnostics);
  if (language === 'glsl') {
    checkPreprocessorBalance(lines, diagnostics);
  }
  checkMissingSemicolons(lines, language, diagnostics);

  let version = null;
  let precision = null;
  let workgroupSize = null;
  const uniforms = [];
  const textures = [];
  const inputs = [];
  const outputs = [];
  const functions = [];
  const entryPoints = [];

  if (language === 'glsl') {
    const verMatch = clean.match(/^\s*#version\s+([^\n]+)/m);
    if (verMatch) {
      version = verMatch[1].trim();
    } else {
      diagnostics.push({
        severity: 'warning',
        line: 1,
        message: 'Missing #version directive (WebGL2 expects #version 300 es)',
      });
    }

    const precMatch = clean.match(/\bprecision\s+(lowp|mediump|highp)\s+float\s*;/);
    if (precMatch) precision = precMatch[1];

    const wgMatch = clean.match(/layout\s*\([^)]*local_size_x\s*=\s*(\d+)(?:[^)]*local_size_y\s*=\s*(\d+))?(?:[^)]*local_size_z\s*=\s*(\d+))?[^)]*\)/);
    if (wgMatch) {
      workgroupSize = [
        Number(wgMatch[1]),
        wgMatch[2] ? Number(wgMatch[2]) : 1,
        wgMatch[3] ? Number(wgMatch[3]) : 1,
      ];
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const lineNo = idx + 1;
      const line = lines[idx];

      // Uniform declarations
      const uMatch = line.match(/^\s*(?:layout\s*\([^)]*\)\s*)?uniform\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(?:\s*\[\s*(\d+)\s*\])?\s*;/);
      if (uMatch) {
        const [, type, name, arraySize] = uMatch;
        const rec = { name, type, line: lineNo };
        if (arraySize) rec.arraySize = Number(arraySize);
        if (GLSL_SAMPLER_TYPES.has(type)) {
          textures.push(rec);
        }
        uniforms.push(rec);
      }

      // Inputs and outputs
      const ioMatch = line.match(/^\s*(?:layout\s*\([^)]*\)\s*)?(?:(?:flat|smooth|noperspective)\s+)?(in|out)\s+(?:(?:lowp|mediump|highp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/);
      if (ioMatch) {
        const [, qual, type, name] = ioMatch;
        if (qual === 'in') inputs.push({ name, type, line: lineNo });
        else outputs.push({ name, type, line: lineNo });
      }

      // Function definitions
      const fnMatch = line.match(/^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?/);
      if (fnMatch) {
        const [, returnType, name, params] = fnMatch;
        if (
          !CONTROL_KEYWORDS.has(returnType) &&
          !CONTROL_KEYWORDS.has(name) &&
          !['uniform', 'in', 'out', 'const', 'struct', 'layout', 'precision'].includes(returnType)
        ) {
          // Verify function has a body brace on this or next non-empty line
          const hasBraceHere = line.includes('{');
          let nextLine = '';
          for (let k = idx + 1; k < lines.length; k++) {
            if (lines[k].trim()) {
              nextLine = lines[k].trim();
              break;
            }
          }
          if (hasBraceHere || nextLine.startsWith('{')) {
            functions.push({
              name,
              returnType,
              params: params.trim(),
              line: lineNo,
            });
            if (name === 'main') entryPoints.push('main');
          }
        }
      }
    }

    if (entryPoints.length === 0) {
      diagnostics.push({
        severity: 'error',
        line: 1,
        message: 'Missing required GLSL entry point: void main()',
      });
    }
  } else {
    // WGSL parsing
    const wgMatch = clean.match(/@workgroup_size\s*\(\s*(\d+)(?:\s*,\s*(\d+))?(?:\s*,\s*(\d+))?\s*\)/);
    if (wgMatch) {
      workgroupSize = [
        Number(wgMatch[1]),
        wgMatch[2] ? Number(wgMatch[2]) : 1,
        wgMatch[3] ? Number(wgMatch[3]) : 1,
      ];
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const lineNo = idx + 1;
      const line = lines[idx];

      const varUniform = line.match(/\bvar<\s*(uniform|storage[^>]*)>\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/);
      if (varUniform) {
        uniforms.push({ name: varUniform[2], type: varUniform[3].trim(), space: varUniform[1].trim(), line: lineNo });
      }

      const varTex = line.match(/\bvar\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/);
      if (varTex && WGSL_TEXTURE_RE.test(varTex[2])) {
        textures.push({ name: varTex[1], type: varTex[2].trim(), line: lineNo });
      }

      const fnMatch = line.match(/\bfn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
      if (fnMatch) {
        const [, name, params, ret] = fnMatch;
        functions.push({
          name,
          returnType: ret ? ret.trim() : 'void',
          params: params.trim(),
          line: lineNo,
        });
        // Check preceding 3 lines or same line for @vertex / @fragment / @compute
        const windowText = lines.slice(Math.max(0, idx - 3), idx + 1).join('\n');
        if (/@(?:vertex|fragment|compute)\b/.test(windowText)) {
          entryPoints.push(name);
        }
      }
    }

    if (entryPoints.length === 0) {
      diagnostics.push({
        severity: 'error',
        line: 1,
        message: 'Missing required WGSL entry point (@vertex, @fragment, or @compute)',
      });
    }
  }

  // Stage detection
  let stage = 'unknown';
  if (workgroupSize || /@compute\b/.test(clean)) stage = 'compute';
  else if (/\bgl_Position\b/.test(clean) || /@vertex\b/.test(clean)) stage = 'vertex';
  else if (/\bfragColor\b|\bgl_FragCoord\b|\bgl_FragColor\b|@fragment\b/.test(clean) || outputs.length > 0) stage = 'fragment';

  // Complexity and instruction estimate
  const textureLookups = (clean.match(/\b(?:texture|textureLod|textureGrad|texelFetch|textureSample|textureLoad)\s*\(/g) || []).length;
  const branches = (clean.match(/\b(?:if|else\s+if|switch)\b|\?/g) || []).length;
  const loops = (clean.match(/\b(?:for|while)\b/g) || []).length;
  const mathIntrinsics = (clean.match(/\b(?:sin|cos|tan|pow|exp|log|sqrt|inversesqrt|normalize|reflect|refract|dot|cross|mix|smoothstep|clamp|length|fract|floor|abs|min|max|fwidth)\s*\(/g) || []).length;
  const binaryOps = (clean.match(/[+\-*/](?!=)/g) || []).length;
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length;

  // Weighted static instruction budget (loops weighted by nominal unroll factor)
  const baseAlu = binaryOps + mathIntrinsics * 3;
  const estimatedInstructions = Math.round(
    baseAlu + textureLookups * 12 + branches * 4 + loops * 18
  );

  let tier = 'low';
  if (estimatedInstructions >= 220 || loops >= 3) tier = 'high';
  else if (estimatedInstructions >= 90 || loops >= 1) tier = 'medium';

  const ok = diagnostics.every((d) => d.severity !== 'error');

  return {
    ok,
    language,
    stage,
    version,
    precision,
    workgroupSize,
    entryPoints,
    uniforms,
    textures,
    inputs,
    outputs,
    functions,
    complexity: {
      estimatedInstructions,
      aluOps: baseAlu,
      textureLookups,
      branches,
      loops,
      maxNestingDepth,
      lineCount: lines.length,
      nonEmptyLines,
      tier,
    },
    diagnostics,
  };
}

export function formatAnalysisReport(result, label = '<inline>') {
  const status = result.ok ? 'OK' : 'FAIL';
  const lines = [
    `Subpass Shader Analysis [${status}]: ${label}`,
    `  Language:     ${result.language.toUpperCase()} (${result.stage})${result.version ? ` v${result.version}` : ''}`,
    `  Entry points: ${result.entryPoints.length ? result.entryPoints.join(', ') : '(none)'}`,
    `  Uniforms:     ${result.uniforms.length} (${result.uniforms.map((u) => `${u.name}:${u.type}`).join(', ') || 'none'})`,
    `  Textures:     ${result.textures.length} (${result.textures.map((t) => t.name).join(', ') || 'none'})`,
    `  Functions:    ${result.functions.length} (${result.functions.map((f) => f.name).join(', ') || 'none'})`,
    `  Workgroup:    ${result.workgroupSize ? result.workgroupSize.join('x') : 'n/a'}`,
    `  Complexity:   ~${result.complexity.estimatedInstructions} est. ops (${result.complexity.tier}) | ALU ${result.complexity.aluOps} | Tex ${result.complexity.textureLookups} | Branches ${result.complexity.branches} | Loops ${result.complexity.loops}`,
  ];

  if (result.diagnostics.length > 0) {
    lines.push('  Diagnostics:');
    for (const d of result.diagnostics) {
      lines.push(`    [${d.severity.toUpperCase()}] line ${d.line}: ${d.message}`);
    }
  } else {
    lines.push('  Diagnostics:  0 errors, 0 warnings');
  }
  return lines.join('\n');
}

function resolveBuiltinPreset(target) {
  const byId = SHADER_PRESETS.find((p) => p.id === target || p.filename === target);
  if (byId) return { label: byId.filename, source: byId.source };
  for (const post of Object.values(POST_SHADERS)) {
    if (post.id === target || post.filename === target) {
      return { label: post.filename, source: post.source };
    }
  }
  return null;
}

export async function runSubpassCli(args = [], io = { log: console.log, error: console.error }) {
  const jsonFlag = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('-'));
  const cmd = positional[0];

  if (!cmd || args.includes('--help') || args.includes('-h')) {
    io.log(
      [
        'drawplate subpass - Static GLSL/WGSL shader analyzer and preset inspector',
        '',
        'Usage:',
        '  drawplate subpass check <file|preset> [--json]',
        '  drawplate subpass inspect <file|preset> [--json]',
        '  drawplate subpass presets [--json]',
      ].join('\n')
    );
    return 0;
  }

  if (cmd === 'presets') {
    const items = [
      ...SHADER_PRESETS.map((p) => {
        const analysis = analyzeShader(p.source);
        return {
          id: p.id,
          name: p.name,
          filename: p.filename,
          kind: 'scene',
          ok: analysis.ok,
          uniforms: analysis.uniforms.length,
          functions: analysis.functions.length,
          estimatedInstructions: analysis.complexity.estimatedInstructions,
          tier: analysis.complexity.tier,
        };
      }),
      ...Object.values(POST_SHADERS).map((p) => {
        const analysis = analyzeShader(p.source);
        return {
          id: p.id,
          name: p.name,
          filename: p.filename,
          kind: 'post',
          ok: analysis.ok,
          uniforms: analysis.uniforms.length,
          functions: analysis.functions.length,
          estimatedInstructions: analysis.complexity.estimatedInstructions,
          tier: analysis.complexity.tier,
        };
      }),
    ];

    if (jsonFlag) {
      io.log(JSON.stringify(items, null, 2));
    } else {
      io.log('Subpass Built-in Shaders:');
      for (const item of items) {
        io.log(
          `  ${item.id.padEnd(15)} [${item.kind.padEnd(5)}] ${item.name.padEnd(26)} ${String(item.estimatedInstructions).padStart(4)} est. ops (${item.tier})`
        );
      }
    }
    return 0;
  }

  if (cmd === 'check' || cmd === 'inspect') {
    const target = positional[1];
    if (!target) {
      io.error(`subpass ${cmd}: missing <file|preset> argument`);
      return 1;
    }

    let source;
    let label = target;
    const builtin = resolveBuiltinPreset(target);
    if (builtin) {
      source = builtin.source;
      label = builtin.label;
    } else {
      const fs = await import('node:fs/promises');
      try {
        source = await fs.readFile(target, 'utf8');
      } catch (err) {
        io.error(`subpass ${cmd}: failed to read "${target}": ${err.message}`);
        return 1;
      }
    }

    const result = analyzeShader(source);
    if (jsonFlag) {
      io.log(JSON.stringify({ target: label, ...result }, null, 2));
    } else {
      io.log(formatAnalysisReport(result, label));
    }
    return result.ok ? 0 : 1;
  }

  io.error(`subpass: unknown command "${cmd}" (expected check, inspect, or presets)`);
  return 1;
}
