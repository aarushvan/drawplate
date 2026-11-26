// Cleave public API and CLI runner (pure isomorphic ESM: works in Node 26 CLI and Browser ESM)

import {
  detectLanguage,
  hashTokens,
  normalizeTokens,
  parseBlocks,
  parseSymbols,
  splitLines,
  tokenize,
  tokenSimilarity
} from './parser.mjs';
import { diffAst, diffLines, formatDiff } from './diff.mjs';
import { merge3, mergeLines3 } from './merge.mjs';

export {
  detectLanguage,
  diffAst,
  diffLines,
  formatDiff,
  hashTokens,
  merge3,
  mergeLines3,
  normalizeTokens,
  parseBlocks,
  parseSymbols,
  splitLines,
  tokenize,
  tokenSimilarity
};

export const PRESETS = {
  jsMoveAndEdit: {
    title: 'JS: Moved & Edited Function (3-Way Auto-Merge)',
    lang: 'js',
    base: `import { clamp } from './math.mjs';

export function computeGain(db) {
  const linear = Math.pow(10, db / 20);
  return clamp(linear, 0, 4);
}

export function normalizeFrame(samples, targetDb) {
  const gain = computeGain(targetDb);
  return samples.map((s) => s * gain);
}

export function peakLevel(samples) {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}`,
    left: `import { clamp } from './math.mjs';

export function normalizeFrame(samples, targetDb) {
  const gain = computeGain(targetDb);
  return samples.map((s) => s * gain);
}

export function peakLevel(samples) {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}

export function computeGain(db) {
  const linear = Math.pow(10, db / 20);
  return clamp(linear, 0, 4);
}`,
    right: `import { clamp } from './math.mjs';

export function computeGain(db) {
  if (!Number.isFinite(db)) return 0;
  const linear = Math.pow(10, db / 20);
  return clamp(linear, 0, 8);
}

export function normalizeFrame(samples, targetDb) {
  const gain = computeGain(targetDb);
  return samples.map((s) => s * gain);
}

export function peakLevel(samples) {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
}`
  },
  rustRefactor: {
    title: 'Rust: Relocated Struct Helper with Guard Clause',
    lang: 'rust',
    base: `pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn bucket_index(key: &str, buckets: usize) -> usize {
    let digest = hash_bytes(key.as_bytes());
    (digest as usize) % buckets
}`,
    left: `pub fn bucket_index(key: &str, buckets: usize) -> usize {
    let digest = hash_bytes(key.as_bytes());
    (digest as usize) % buckets
}

pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}`,
    right: `pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^ (data.len() as u64)
}

pub fn bucket_index(key: &str, buckets: usize) -> usize {
    if buckets == 0 {
        return 0;
    }
    let digest = hash_bytes(key.as_bytes());
    (digest as usize) % buckets
}`
  },
  pythonPipeline: {
    title: 'Python: Indentation-Aware Function Relocation',
    lang: 'python',
    base: `def score_candidate(vec_sim, bm25, boost):
    base = 0.55 * vec_sim + 0.45 * bm25
    return round(base + boost, 4)

def rank_hits(items):
    scored = []
    for item in items:
        s = score_candidate(item["vec"], item["bm25"], item["boost"])
        scored.append((s, item["id"]))
    scored.sort(reverse=True)
    return scored`,
    left: `def rank_hits(items):
    scored = []
    for item in items:
        s = score_candidate(item["vec"], item["bm25"], item["boost"])
        scored.append((s, item["id"]))
    scored.sort(reverse=True)
    return scored

def score_candidate(vec_sim, bm25, boost):
    base = 0.55 * vec_sim + 0.45 * bm25
    return round(base + boost, 4)`,
    right: `def score_candidate(vec_sim, bm25, boost):
    base = 0.60 * vec_sim + 0.40 * bm25
    return round(max(0.0, base + boost), 4)

def rank_hits(items):
    scored = []
    for item in items:
        s = score_candidate(item["vec"], item["bm25"], item["boost"])
        scored.append((s, item["id"]))
    scored.sort(reverse=True)
    return scored`
  }
};

function parseCliFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const HELP_TEXT = `Usage:
  cleave diff <fileA> <fileB> [--mode ast|line] [--lang <lang>] [--json]
  cleave merge <base> <left> <right> [--lang <lang>] [--out <file>] [--json]
`;

export async function runCleaveCli(args = [], io = null) {
  const writeOut = io?.stdout || ((s) => process.stdout.write(s));
  const writeErr = io?.stderr || ((s) => process.stderr.write(s));

  const { positional, flags } = parseCliFlags(args);
  const sub = positional[0];

  if (!sub || flags.help || sub === 'help') {
    writeOut(HELP_TEXT);
    return 0;
  }

  // Dynamic imports keep index.mjs 100% browser-compatible
  const fs = await import('node:fs');
  const path = await import('node:path');

  if (sub === 'diff') {
    const fileA = positional[1];
    const fileB = positional[2];
    if (!fileA || !fileB) {
      writeErr('Error: cleave diff requires <fileA> and <fileB>\n');
      return 1;
    }
    const textA = fs.readFileSync(fileA, 'utf8');
    const textB = fs.readFileSync(fileB, 'utf8');
    const mode = flags.mode === 'line' ? 'line' : 'ast';
    const lang = flags.lang || detectLanguage(path.basename(fileB) || path.basename(fileA), textA);

    const result = mode === 'line' ? diffLines(textA, textB) : diffAst(textA, textB, lang);
    if (flags.json) {
      writeOut(JSON.stringify(result, null, 2) + '\n');
    } else {
      writeOut(formatDiff(result, fileA, fileB) + '\n');
    }
    return 0;
  }

  if (sub === 'merge') {
    const basePath = positional[1];
    const leftPath = positional[2];
    const rightPath = positional[3];
    if (!basePath || !leftPath || !rightPath) {
      writeErr('Error: cleave merge requires <base> <left> <right>\n');
      return 1;
    }
    const baseText = fs.readFileSync(basePath, 'utf8');
    const leftText = fs.readFileSync(leftPath, 'utf8');
    const rightText = fs.readFileSync(rightPath, 'utf8');
    const lang = flags.lang || detectLanguage(path.basename(basePath), baseText);

    const result = merge3(baseText, leftText, rightText, lang);
    if (flags.out) {
      fs.writeFileSync(flags.out, result.merged + '\n', 'utf8');
    }
    if (flags.json) {
      writeOut(JSON.stringify(result, null, 2) + '\n');
    } else if (!flags.out) {
      writeOut(result.merged + '\n');
    }
    return result.hasConflicts ? 1 : 0;
  }

  writeErr(`Unknown cleave subcommand: ${sub}\n${HELP_TEXT}`);
  return 1;
}
