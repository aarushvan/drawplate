import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PRESETS,
  detectLanguage,
  diffAst,
  diffLines,
  formatDiff,
  merge3,
  mergeLines3,
  parseBlocks,
  runCleaveCli,
  tokenize,
  tokenSimilarity
} from '../packages/cleave/index.mjs';

test('cleave modules are pure isomorphic ESM with no static node: imports', () => {
  const dir = path.resolve('packages/cleave');
  for (const file of ['parser.mjs', 'diff.mjs', 'merge.mjs', 'index.mjs']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/^\s*import\s+.*['"]node:/m.test(src), false, `${file} must not have static node: imports`);
    assert.equal(src.includes('\u2014'), false, `${file} must not contain em dashes`);
  }
});

test('parser extracts top-level and nested blocks across JS/TS, Rust, Python, Go, and C++', () => {
  const jsSrc = `export class Engine {
  init(cfg) {
    return cfg;
  }

  async run(frame) {
    return frame * 2;
  }
}

export function helper(a, b) {
  return a + b;
}

export const scale = (x) => {
  return x * 10;
};`;

  const jsBlocks = parseBlocks(jsSrc, 'js');
  assert.ok(jsBlocks.some((b) => b.kind === 'class' && b.name === 'Engine' && b.startLine === 1 && b.endLine === 9));
  assert.ok(jsBlocks.some((b) => b.kind === 'method' && b.qualifiedName === 'Engine.init' && b.depth === 1));
  assert.ok(jsBlocks.some((b) => b.kind === 'method' && b.qualifiedName === 'Engine.run' && b.depth === 1));
  assert.ok(jsBlocks.some((b) => b.kind === 'function' && b.name === 'helper'));
  assert.ok(jsBlocks.some((b) => b.kind === 'function' && b.name === 'scale'));

  const rustSrc = `pub struct Grid {
    width: usize,
}

impl Grid {
    pub fn area(&self) -> usize {
        self.width * self.width
    }
}

pub fn make_grid(w: usize) -> Grid {
    let _raw = r#" { not a brace } "#;
    Grid { width: w }
}`;
  const rustBlocks = parseBlocks(rustSrc, 'rust');
  assert.ok(rustBlocks.some((b) => b.kind === 'struct' && b.name === 'Grid'));
  assert.ok(rustBlocks.some((b) => b.kind === 'impl' && b.name === 'Grid'));
  assert.ok(rustBlocks.some((b) => b.kind === 'method' && b.qualifiedName === 'Grid.area'));
  assert.ok(rustBlocks.some((b) => b.kind === 'function' && b.name === 'make_grid'));

  const pySrc = `@cached
def compute(x, y):
    total = x + y
    return total

class Runner:
    def step(self, n):
        return compute(n, 1)`;
  const pyBlocks = parseBlocks(pySrc, 'python');
  const computeBlock = pyBlocks.find((b) => b.name === 'compute');
  assert.ok(computeBlock);
  assert.equal(computeBlock.startLine, 1);
  assert.equal(computeBlock.endLine, 4);
  assert.ok(pyBlocks.some((b) => b.kind === 'class' && b.name === 'Runner'));
  assert.ok(pyBlocks.some((b) => b.kind === 'method' && b.qualifiedName === 'Runner.step'));

  const goSrc = `type Cache struct {
    size int
}

func (c *Cache) Get(k string) int {
    return c.size
}

func NewCache(n int) *Cache {
    return &Cache{size: n}
}`;
  const goBlocks = parseBlocks(goSrc, 'go');
  assert.ok(goBlocks.some((b) => b.kind === 'struct' && b.name === 'Cache'));
  assert.ok(goBlocks.some((b) => b.kind === 'method' && b.name === 'Cache.Get'));
  assert.ok(goBlocks.some((b) => b.kind === 'function' && b.name === 'NewCache'));

  const cppSrc = `namespace dsp {
class Filter {
  float process(float x) const {
    return x * 0.5f;
  }
};
}

float clampSample(float x) {
  return x > 1.0f ? 1.0f : x;
}`;
  const cppBlocks = parseBlocks(cppSrc, 'cpp');
  assert.ok(cppBlocks.some((b) => b.kind === 'namespace' && b.name === 'dsp'));
  assert.ok(cppBlocks.some((b) => b.kind === 'class' && b.name === 'Filter'));
  assert.ok(cppBlocks.some((b) => b.kind === 'method' && b.name === 'process'));
  assert.ok(cppBlocks.some((b) => b.kind === 'function' && b.name === 'clampSample'));
});

test('Myers diffLines produces exact shortest edit script and unified hunks', () => {
  const a = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');
  const b = ['line 1', 'line 2 edited', 'line 3', 'line 4', 'line 4.5', 'line 5'].join('\n');
  const res = diffLines(a, b);
  assert.equal(res.stats.removed, 1);
  assert.equal(res.stats.added, 2);
  assert.equal(res.stats.unchanged, 4);
  assert.ok(res.hunks.length >= 1);
});

test('diffAst detects exact moved functions and calculates line savings', () => {
  const { base, left } = PRESETS.jsMoveAndEdit;
  const res = diffAst(base, left, 'js');
  assert.equal(res.stats.movedBlocks, 1);
  assert.equal(res.stats.exactMoves, 1);
  assert.equal(res.moves[0].symbol, 'computeGain');
  assert.equal(res.moves[0].exact, true);
  assert.equal(res.moves[0].similarity, 1);
  assert.equal(res.moves[0].innerEdits.length, 0);
  assert.ok(res.stats.linesSaved > 0, 'structural move diff must save churn lines over Myers line diff');
});

test('diffAst pairs moved AND edited functions when normalized similarity >= 0.65', () => {
  const before = `export function parseHeader(raw) {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(':');
  if (idx === -1) return null;
  const key = trimmed.slice(0, idx).toLowerCase();
  const val = trimmed.slice(idx + 1).trim();
  return { key, val };
}

export function formatStatus(code) {
  return code >= 200 && code < 300 ? 'ok' : 'err';
}

export function countLines(text) {
  return text.split('\\n').length;
}`;

  const after = `export function formatStatus(code) {
  return code >= 200 && code < 300 ? 'ok' : 'err';
}

export function countLines(text) {
  return text.split('\\n').length;
}

export function parseHeader(raw) {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) return null;
  const key = trimmed.slice(0, idx).trim().toLowerCase();
  const val = trimmed.slice(idx + 1).trim();
  return { key, val };
}`;

  const res = diffAst(before, after, 'js');
  assert.equal(res.stats.movedBlocks, 1);
  assert.equal(res.stats.editedMoves, 1);
  const mv = res.moves[0];
  assert.equal(mv.symbol, 'parseHeader');
  assert.equal(mv.exact, false);
  assert.ok(mv.similarity >= 0.65, `expected similarity >= 0.65, got ${mv.similarity}`);
  assert.ok(mv.innerEdits.length > 0 && mv.innerEdits.length <= 6);
  assert.ok(res.stats.linesSaved >= 6);
});

test('merge3 automatically reconciles moved function when other branch edits its body', () => {
  const { base, left, right } = PRESETS.jsMoveAndEdit;
  const res = merge3(base, left, right, 'js');

  assert.equal(res.hasConflicts, false);
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.reconciledMoves.length, 1);
  assert.equal(res.reconciledMoves[0].symbol, 'computeGain');
  assert.equal(res.reconciledMoves[0].movedBy, 'left');
  assert.equal(res.reconciledMoves[0].editedBy, 'right');

  // Verify the edited body from right landed at left's new position at the bottom
  assert.ok(res.merged.includes('if (!Number.isFinite(db)) return 0;'));
  assert.ok(res.merged.includes('return clamp(linear, 0, 8);'));
  assert.ok(res.merged.indexOf('export function peakLevel') < res.merged.indexOf('export function computeGain'));

  // Symmetric test: right moves, left edits
  const sym = merge3(base, right, left, 'js');
  assert.equal(sym.hasConflicts, false);
  assert.equal(sym.reconciledMoves.length, 1);
  assert.equal(sym.reconciledMoves[0].movedBy, 'right');
  assert.equal(sym.reconciledMoves[0].editedBy, 'left');
  assert.ok(sym.merged.includes('if (!Number.isFinite(db)) return 0;'));
});

test('merge3 reconciles moved Rust and Python functions cleanly', () => {
  const rustMerge = merge3(PRESETS.rustRefactor.base, PRESETS.rustRefactor.left, PRESETS.rustRefactor.right, 'rust');
  assert.equal(rustMerge.hasConflicts, false);
  assert.ok(rustMerge.merged.includes('h ^ (data.len() as u64)'));
  assert.ok(rustMerge.merged.includes('if buckets == 0'));

  const pyMerge = merge3(PRESETS.pythonPipeline.base, PRESETS.pythonPipeline.left, PRESETS.pythonPipeline.right, 'python');
  assert.equal(pyMerge.hasConflicts, false);
  assert.ok(pyMerge.merged.includes('0.60 * vec_sim + 0.40 * bm25'));
  assert.ok(pyMerge.merged.indexOf('def rank_hits') < pyMerge.merged.indexOf('def score_candidate'));
});

test('merge3 emits clean conflict markers on true overlapping edits', () => {
  const base = `export function threshold(v) {
  const limit = 0.8;
  return v > limit ? v : 0;
}`;
  const left = `export function threshold(v) {
  const limit = 0.65;
  return v > limit ? v : 0;
}`;
  const right = `export function threshold(v) {
  const limit = 0.92;
  return v > limit ? v : 0;
}`;

  const res = merge3(base, left, right, 'js');
  assert.equal(res.hasConflicts, true);
  assert.equal(res.conflicts.length, 1);
  assert.ok(res.merged.includes('<<<<<<< left'));
  assert.ok(res.merged.includes('const limit = 0.65;'));
  assert.ok(res.merged.includes('======='));
  assert.ok(res.merged.includes('const limit = 0.92;'));
  assert.ok(res.merged.includes('>>>>>>> right'));
});

test('runCleaveCli supports diff and merge commands end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleave-cli-'));
  try {
    const baseFile = path.join(tmpDir, 'base.js');
    const leftFile = path.join(tmpDir, 'left.js');
    const rightFile = path.join(tmpDir, 'right.js');
    const outFile = path.join(tmpDir, 'merged.js');

    fs.writeFileSync(baseFile, PRESETS.jsMoveAndEdit.base, 'utf8');
    fs.writeFileSync(leftFile, PRESETS.jsMoveAndEdit.left, 'utf8');
    fs.writeFileSync(rightFile, PRESETS.jsMoveAndEdit.right, 'utf8');

    let diffOut = '';
    const diffCode = await runCleaveCli(['diff', baseFile, leftFile, '--mode', 'ast', '--json'], {
      stdout: (s) => { diffOut += s; },
      stderr: () => {}
    });
    assert.equal(diffCode, 0);
    const parsedDiff = JSON.parse(diffOut);
    assert.equal(parsedDiff.stats.movedBlocks, 1);

    let mergeOut = '';
    const mergeCode = await runCleaveCli(['merge', baseFile, leftFile, rightFile, '--out', outFile, '--json'], {
      stdout: (s) => { mergeOut += s; },
      stderr: () => {}
    });
    assert.equal(mergeCode, 0);
    const parsedMerge = JSON.parse(mergeOut);
    assert.equal(parsedMerge.hasConflicts, false);
    assert.ok(fs.readFileSync(outFile, 'utf8').includes('if (!Number.isFinite(db)) return 0;'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatDiff, detectLanguage, tokenize, tokenSimilarity, and mergeLines3 sanity', () => {
  assert.equal(detectLanguage('shader.rs'), 'rust');
  assert.equal(detectLanguage('app.py'), 'python');
  assert.equal(detectLanguage('main.go'), 'go');
  assert.equal(detectLanguage('dsp.cpp'), 'cpp');
  assert.ok(tokenize('const x = 1; // comment', 'js').length > 0);
  assert.equal(tokenSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  const formatted = formatDiff(diffAst(PRESETS.jsMoveAndEdit.base, PRESETS.jsMoveAndEdit.left, 'js'), 'a.js', 'b.js');
  assert.ok(formatted.includes('@move'));
  const m = mergeLines3('a\nb\nc', 'a1\nb\nc', 'a\nb\nc2');
  assert.equal(m.hasConflicts, false);
  assert.equal(m.merged, 'a1\nb\nc2');
});
