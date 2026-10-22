# flow-music-mcp

MCP server (Streamable HTTP on 127.0.0.1:7462, TypeScript) that drives Google Flow Music (https://www.flowmusic.app/) in a
dedicated Chrome profile over CDP (`playwright-core`, `connectOverCDP` on port 9334). Same approach as flow-mcp
(`C:\projects\Personal\flow-mcp`, github.com/GTAI-1/flow-mcp), which drives Google Flow; read its CLAUDE.md for lessons
that apply here too (download folder, pacing, virtual lists, never two CDP clients on one Chrome).

- `src/chrome.ts` launch/attach Chrome · `src/music.ts` UI driver · `src/queue.ts` paced job queue ·
  `src/mcp/tools.ts` the MCP tools · `src/mcp/http.ts` + `server.ts` transport (copied from comfy-mcp) · `src/login.ts`
- Build `yarn build`; run `node dist/index.js`; sign in once with `yarn login`.

## Rules

- Never guess selectors. Map them from the live page first (`music_inspect`, or the Claude in Chrome tools on the user's
  own browser, which is signed in to the same account), then write driver code.
- Anything that spends credits needs the user's OK first. `music_generate` spends them; `music_download`,
  `music_songs`, `music_inspect` and `music_status` do not.
- Never enter Google credentials; the user signs in by hand via `yarn login`.
- No bot-detection evasion. Drive the real UI at human pace (the queue pauses 20-45 s between generations).
- When Flow Music changes its UI, fix it here on a ticket branch (`FMM-NN_<what>`), update the UI map below with the date,
  and mark what was verified live.

## UI map (2026-10-22, Plus plan, mapped read-only from the user's signed-in browser)

- Next.js app; auth is Supabase (`sb.flowmusic.app`); the site's own API is `/__api/...` with a bearer token, so plain
  `fetch` from the page gets 401. We drive the UI, not the API.
- Sidebar: `New session` (`/session`), Songs (`/library/my-songs`), Playlists, Spaces, Music videos, Projects,
  Profile (`/<username>`), Turntable, then the session list (`/session/<uuid>`). Bottom: user name + plan ("PLUS"),
  a diamond with a number (credits or invites, not checked), `Invite`. A player bar at the very bottom links to the
  playing song, so song links are only read inside `<main>`.
- Home: "Welcome back", composer textbox `Chat message` ("Let's create..."), `Add audio or image`, `Chat settings`,
  `Voice mode`, `Send message`, `Open compose panel`.
- `Chat settings` menu: Customize Producer; Instrument (model, "Lyria 3.5"); Ghostwriter (Standard); Producer
  (Standard or fast thinking). The chat route is a conversation with the "Producer" agent; it proposes a Sound and a
  Lyrics card and then makes two takes. Not used by the tools.
- Compose panel (`Toggle compose panel` in a session, `Open compose panel` on home), right-hand side:
  - Lyrics section (`Expand/Collapse Lyrics section`): textbox `Lyrics`, switch `Toggle instrumental mode`.
  - Sound section: textbox `Sound description`, switch `Toggle advanced sound mode` ("Advanced").
    Advanced adds Dynamics: `BPM`, `Length`, `Seed` (text boxes, "Auto" when empty) and a Model button ("Lyria 3.5").
  - Details section: a title text box (no name; the first field after the header), `Upload image`, `Prompt image`.
  - Bottom: an unnamed trash button (clear), `Generate`.
  - No credit quote is shown before Generate.
- Song rows (in a session thread): link `/song/<uuid>` with the title, `Play <title>`, `Remix <title>`,
  `Download video for <title>`, `Share link for <title>`, `Like`, `Dislike`, `More options for <title>`.
  One request made two takes with the same title.
- `More options` menu: Remix ›, Details ›, Download › (Download video, Get stems, M4A, MP3, WAV), Share..., Add to...,
  Split stems, Report, Delete.

## Not verified yet (needs one paid generation)

- That Compose's Generate puts the two takes into the session thread as song rows (assumed).
- How a take looks while it renders, and when it fails (`songState` guesses: a percentage, a progress bar, or words).
- That MP3/WAV/M4A download as files through Chrome's download, and how long WAV takes.
- The Model menu's options, the Length format, and the `/song/<id>` page layout (`music_download` for older songs).
- What one song costs, and whether the sidebar diamond is the credit balance.
