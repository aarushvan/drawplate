// Cadastre stdio JSON-RPC 2.0 MCP Server (Node 26 zero-dependency)

import readline from 'node:readline';
import { CadastreStore } from './store.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_TOOLS = [
  {
    name: 'cadastre_search',
    description: 'Hybrid local code search combining 128-dim int8 quantized vector similarity, BM25 lexical ranking, and call-graph neighbor boost.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language or symbol query to search across indexed code.'
        },
        mode: {
          type: 'string',
          enum: ['hybrid', 'graph', 'lexical'],
          default: 'hybrid',
          description: 'Ranking strategy: hybrid (vector+BM25+graph), graph, or lexical.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum number of ranked symbol hits to return.'
        },
        fileFilter: {
          type: 'string',
          description: 'Optional substring filter on relative file path.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'cadastre_callers',
    description: 'Trace upstream callers and/or downstream callees of a symbol across the indexed call graph.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol name (e.g. diffAst or CadastreStore.search).'
        },
        maxDepth: {
          type: 'integer',
          minimum: 1,
          maximum: 6,
          default: 3,
          description: 'Maximum call-graph traversal depth.'
        },
        direction: {
          type: 'string',
          enum: ['callers', 'callees', 'both'],
          default: 'callers',
          description: 'Direction to traverse the call graph.'
        }
      },
      required: ['symbol']
    }
  },
  {
    name: 'cadastre_symbol',
    description: 'Inspect exact symbol definition(s), source snippet, file/line span, and direct callers/callees.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Exact or partial symbol name to inspect.'
        }
      },
      required: ['symbol']
    }
  },
  {
    name: 'cadastre_stats',
    description: 'Return index statistics: file count, symbol count, call-graph edges, vector count, SQLite DB size, and language breakdown.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function toolOk(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false
  };
}

function toolErr(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true
  };
}

export function createMcpHandler(store) {
  return function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }

    if (method === 'initialize') {
      const clientVersion = params?.protocolVersion || MCP_PROTOCOL_VERSION;
      return jsonRpcOk(id, {
        protocolVersion: clientVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: 'drawplate-cadastre',
          version: '1.0.0'
        }
      });
    }

    if (method === 'ping') {
      return jsonRpcOk(id, {});
    }

    if (method === 'tools/list') {
      return jsonRpcOk(id, { tools: MCP_TOOLS });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const args = params?.arguments || {};

      try {
        if (toolName === 'cadastre_search') {
          if (!args.query || typeof args.query !== 'string') {
            return jsonRpcOk(id, toolErr('Missing required string argument: query'));
          }
          const res = store.search(args.query, {
            mode: args.mode || 'hybrid',
            limit: args.limit ?? 10,
            fileFilter: args.fileFilter || null
          });
          return jsonRpcOk(id, toolOk(res));
        }

        if (toolName === 'cadastre_callers') {
          if (!args.symbol || typeof args.symbol !== 'string') {
            return jsonRpcOk(id, toolErr('Missing required string argument: symbol'));
          }
          const depth = args.maxDepth ?? 3;
          const direction = args.direction || 'callers';
          if (direction === 'callees') {
            return jsonRpcOk(id, toolOk(store.callees(args.symbol, depth)));
          }
          if (direction === 'both') {
            return jsonRpcOk(id, toolOk({
              symbol: args.symbol,
              callers: store.callers(args.symbol, depth),
              callees: store.callees(args.symbol, depth)
            }));
          }
          return jsonRpcOk(id, toolOk(store.callers(args.symbol, depth)));
        }

        if (toolName === 'cadastre_symbol') {
          if (!args.symbol || typeof args.symbol !== 'string') {
            return jsonRpcOk(id, toolErr('Missing required string argument: symbol'));
          }
          return jsonRpcOk(id, toolOk(store.getSymbol(args.symbol)));
        }

        if (toolName === 'cadastre_stats') {
          return jsonRpcOk(id, toolOk(store.getStats()));
        }

        return jsonRpcOk(id, toolErr(`Unknown tool: ${toolName}`));
      } catch (err) {
        return jsonRpcOk(id, toolErr(`Tool execution failed: ${err.message}`));
      }
    }

    if (isNotification) return null;
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  };
}

export function startMcpServer({
  dbPath = '.cadastre.sqlite',
  input = process.stdin,
  output = process.stdout,
  store: existingStore = null
} = {}) {
  const ownsStore = !existingStore;
  const store = existingStore || new CadastreStore(dbPath);
  const handleMessage = createMcpHandler(store);

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')) + '\n');
      return;
    }

    const response = handleMessage(parsed);
    if (response !== null && response !== undefined) {
      output.write(JSON.stringify(response) + '\n');
    }
  });

  const closePromise = new Promise((resolve) => {
    rl.on('close', () => {
      if (ownsStore) {
        try {
          store.close();
        } catch {
          // Ignore already closed store
        }
      }
      resolve();
    });
  });

  return {
    store,
    rl,
    done: closePromise,
    close: () => rl.close()
  };
}
