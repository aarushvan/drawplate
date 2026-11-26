// Tapeline Public API & CLI runner.

export {
  CASSETTE_VERSION,
  canonicalizeCassette,
  canonicalizeQuery,
  computeWaterfall,
  createCassette,
  createEntry,
  diffCassettes,
  diffJsonSchema,
  estimateBodyBytes,
  formatDiffReport,
  formatWaterfall,
  inferSchema,
  matchCassetteEntry,
  normalizePath,
  parseCassette,
  roundMs,
  roundSigned,
  serializeCassette,
  sortHeaders,
  sortObjectKeys,
  tryParseBody,
  valueType,
} from './cassette.mjs';

export {
  loadCassetteFile,
  saveCassetteFile,
  startRecordProxy,
  startReplayProxy,
} from './proxy.mjs';

import { diffCassettes, formatDiffReport, formatWaterfall } from './cassette.mjs';
import { loadCassetteFile, startRecordProxy, startReplayProxy } from './proxy.mjs';

function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export function getTapelineHelp() {
  return [
    'Usage: drawplate tapeline <command> [options]',
    '',
    'Commands:',
    '  record --target <url> [--port <port>] [--out <file>]   Start HTTP recording reverse proxy',
    '  replay --cassette <file> [--port <port>]               Start deterministic offline replay proxy',
    '  diff <before.json> <after.json> [--json]               Compare two cassettes for schema & latency drift',
    '  inspect <cassette.json> [--json]                       Render waterfall and summary for a cassette',
    '',
    'Options:',
    '  --json               Output machine-readable JSON',
    '  --fail-on-breaking   Exit non-zero if breaking route, status, or schema changes are detected',
    '  --help, -h           Show this help message',
  ].join('\n');
}

export async function runTapelineCli(args = [], io = { stdout: process.stdout, stderr: process.stderr }) {
  const writeOut = (text) => io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  const writeErr = (text) => io.stderr.write(text.endsWith('\n') ? text : `${text}\n`);

  const { positionals, flags } = parseFlags(args);
  const sub = positionals[0];

  if (!sub || flags.help || sub === 'help') {
    writeOut(getTapelineHelp());
    return { exitCode: 0 };
  }

  if (sub === 'inspect') {
    const filePath = positionals[1] || flags.cassette;
    if (!filePath) {
      writeErr('Error: tapeline inspect requires a cassette JSON file path');
      return { exitCode: 1 };
    }
    const cassette = await loadCassetteFile(filePath);
    if (flags.json) {
      writeOut(JSON.stringify(cassette, null, 2));
    } else {
      writeOut(formatWaterfall(cassette));
    }
    return { exitCode: 0, cassette };
  }

  if (sub === 'diff') {
    const beforePath = positionals[1] || flags.before;
    const afterPath = positionals[2] || flags.after;
    if (!beforePath || !afterPath) {
      writeErr('Error: tapeline diff requires <before.json> <after.json>');
      return { exitCode: 1 };
    }
    const [before, after] = await Promise.all([
      loadCassetteFile(beforePath),
      loadCassetteFile(afterPath),
    ]);
    const diff = diffCassettes(before, after);
    if (flags.json) {
      writeOut(JSON.stringify(diff, null, 2));
    } else {
      writeOut(formatDiffReport(diff));
    }
    const exitCode = flags['fail-on-breaking'] && diff.summary.hasBreakingChanges ? 2 : 0;
    return { exitCode, diff };
  }

  if (sub === 'record') {
    const target = flags.target || positionals[1];
    if (!target) {
      writeErr('Error: tapeline record requires --target <url>');
      return { exitCode: 1 };
    }
    const port = flags.port !== undefined ? Number(flags.port) : 8787;
    const outPath = flags.out || 'tapeline-cassette.json';
    const proxy = await startRecordProxy({
      target,
      port,
      outPath,
      onEntry(entry) {
        writeOut(`[record] ${entry.id} ${entry.method} ${entry.path} -> ${entry.status} (${entry.totalMs}ms)`);
      },
    });
    writeOut(`Tapeline record proxy listening on ${proxy.url} -> ${proxy.target}`);
    writeOut(`Saving cassette to ${outPath}. Press Ctrl+C to stop.`);

    await new Promise((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await proxy.close();
        writeOut(`Saved ${proxy.entries.length} recorded entries to ${outPath}`);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return { exitCode: 0 };
  }

  if (sub === 'replay') {
    const cassettePath = flags.cassette || positionals[1];
    if (!cassettePath) {
      writeErr('Error: tapeline replay requires --cassette <file>');
      return { exitCode: 1 };
    }
    const port = flags.port !== undefined ? Number(flags.port) : 8788;
    const proxy = await startReplayProxy({ cassettePath, port });
    writeOut(
      `Tapeline replay proxy listening on ${proxy.url} (${proxy.cassette.entries.length} entries from ${cassettePath})`,
    );
    writeOut('Press Ctrl+C to stop.');

    await new Promise((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await proxy.close();
        writeOut(`Replay stopped (hits=${proxy.stats.hits}, misses=${proxy.stats.misses})`);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return { exitCode: 0 };
  }

  writeErr(`Unknown tapeline command: ${sub}\n\n${getTapelineHelp()}`);
  return { exitCode: 1 };
}
