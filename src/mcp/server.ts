import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, toolList, type Tool } from "./tools.js";

// The MCP server object: `initialize`, `tools/list` and `tools/call` on the SDK's `Server`. `http.ts` makes one per session.
//
//   claude mcp add --transport http flow-music-mcp http://127.0.0.1:7462/mcp

export const SERVER_INFO = { name: "flow-music-mcp", version: "0.1.0" };

export const INSTRUCTIONS = `Two Google creative sites driven in one dedicated Chrome window (one tab each), using the user's own accounts.

GOOGLE FLOW MUSIC (flowmusic.app, music_* tools): music_generate fills the Compose panel (sound description, lyrics or instrumental, title, optionally BPM, length, seed and model), presses Generate, waits for the take (about a minute) and downloads it as MP3, WAV or M4A. Generating SPENDS FLOW MUSIC CREDITS: ask the user before the first one in a session. music_download fetches an existing song by id without generating; music_songs lists the library.

GOOGLE FLOW (flow.google.com, flow_* tools): images and video in a project. Flow IMAGES (Nano Banana) ARE FREE. Flow VIDEO (flow_generate type video, flow_continue, flow_edit on a video) and flow_narrate engine flow SPEND FLOW CREDITS: ask the user first and pass max_credits. flow_generate and flow_continue read Flow's live credit quote and refuse before starting if it is above max_credits; a video edit shows no quote, so its cost is only measured (credits_spent). Call flow_status first (signed in, plan, credits, playbook). flow_generate makes one image or clip per scene as paced jobs in Flow's direct composer with the exact prompt (first_frame / last_frame, reference_images, chain_previous, techniques); flow_agent_images asks Flow's agent for many free images in one request. Files are saved as <name>-NN.<ext> by scene number. flow_character / flow_character_edit / flow_characters manage characters (free), flow_edit edits an image (free) or a video (paid). flow_assets lists a project's media by media_id (titles repeat: use media_id), flow_download fetches one at 1K, 2K or 4K, flow_trash moves one to Flow's Trash (confirm with the user first). Uploading a local file makes Flow ask for a confirmation of rights ("I agree"): that is the user's to give, never yours; asset:<media_id> needs no upload. flow_inspect lists the page's controls when a step breaks after a UI change.

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
