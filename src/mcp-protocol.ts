// MCP JSON-RPC handling with no runtime dependencies, shared by `trawl mcp` (stdio, Bun) and the Worker (HTTP).

export type Json = Record<string, unknown>;
export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
}

export interface McpServer {
  name: string;
  version: string;
  instructions: string;
  tools(): readonly ToolDef[];
  call(name: string, args: Json): Promise<ToolResult>;
}

export interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Json;
}

export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/** Answers one JSON-RPC message; undefined for notifications (no id). */
export async function handle(server: McpServer, msg: Request): Promise<Json | undefined> {
  if (msg.id === undefined || msg.id === null) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: server.tools() });
    case 'tools/call': {
      const p = msg.params ?? {};
      try {
        return reply(await server.call(String(p.name), (p.arguments as Json) ?? {}));
      } catch (e) {
        return reply(fail(e instanceof Error ? e.message : String(e)));
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}
