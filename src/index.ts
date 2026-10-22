#!/usr/bin/env node
// .env first, before any module reads process.env (see src/env.ts and .env.example).
import "./env.js";
import { McpHttpServer } from "./mcp/http.js";
import { buildTools } from "./mcp/tools.js";

// flow-music-mcp: an MCP server (Streamable HTTP on 127.0.0.1) that drives Google Flow and Google Flow Music in a
// dedicated Chrome profile, plus local voice, assembly and caption tools.
//
//   node dist/index.js [--port 7462]
//
// Prints "MCP listening on <url>" when ready; exits 1 when the port is taken.

const HELP = `flow-music-mcp: MCP server for Google Flow Music

  node dist/index.js [--port <n>]

  --port <n>                     MCP port on 127.0.0.1 (default 7462; FLOW_MUSIC_MCP_PORT)
  FLOW_MUSIC_MCP_TOKEN           require "Authorization: Bearer <token>" when set
  FLOW_MUSIC_MCP_CDP_PORT        Chrome DevTools port of the dedicated Chrome (default 9334)
  FLOW_MUSIC_MCP_HOME            profile, downloads and default output (default ~/.flow-music-mcp)
  FLOW_MUSIC_MCP_CHROME          Chrome executable, when it is not in a standard place
  FLOW_MUSIC_MCP_PAUSE_MIN_S/MAX_S  pause between generations (default 20-45 s)

Sign in once with: yarn login
`;

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
const portArg = argv.indexOf("--port");
const port = Number(portArg >= 0 ? argv[portArg + 1] : (process.env.FLOW_MUSIC_MCP_PORT ?? 7462));

const server = new McpHttpServer({ host: { tools: buildTools() }, port, token: process.env.FLOW_MUSIC_MCP_TOKEN || null, log });
const status = await server.start();
if (!status.running) {
  log(status.error ?? "could not start");
  process.exit(1);
}
process.stdout.write(`MCP listening on ${status.url}\n`);

const shutdown = (signal: string) => {
  log(`${signal}: stopping`);
  void server.stop().finally(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
