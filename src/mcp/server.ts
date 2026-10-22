import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, toolList, type Tool } from "./tools.js";

// The MCP server object: `initialize`, `tools/list` and `tools/call` on the SDK's `Server`. `http.ts` makes one per session.
//
//   claude mcp add --transport http flow-music-mcp http://127.0.0.1:7462/mcp

export const SERVER_INFO = { name: "flow-music-mcp", version: "0.1.0" };

export const INSTRUCTIONS = `Two Google creative sites driven in one dedicated Chrome window (one tab each), using the user's own accounts.

GOOGLE FLOW MUSIC (flowmusic.app, music_* tools): music_generate fills the Compose panel (sound description, lyrics or instrumental, title, optionally BPM, length, seed and model), presses Generate, waits for the take (about a minute) and downloads it as MP3, WAV or M4A. Generating SPENDS FLOW MUSIC CREDITS: ask the user before the first one in a session. music_download fetches an existing song by id without generating; music_songs lists the library.

GOOGLE FLOW (flow.google.com, flow_* tools): images and, later, video, made through Flow's creative agent in a project. Flow IMAGES (Nano Banana) ARE FREE. Flow VIDEO, Flow voices and video edits SPEND FLOW CREDITS and are not offered yet (video arrives in phase 6): ask the user before any paid action. Call flow_status first (signed in, plan, credits, playbook). flow_generate makes one image per scene as paced jobs; flow_agent_images asks the agent for many images in one request; both save <name>-NN.jpeg by scene number. flow_assets lists a project's media by media_id (titles repeat: use media_id), flow_download fetches one at 1K, 2K or 4K, flow_trash moves one to Flow's Trash (confirm with the user first). flow_inspect lists the page's controls when a step breaks after a UI change.

Both sites queue their generations: one at a time per site with a pause between them (a Flow job and a Flow Music job may run at the same time). A call waits up to "wait" seconds and otherwise returns job ids: then call music_wait or flow_wait (never generate the same thing again, the job is still running). music_status and flow_status say whether the Chrome profile is signed in; if not, the user runs \`yarn login\` in the repo once. music_inspect and flow_inspect list a page's controls when a step breaks after a UI change.`;

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
