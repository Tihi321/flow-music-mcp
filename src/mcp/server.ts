import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, toolList, type Tool } from "./tools.js";

// The MCP server object: `initialize`, `tools/list` and `tools/call` on the SDK's `Server`. `http.ts` makes one per session.
//
//   claude mcp add --transport http flow-music-mcp http://127.0.0.1:7462/mcp

export const SERVER_INFO = { name: "flow-music-mcp", version: "0.1.0" };

export const INSTRUCTIONS = `Google Flow Music (flowmusic.app) driven in its own Chrome window, using the user's Flow Music plan. music_generate fills the Compose panel (sound description, lyrics or instrumental, title, and optionally BPM, length, seed and model), presses Generate, waits for the two takes and downloads them as MP3, WAV or M4A into an absolute folder. Generations queue and run one at a time with a pause between them. A call waits up to "wait" seconds and otherwise returns a job id: then call music_wait (never call music_generate again for the same song, the job is still running). Generating SPENDS FLOW MUSIC CREDITS: ask the user before the first one in a session. music_download fetches an existing song by id without generating. music_status says whether the Chrome profile is signed in; if not, the user runs \`yarn login\` in the repo once. music_inspect lists the page's controls when a step breaks after a UI change.`;

export interface McpHost {
  tools: readonly Tool[];
  instructions?: string;
}

export function createMcpServer(host: McpHost): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: host.instructions ?? INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList(host.tools) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(host.tools, request.params.name, request.params.arguments));
  return server;
}
