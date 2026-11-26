#!/usr/bin/env node
// Drawplate unified CLI: subpass | cleave | cadastre | slewbox | tapeline | serve | bench | snapshot

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `drawplate ${pkg.version}: local-first developer suite (zero runtime dependencies)

Usage: drawplate <command> [options]

Tools:
  subpass   <check|inspect|presets> ...          GLSL/WGSL shader analyzer and preset inspector
  cleave    <diff|merge> ...                     Structural AST diff and three-way merge
  cadastre  <index|query|callers|symbol|stats|export-json|mcp> ...
                                                 SQLite hybrid vector + call-graph code index, MCP server
  slewbox   <patches|render> ...                 DSP synth patches and 48 kHz WAV renderer
  tapeline  <record|replay|diff|inspect> ...     HTTP record/replay proxy and cassette schema diff

Platform:
  serve [--port 8080] [--host 127.0.0.1]         Static site plus live local API (workbench.html uses it)
  bench [--runs N] [--json] [--out file]         Live benchmarks of all five tools on this repo
  snapshot [--out data/cadastre-snapshot.json]   Export Cadastre index of packages/ and bin/ to JSON

Global:
  --help, -h       Show help (also works after a tool name)
  --version, -v    Print version
`;

function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i += 1;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function normalizeExit(result) {
  if (typeof result === 'number') return result;
  if (result && typeof result.exitCode === 'number') return result.exitCode;
  return 0;
}

async function cmdServe(args) {
  const { flags } = parseFlags(args);
  const { startServer } = await import('./serve.mjs');
  const port = flags.port !== undefined ? Number(flags.port) : 8080;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`drawplate serve: invalid --port "${flags.port}"\n`);
    return 1;
  }
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const srv = await startServer({ port, host, root: ROOT, version: pkg.version });
  process.stdout.write(
    `Drawplate listening on ${srv.url}\n` +
      `  site:       ${srv.url}/index.html\n` +
      `  workbench:  ${srv.url}/workbench.html\n` +
      `  api:        ${srv.url}/api/health\n` +
      `  cadastre:   ${srv.indexSummary.filesIndexed} files indexed, ${srv.indexSummary.filesSkipped} unchanged\n` +
      'Press Ctrl+C to stop.\n',
  );
  await new Promise((resolve) => {
    const stop = async () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await srv.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function cmdBench(args) {
  const { flags } = parseFlags(args);
  const { runBench, formatBenchTable } = await import('./bench.mjs');
  const runs = flags.runs !== undefined ? Number(flags.runs) : 15;
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000) {
    process.stderr.write(`drawplate bench: invalid --runs "${flags.runs}" (expected 1..1000)\n`);
    return 1;
  }
  const report = await runBench({ root: ROOT, runs });
  if (typeof flags.out === 'string') {
    const outPath = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatBenchTable(report));
    if (typeof flags.out === 'string') process.stdout.write(`JSON written to ${flags.out}\n`);
  }
  return 0;
}

async function cmdSnapshot(args) {
  const { flags } = parseFlags(args);
  const { CadastreStore } = await import('../packages/cadastre/index.mjs');
  const os = await import('node:os');
  const outPath = path.resolve(typeof flags.out === 'string' ? flags.out : path.join(ROOT, 'data/cadastre-snapshot.json'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drawplate-snapshot-'));
  const store = new CadastreStore(path.join(tmp, 'cadastre.sqlite'));
  try {
    const summary = store.indexDirectory(ROOT, { includePaths: ['packages', 'bin'] });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const snap = store.exportSnapshot(outPath);
    process.stdout.write(
      `Exported Cadastre snapshot: ${snap.files.length} files, ${snap.symbols.length} symbols, ${snap.edges.length} edges ` +
        `(indexed in ${summary.elapsedMs} ms) -> ${outPath}\n`,
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return 0;
}

async function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`drawplate ${pkg.version}\n`);
    return 0;
  }

  switch (cmd) {
    case 'subpass': {
      const { runSubpassCli } = await import('../packages/subpass/index.mjs');
      return normalizeExit(await runSubpassCli(rest));
    }
    case 'cleave': {
      const { runCleaveCli } = await import('../packages/cleave/index.mjs');
      return normalizeExit(await runCleaveCli(rest));
    }
    case 'cadastre': {
      const { runCadastreCli } = await import('../packages/cadastre/index.mjs');
      return normalizeExit(await runCadastreCli(rest));
    }
    case 'slewbox': {
      const { runSlewboxCli } = await import('../packages/slewbox/index.mjs');
      return normalizeExit(await runSlewboxCli(rest));
    }
    case 'tapeline': {
      const { runTapelineCli } = await import('../packages/tapeline/index.mjs');
      return normalizeExit(await runTapelineCli(rest));
    }
    case 'serve':
      return cmdServe(rest);
    case 'bench':
      return cmdBench(rest);
    case 'snapshot':
      return cmdSnapshot(rest);
    default:
      process.stderr.write(`drawplate: unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`drawplate: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  },
);
