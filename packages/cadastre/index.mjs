// Cadastre public API and CLI runner (Node 26 SQLite + MCP + hybrid search)

import {
  EMBEDDING_DIMS,
  base64ToVector,
  detectCodeLanguage,
  embedText,
  extractFile,
  tokenizeIdentifierText,
  vectorToBase64
} from './extract.mjs';
import {
  cosineInt8,
  getSymbolDetails,
  prepareIndex,
  searchIndex,
  traceCallees,
  traceCallers
} from './search.mjs';
import { CadastreStore, indexDirectory } from './store.mjs';
import { MCP_PROTOCOL_VERSION, MCP_TOOLS, createMcpHandler, startMcpServer } from './mcp.mjs';

export {
  CadastreStore,
  EMBEDDING_DIMS,
  MCP_PROTOCOL_VERSION,
  MCP_TOOLS,
  base64ToVector,
  cosineInt8,
  createMcpHandler,
  detectCodeLanguage,
  embedText,
  extractFile,
  getSymbolDetails,
  indexDirectory,
  prepareIndex,
  searchIndex,
  startMcpServer,
  tokenizeIdentifierText,
  traceCallees,
  traceCallers,
  vectorToBase64
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
  cadastre index <dir> [--db <path>] [--force] [--json]
  cadastre query <q> [--db <path>] [--mode hybrid|graph|lexical] [--limit <n>] [--json]
  cadastre callers <sym> [--db <path>] [--depth <n>] [--callees] [--json]
  cadastre symbol <sym> [--db <path>] [--json]
  cadastre stats [--db <path>] [--json]
  cadastre export-json <out> [--db <path>] [--dir <dir>]
  cadastre mcp [--db <path>]
`;

export async function runCadastreCli(args = [], io = null) {
  const writeOut = io?.stdout || ((s) => process.stdout.write(s));
  const writeErr = io?.stderr || ((s) => process.stderr.write(s));

  const { positional, flags } = parseCliFlags(args);
  const sub = positional[0];
  const dbPath = flags.db || '.cadastre.sqlite';

  if (!sub || flags.help || sub === 'help') {
    writeOut(HELP_TEXT);
    return 0;
  }

  if (sub === 'mcp') {
    const server = startMcpServer({ dbPath });
    await server.done;
    return 0;
  }

  const store = new CadastreStore(dbPath);
  try {
    if (sub === 'index') {
      const targetDir = positional[1] || '.';
      const summary = store.indexDirectory(targetDir, { force: Boolean(flags.force) });
      if (flags.json) {
        writeOut(JSON.stringify(summary, null, 2) + '\n');
      } else {
        writeOut(
          `Indexed ${summary.filesIndexed} files (${summary.filesSkipped} unchanged, ${summary.filesRemoved} removed) -> ` +
          `${summary.symbolsIndexed} symbols, ${summary.edgesIndexed} edges in ${summary.elapsedMs} ms (${summary.dbSizeBytes} bytes)\n`
        );
      }
      return 0;
    }

    if (sub === 'query') {
      const query = positional.slice(1).join(' ').trim();
      if (!query) {
        writeErr('Error: cadastre query requires <q>\n');
        return 1;
      }
      const mode = flags.mode || 'hybrid';
      const limit = flags.limit ? Number(flags.limit) : 10;
      const res = store.search(query, { mode, limit, fileFilter: flags.file || null });
      if (flags.json) {
        writeOut(JSON.stringify(res, null, 2) + '\n');
      } else {
        writeOut(`Cadastre query "${res.query}" [${res.mode}] (${res.elapsedMs} ms, ${res.results.length} hits):\n`);
        for (const r of res.results) {
          writeOut(
            `  ${r.score.toFixed(3)}  ${r.qualifiedName} (${r.kind})  ${r.file}:${r.startLine}-${r.endLine}  ` +
            `[vec=${r.breakdown.vector.toFixed(2)} bm25=${r.breakdown.bm25.toFixed(2)} graph=${r.breakdown.graph.toFixed(2)}]\n`
          );
        }
      }
      return 0;
    }

    if (sub === 'callers') {
      const sym = positional[1];
      if (!sym) {
        writeErr('Error: cadastre callers requires <sym>\n');
        return 1;
      }
      const depth = flags.depth ? Number(flags.depth) : 3;
      const trace = flags.callees ? store.callees(sym, depth) : store.callers(sym, depth);
      if (flags.json) {
        writeOut(JSON.stringify(trace, null, 2) + '\n');
      } else {
        writeOut(`${trace.direction} of ${trace.root} (depth <= ${trace.maxDepth}): ${trace.edges.length} edges\n`);
        for (const e of trace.edges) {
          writeOut(`  [d=${e.depth}] ${e.from} -> ${e.to}  (${e.file}:${e.line})\n`);
        }
      }
      return 0;
    }

    if (sub === 'symbol') {
      const sym = positional[1];
      if (!sym) {
        writeErr('Error: cadastre symbol requires <sym>\n');
        return 1;
      }
      const details = store.getSymbol(sym);
      if (flags.json) {
        writeOut(JSON.stringify(details, null, 2) + '\n');
      } else {
        for (const m of details.matches) {
          writeOut(`${m.qualifiedName} (${m.kind}) ${m.file}:${m.startLine}-${m.endLine}\n${m.signature}\n`);
        }
      }
      return 0;
    }

    if (sub === 'stats') {
      const stats = store.getStats();
      if (flags.json) {
        writeOut(JSON.stringify(stats, null, 2) + '\n');
      } else {
        writeOut(
          `Cadastre DB: ${stats.dbPath} (${stats.dbSizeBytes} bytes)\n` +
          `Files: ${stats.files} | Lines: ${stats.lines} | Symbols: ${stats.symbols} | Edges: ${stats.edges} | Vectors: ${stats.vectors} (${stats.embeddingDims}d ${stats.quantization})\n`
        );
      }
      return 0;
    }

    if (sub === 'export-json') {
      const outPath = positional[1];
      if (!outPath) {
        writeErr('Error: cadastre export-json requires <out>\n');
        return 1;
      }
      if (flags.dir) {
        store.indexDirectory(flags.dir);
      }
      const snap = store.exportSnapshot(outPath);
      writeOut(`Exported Cadastre snapshot (${snap.symbols.length} symbols, ${snap.edges.length} edges) to ${outPath}\n`);
      return 0;
    }

    writeErr(`Unknown cadastre subcommand: ${sub}\n${HELP_TEXT}`);
    return 1;
  } finally {
    store.close();
  }
}
