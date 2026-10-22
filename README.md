# flow-music-mcp

An MCP server that makes songs with [Google Flow Music](https://www.flowmusic.app/) through its web UI, in a Chrome window of its own, using your Flow Music plan instead of an API. It fills the Compose panel (sound, lyrics or instrumental, title, and optionally BPM, length, seed and model), presses Generate, waits for the takes and downloads them as MP3, WAV or M4A.

It is built the same way as [flow-mcp](https://github.com/GTAI-1/flow-mcp), which does the same for Google Flow (video and images). It drives the real UI at a human pace and will break when Google changes that UI. Automating a consumer web app may conflict with Google's terms; use it on your own account at your own risk.

## Setup

Node 24 and Google Chrome.

```sh
yarn install
yarn build
yarn login        # opens Chrome with the tool's own profile: sign in to Google there once
yarn start        # MCP on http://127.0.0.1:7462/mcp
```

The profile lives in `~/.flow-music-mcp/chrome-profile` and Chrome is driven over DevTools on port 9334, so it never touches your everyday Chrome profile or flow-mcp's Chrome (9333).

```sh
claude mcp add --transport http flow-music-mcp http://127.0.0.1:7462/mcp
```

## Tools

| Tool | What it does | Credits |
|---|---|---|
| `music_status` | Chrome up, signed in, folders, job queue | no |
| `music_generate` | Compose → Generate → wait → download the take (`<name>.mp3|wav|m4a`, about a minute) | **yes** |
| `music_wait` | Waits for jobs (≤ 50 s per call) | no |
| `music_jobs`, `music_cancel`, `music_retry` | The queue | retry: yes |
| `music_download` | Downloads an existing song by id | no |
| `music_songs` | Newest songs in your library | no |
| `music_inspect` | Every visible control on the page, for fixing selectors | no |

A generation runs as a job: the call waits up to `wait` seconds (default 30) and otherwise returns a job id for `music_wait`. Jobs run one at a time with a 20-45 s pause between them.

## Settings

| Env | Default | |
|---|---|---|
| `FLOW_MUSIC_MCP_PORT` / `--port` | 7462 | MCP port |
| `FLOW_MUSIC_MCP_TOKEN` | unset | require `Authorization: Bearer <token>` |
| `FLOW_MUSIC_MCP_CDP_PORT` | 9334 | Chrome DevTools port |
| `FLOW_MUSIC_MCP_HOME` | `~/.flow-music-mcp` | profile, downloads, default output |
| `FLOW_MUSIC_MCP_CHROME` | found | Chrome executable |
| `FLOW_MUSIC_MCP_PAUSE_MIN_S` / `_MAX_S` | 20 / 45 | pause between generations |

## Status

Run end to end against Flow Music on 2026-10-22: an instrumental generated and downloaded as WAV in 46 s, and an existing song downloaded as MP3. Lyrics, the Advanced settings and the model menu are not tried yet; `CLAUDE.md` lists what is verified and what is not.
