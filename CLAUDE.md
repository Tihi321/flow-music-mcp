# flow-music-mcp

MCP server (Streamable HTTP on 127.0.0.1:7462, TypeScript) that drives Google Flow Music (https://www.flowmusic.app/) and Google Flow
(https://flow.google.com/, tools `flow_*`, FMM-02) in a dedicated Chrome profile, one tab per site, over CDP (`playwright-core`, `connectOverCDP` on port 9334). Same approach as flow-mcp
(`C:\projects\Personal\flow-mcp`, github.com/GTAI-1/flow-mcp), which drives Google Flow; read its CLAUDE.md for lessons
that apply here too (download folder, pacing, virtual lists, never two CDP clients on one Chrome).

- `src/chrome.ts` launch/attach Chrome, `getPage(site)`, per-site lock · `src/music.ts` Flow Music UI driver · `src/queue.ts` paced job queue ·
  `src/flow/` Google Flow: `driver.ts`, `agent.ts`, `queue.ts`, `tools.ts` (see "Flow UI map") ·
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
  The Producer chat made two takes with the same title; Compose makes one.
- `More options` menu: Remix ›, Details ›, Download › (Download video, Get stems, M4A, MP3, WAV), Share..., Add to...,
  Split stems, Report, Delete.

## Verified live (2026-10-22, two paid instrumental generations)

- Compose's Generate makes ONE take in the session thread. While it renders, `<main>` shows `Creating "<title>"...`,
  a Sound card, and a row "NN% Generating <title>..." with no song link; the link `/song/<uuid>` appears when it is done.
  Both takes took under a minute (2:40 and 2:58 of audio). The finished take starts playing by itself (row button
  `Pause <title>`); the driver pauses it.
- On a brand-new `/session`, the first Generate press only created the session and rendered nothing (no song, no credits).
  A press on an existing session posted `POST /__api/producer/tool-call` and started at once. The driver presses a second
  time only when nothing renders 20 s after the first; the second end-to-end run (fresh session) made exactly one song.
- Download: a pointer moving from `Download` to its submenu closes the submenu ("<html> intercepts pointer events"), so
  the driver uses the keyboard: focus `Download`, ArrowRight, focus `MP3`/`WAV`/`M4A`, Enter. Chrome fetches
  `GET /__api/download/audio/<id>?format=mp3`. MP3: 3 MB, 48 kHz stereo, ~150 kb/s, cover art embedded, in ~6 s.
  WAV: pcm_s16le 48 kHz stereo, 35 MB for 2:58.
- `music_songs` (Songs page) and `music_download` from that page both work. Next.js's route announcer is a
  `role="alert"` holding the page title; `pageNotice` ignores it.
- A Google cookie notice ("Hide") sits at the bottom; it does not block anything and is left alone.
- The sidebar diamond read 2 before and after both generations, so it is probably not the credit balance.

## Not verified yet

- Lyrics (vocal songs), Advanced (BPM, Length format, Seed), the Model menu's options, M4A.
- What a failed take looks like (`songState` guesses from its text), and an out-of-credits message.
- The `/song/<id>` page when the song is not in the current list (`music_download` falls back to it).
- What one song costs.

## Flow UI map (2026-10-22, PRO plan, flow.google.com, mapped live on CDP 9334 in the project "fmm-02-test")

Test project: `fmm-02-test` (id `f942b8e4-1579-482d-9b66-59f5d75c2189`, created free for these tests; its leftovers are test images, one in Trash). Other projects on the account ("Flow Studio", "Oct 21 - 21:54") were only read: they hold one test image and nothing. No credits were spent mapping (balance 1,050 before and after). No video tile exists in any project, so video tiles and video download sizes are NOT mapped yet (phase 6).

**The big finding: Flow has TWO composers.** The right-hand agent panel (`flow-agent-panel`, open on a fresh load) is the new, agent-only UI. But `Close` in that panel collapses it to the older bottom composer: `What do you want to create?`, `Add media menu`, an `Agent` pill (`aria-pressed`), `Expand`, `Settings trigger`, `Start generation`. With `Agent` off it is flow-mcp's direct composer again: `Settings trigger` opens the popover with radios `Image` | `Video`, aspect, `Select model family`, x1-x4 and the live quote link ("Generating will use 0 credits"). So flow-mcp's direct driver (exact prompts, credit quotes, Frames mode) may still work behind `Close` + `Agent` off; this ticket drives the agent panel as planned. `Agent` on + `Expand` reopens the panel (`ensureAgentPanel` does that). Not tried: generating from the direct composer.

### Pages and chrome

- Home `flow.google.com/?hl=en`: `New project` button, cards `.project-card` (`a[href^="/project/<uuid>"]`, `.project-title-label` whose text is "<name>\nedit"), buttons `Edit project title`, `Delete project`. New project opens `/project/<uuid>` titled "Oct 22 - 09:56"; the title is `input[aria-label="Editable text"]` (click, select all, type, Enter renames it).
- Project page: left nav `navigation "Project navigation"` (buttons "dashboard All media", "image Images" (once there are images), "accessibility_new Characters", "movie Scenes"; links "folder Library add" and "apps_spark_2 Tools" (`/tools`), "delete Trash" (`/trash`); `Collapse`). Images and Scenes are in-page filters (the URL stays the project root). Top bar: `Home`, project title, `More options for the project` (Rename, View trash, Delete), `Search`, `Filtering and sorting options` (Type: Images/Videos/Collections/Scenes/Characters; Aspect ratio; Created: Generated/Uploaded/Favorites; Duration 4-10s; Resolution; Sort Newest/Oldest), `Add media menu` (+), `Product help`, `Settings` (view settings: Grid/Batch, grid size S/M/L, sound on hover, show tile details, Clear prompt on submit), `More options`, `Account details`.
- `Add media menu`: `Upload` (file chooser), `New collection`, `Create character`, `New scene`.
- Account (credits and plan): button `Account details` (its text starts with "PRO"); clicking it opens `dialog "Account settings"` with link "1,050 Google Flow credits", `Upgrade`, `Manage subscription`, `Sign out of all accounts` (never touched), and `Close account panel`.
- Trash (`/project/<id>/trash`): "0 items in trash", `Restore all`, `Delete all`, `Back button to go to previous page`; tiles offer Restore / Delete permanently (old flow-mcp map). Library = collections (created with the `+` next to it or `Create collection`); not mapped further.
- A Google cookie notice with `Hide` (`.glue-cookie-notification-bar`) covers the lower part of the agent panel and swallows clicks on its Settings button: `dismissCookieNotice` clicks `Hide` (it only hides the notice).
- Menus of Agent settings (model menus) ignore Escape and leave `.cdk-overlay-backdrop-showing`; clicking the backdrop closes them (`clearBackdrops`).

### The agent panel (`flow-agent-panel`)

- Header buttons: `Open session history` (list "Session history": `New session`, `edit_square Create new session`, one button per session, `More options`; `Back`, `Close`), `Start new session`, `Close`. Starter chips on an empty session ("Brainstorm with me", "Edit a video with Omni", "Generate concept art"...). Sessions get auto-titles ("Red Fox Snowy Cartoon").
- Prompt box: `.ProseMirror` "What do you want to create?" inside `flow-creative-agent-prompt-box`. Enter submits, so prompts go in as one line (`keyboard.insertText`). Buttons: `+` (ingredients, aria name `Add ingredients to the prompt box`), `Agent instructions` (aria-pressed; opens "Agent instructions": `Add instruction` makes an empty instruction at once (toggle `Toggle instruction active`, `Delete instruction`, `Reference`, textarea `Instruction description`), `Done`), `Settings`, `Start generation` (disabled when empty; while the agent works the same spot shows `Stop`). With text or a chip in the box a `Clear prompt` button appears (UNVERIFIED whether it also removes attached chips). A new session keeps the composer's attached chips.
- `Settings` opens "Agent settings" (`h2`; `Back` discards, `Save` applies and returns to the chat; per project, persistent): "Confirm before generating" = mat-radio `Always` (agent asks before generating media) | `Never` (generates and spends credits automatically); "Image generation default": aspect radios `16:9 4:3 1:1 3:4 9:16` (buttons role radio, text "crop_16_9 16:9"), count `x1..x4`, model button `Image generation default model` (menu: Nano Banana Pro, Nano Banana 2 Lite, Nano Banana 2.1; the button text reads "🍌 Nano Banana 2.1 arrow_drop_down"); "Video generation default": aspect `16:9 9:16`, count `x1..x4`, model button `Video generation default model` (menu: Omni 1.1 Flash, Veo 3.1 - Lite, Veo 3.1 - Fast, Veo 3.1 - Quality). A new project starts at images 16:9 x2 Nano Banana 2.1, video 16:9 x1 Omni 1.1 Flash, confirm Always. The driver reads these, sets what a request needs and always restores them (verified: 9:16 + Nano Banana 2 Lite for a run, back to 16:9 x2 2.1 afterwards).
- Ingredients picker (`+`): opens a popover (`aria-expanded=true`) with a project drop-down (assets of other projects), `Search assets`, sort `Recent`, tabs All / Images / Videos / Voices / Characters / Uploads (no Avatars tab in a project with no avatar), `Upload media`, `cdk-virtual-scroll-viewport` `listbox "Asset list"` with `button[role=option]` named "<title> Image|Video" (assets already attached are not listed). Clicking an option only previews it on the right; `Add to prompt` attaches it and closes the picker; the composer then shows a chip (button "Ingredient"; "Image ingredient" once sent). Escape closes the picker.
- References and frames go through the agent in words plus chips: with a chip of the teapot image and "show the same teapot but green", the agent EDITED it: the tile "Blue teapot on kitchen table" got a NEW media id (and a layers icon) and the old one left the grid, so the grid still shows 3 tiles. Freshness by media id still works; titles repeat. Two image chips with "start exactly on the first attached image as its first frame and end on the second as its last frame" made the agent choose "Image Interpolation" with Omni 1.1 Flash and ask to confirm 7 credits (rejected, nothing made). Whether a chip is a reference or a frame is decided by the agent from the words, so prompts have to say it (flow-mcp's I2V/R2V lesson).

### What the agent does

- Free image requests (confirm Always) are NOT confirmed: one image (x1) "Analyzing Image Request" then done in ~25-50 s; a 3-scene numbered request ("Generate exactly 3 separate images, one image per scene, in scene order ... Scene 1: ... Scene 2: ... Scene 3: ...") made exactly 3 images in ~35 s (not 6, although the default is x2), reply "I've generated your three scenes ...", chat thumbnails `img[alt="Option N"]` (same signed src as the grid tile) in scene order. New tiles landed in the grid in FINISH order (scene 3, 1, 2), and the agent's own titles repeat. Stored prompts (tile `Reuse prompt` -> agent composer text) were exactly the scene text without the "Scene N:" prefix ("A red fox sitting in fresh snow, flat cartoon style."), so flow-mcp's word-overlap `matchScenes` works. `Reuse prompt` does NOT leave the grid or open another view in the new UI.
- Variants: the agent setting x2 plus "N separate variations of each scene" in the prompt gave 2 tiles for one scene (saved scene-01 and scene-01-v2).
- A VIDEO request (confirm Always) stops at a card: "I'll generate a 4-second video ... using Omni 1.1 Flash. Would you like me to kick off this 1 video generation, costing 7 credits?" with `div[role=radio]` `Approve`, `Always approve`, `Reject` (names carry an icon word, so match with hasText). While the card waits the Stop button is gone and the send arrow is back, so "Stop gone" is NOT "finished": check for the card. `Reject` disabled the card and the agent answered "I've cancelled that generation..." with no tile made. `waitForAgent` approves only when the quoted cost is <= max_credits and rejects otherwise (verified with max_credits 0: rejected, tiles unchanged, balance unchanged).
- Working indicators: `Stop` button in the panel, "NN%" text on tiles in `main`, "Generating a Single Image"/"Defining the Vision" thinking lines.
- Not seen: a failed tile from the agent (flow-mcp: `flow-error-tile`, Delete only), an out-of-credits message.

### Grid tiles (unchanged structure)

- `flow-grid-tile-container[role=group][aria-label=<title>]` -> `flow-tile-container` -> `flow-image-tile` -> `img[data-media-id=<uuid>]` (src a signed `flow.google.com/asb/...` URL), `flow-image-hotbar`, `flow-tile-hover-footer`. Virtual list inside `.page-container`; newest first.
- A real pointer move over the tile shows `Favorite`, `Reuse prompt`, `More options` (Playwright hover() does not). `More options` menu: Favorite, Reuse prompt, Animate, Add to prompt, Download (aria-haspopup=menu), Copy, Rename, Share, Set project cover, Flag output, Move to trash. Items carry icon words ("download Download"): match with hasText regexes ending in the label. Hovering `Download` opens the submenu `1K Original size`, `2K Upscaled`, `4K Upscaled` (keyboard fallback: focus Download, ArrowRight).
- Downloaded sizes (verified): 1K = 1376x768 JPEG for a 16:9 image (0.5-0.6 MB, ~5 s), 2K = 2752x1536 (2.1 MB, ~12 s). 4K not downloaded (cost unknown, may not be free).
- Clicking a tile opens the edit view `/project/<id>/edit/<media id>`: `Back button to go to previous page`, `Show asset info`, `Previous media`/`Next media`, `Favorite`, `Share media`, `Move to trash`, `Download media`, `Hide history`, `Done editing`, `Button to open image cropping menu`, prompt "What do you want to change?" + `Settings trigger` + `Start generation`, `Save to projects`, `Download`, `Flag output`. Not driven yet (phase 5).
- Characters nav with no characters opens `/project/<id>/character` ("Build and reuse characters"): six template buttons (The Eccentric, The Professional, The Wildcard, The Familiar, The Wicked, The Fantastical), prompt "Describe your character...", `Format` (disabled until text), `Select model family` (Nano Banana 2.1), `Start generation`, `Upload`, `Add from project`, `Go back`. Creating a character was not tried (phase 5). Scenes nav on an empty project: "Start creating or drop media".

### Flow tools (src/flow/*, FMM-02 phase 2)

- `src/flow/driver.ts` page-level driver (overlays, projects, grid scan, tile menu, download, trash), `src/flow/agent.ts` agent panel (settings with restore, sessions, prompt, wait with credit guard, tile matching, `runImages`), `src/flow/queue.ts` Flow job queue (25-70 s pacing; `FLOW_MUSIC_MCP_FLOW_PAUSE_MIN_S/MAX_S`), `src/flow/tools.ts` `buildFlowTools()`.
- Per-site page locks (`withSitePage` in chrome.ts): a Flow job does not block Music tools. Flow assets/download/trash/inspect refuse while a Flow job is running (they would wait minutes); `flow_status` then skips the account panel.
- Verified live 2026-10-22 (0 credits): `flow_status`, `flow_generate` x1 (49 s), `flow_agent_images` 3 scenes (batch-01..03 matched correctly, 64 s), `flow_generate` with variants 2 / 9:16 / Nano Banana 2 Lite, sequential 2-scene `flow_generate` (seq-01, seq-02), `flow_assets`, `flow_download` 1K and 2K, `flow_trash`, settings restore, `music_status`. Not verified: the re-ask rounds for a scene the agent really drops, a failed tile, cancel of a running job, 4K, videos.
