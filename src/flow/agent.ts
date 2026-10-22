import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import {
  clearBackdrops,
  dismissCookieNotice,
  downloadTile,
  ensureProjectGrid,
  flowNotice,
  openProject,
  pause,
  scanNew,
  storedPrompt,
  tileResolver,
  topIds,
  type Tile,
} from "./driver.js";
import { flowTrouble, sceneRound, tileKey, troubleMessage } from "./pure.js";
import type { FlowFile, FlowJob, JobOutcome } from "./queue.js";

// Flow's creative agent (the right-hand session panel, `flow-agent-panel`). Since the redesign of 2026-10-22 everything
// is asked of the agent. Ported from flow-mcp's runAgentBatch: set the agent's settings and always restore them, ask with
// exact prompts, collect the new tiles by media id, match tiles to scenes by the prompt Flow stored for them, ask again for
// what is missing. Selectors: CLAUDE.md, "Flow UI map (2026-10-22)".

export interface AgentSettings {
  confirm: "Always" | "Never";
  imageAspect: string;
  imageCount: number;
  imageModel: string;
  videoAspect: string;
  videoCount: number;
  videoModel: string;
}

const panel = (page: Page): Locator => page.locator("flow-agent-panel");
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Menu and button texts carry an emoji and icon words ("🍌 Nano Banana 2.1 arrow_drop_down").
const clean = (t: string) => t.replace(/\s+/g, " ").replace(/\barrow_drop_(down|up)\b/g, "").replace(/^[^A-Za-z0-9]+/, "").trim();

// ---- Panel state ----

// The panel shows one view at a time: chat, Agent settings, Agent instructions or Session history. Back (and Done in the
// instructions view) lead back to the chat. Escape does not.
export async function toChat(page: Page): Promise<boolean> {
  const p = panel(page);
  for (let i = 0; i < 6; i++) {
    if (await p.getByRole("button", { name: "Start new session" }).isVisible().catch(() => false)) return true;
    const done = p.getByRole("button", { name: "Done", exact: true });
    const back = p.getByRole("button", { name: "Back", exact: true });
    if (await done.isVisible().catch(() => false)) await done.click({ timeout: 4000 }).catch(() => {});
    else if (await back.isVisible().catch(() => false)) await back.click({ timeout: 4000 }).catch(() => {});
    else break;
    await pause(page, 700);
  }
  return p.getByRole("button", { name: "Start new session" }).isVisible().catch(() => false);
}

// The panel is open on a fresh page load. Closed (the user pressed Close), Flow shows its older bottom composer with an
// `Agent` pill and an `Expand` button; Agent on + Expand brings the panel back.
export async function ensureAgentPanel(page: Page): Promise<void> {
  await dismissCookieNotice(page);
  await clearBackdrops(page);
  if (await panel(page).isVisible().catch(() => false)) {
    if (await toChat(page)) return;
  }
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if (await agent.isVisible().catch(() => false)) {
    if ((await agent.getAttribute("aria-pressed")) !== "true") {
      await agent.click({ timeout: 4000 });
      await pause(page, 800);
    }
    const expand = page.getByRole("button", { name: "Expand", exact: true });
    if (await expand.isVisible().catch(() => false)) await expand.click({ timeout: 4000 });
  }
  if (!(await panel(page).getByRole("button", { name: "Start new session" }).waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
    throw new Error("Flow's agent panel did not open (no `Start new session` button). Run flow_inspect to see the page.");
  }
}

async function clearPrompt(page: Page): Promise<void> {
  const clear = panel(page).getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click({ timeout: 3000 }).catch(() => {});
}

// A new session per request: no memory of earlier asks, and the project's history stays one session per run.
export async function newSession(page: Page): Promise<void> {
  await ensureAgentPanel(page);
  await panel(page).getByRole("button", { name: "Start new session" }).click({ timeout: 5000 });
  await pause(page, 1000);
  await clearPrompt(page);
}

// ---- Agent settings ----

// The newest Nano Banana (highest version number that is not Lite), read from Flow's own menu so a later 2.2 or 3 is picked
// without a code change (flow-mcp, 2026-10-13).
export function newestNanoBanana(names: string[]): number {
  const version = (n: string) => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(n)?.[1]?.split(".").map(Number);
  let best = -1;
  names.forEach((n, i) => {
    const v = version(n);
    if (!v || /\blite\b/i.test(n)) return;
    const b = best < 0 ? undefined : version(names[best]!)!;
    const newer = !b || v.some((x, k) => x !== (b[k] ?? 0) && v.slice(0, k).every((y, j) => y === (b[j] ?? 0)) && x > (b[k] ?? 0));
    if (newer) best = i;
  });
  return best;
}

async function openSettings(page: Page): Promise<void> {
  await ensureAgentPanel(page);
  await clearBackdrops(page);
  await panel(page).getByRole("button", { name: "Settings", exact: true }).click({ timeout: 6000 });
  await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
}

async function readSettings(page: Page): Promise<AgentSettings> {
  const raw = await page.evaluate(() => {
    const p = document.querySelector("flow-agent-panel")!;
    const confirm = [...p.querySelectorAll("input[type=radio]")].map((i) => ({
      label: ((i.closest("label") as HTMLElement | null)?.innerText ?? "").trim(),
      checked: (i as HTMLInputElement).checked,
    }));
    const radios = [...p.querySelectorAll('[role="radio"]')].map((e) => ({
      text: (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      checked: e.getAttribute("aria-checked") === "true",
    }));
    const model = (label: string) => (p.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null)?.innerText.replace(/\s+/g, " ").trim() ?? "";
    return { confirm, radios, imageModel: model("Image generation default model"), videoModel: model("Video generation default model") };
  });
  // Radios come as: image aspects, image counts, video aspects, video counts.
  const groups: { type: "aspect" | "count"; items: { text: string; checked: boolean }[] }[] = [];
  for (const r of raw.radios) {
    const type = r.text.includes(":") ? "aspect" : "count";
    if (groups.at(-1)?.type === type) groups.at(-1)!.items.push(r);
    else groups.push({ type, items: [r] });
  }
  const checked = (g?: { items: { text: string; checked: boolean }[] }) => g?.items.find((i) => i.checked)?.text.split(" ").at(-1) ?? "";
  const confirm = /^never/i.test(raw.confirm.find((c) => c.checked)?.label ?? "") ? "Never" : "Always";
  return {
    confirm,
    imageAspect: checked(groups[0]),
    imageCount: Number(checked(groups[1]).replace(/\D/g, "")) || 1,
    imageModel: clean(raw.imageModel),
    videoAspect: checked(groups[2]),
    videoCount: Number(checked(groups[3]).replace(/\D/g, "")) || 1,
    videoModel: clean(raw.videoModel),
  };
}

async function pickModel(page: Page, which: "Image" | "Video", model: string): Promise<boolean> {
  const button = panel(page).getByRole("button", { name: `${which} generation default model` });
  const shown = clean(await button.innerText());
  const latest = model === "latest";
  if (!latest && shown.toLowerCase().includes(model.toLowerCase())) return false;
  await button.click({ timeout: 5000 });
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map(clean);
  const index = latest ? newestNanoBanana(names) : names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  if (index < 0) {
    await page.keyboard.press("Escape");
    await clearBackdrops(page);
    throw new Error(`Flow's ${which.toLowerCase()} model menu has no "${model}". It offers: ${names.join(" | ")}`);
  }
  const same = latest && shown.includes(names[index]!);
  if (same) await page.keyboard.press("Escape");
  else await items.nth(index).click({ timeout: 5000 });
  await pause(page, 500);
  await clearBackdrops(page);
  return !same;
}

// Opens Agent settings, reads them, applies the changes that differ and saves. Returns what the settings were before, for
// restoreSettings. Settings are per project and persist, so a run must always put them back (also on errors).
export async function setAgentSettings(page: Page, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  await openSettings(page);
  try {
    const before = await readSettings(page);
    const p = panel(page);
    let changed = false;
    if (patch.confirm && patch.confirm !== before.confirm) {
      await page.getByRole("radio", { name: new RegExp(`^${patch.confirm}`) }).click({ timeout: 5000 });
      changed = true;
    }
    const pick = async (index: number, kind: "aspect" | "count", want: string | number | undefined, have: string | number) => {
      if (want === undefined || String(want) === String(have)) return;
      const name = kind === "aspect" ? new RegExp(`${escapeRe(String(want))}$`) : new RegExp(`^x${want}$`);
      const radio = p.getByRole("radio", { name }).nth(index);
      if (!(await radio.isVisible().catch(() => false))) throw new Error(`Agent settings have no ${kind} "${want}" for ${index ? "video" : "image"}.`);
      await radio.click({ timeout: 5000 });
      changed = true;
    };
    await pick(0, "aspect", patch.imageAspect, before.imageAspect);
    await pick(0, "count", patch.imageCount, before.imageCount);
    await pick(1, "aspect", patch.videoAspect, before.videoAspect);
    await pick(1, "count", patch.videoCount, before.videoCount);
    if (patch.imageModel && (await pickModel(page, "Image", patch.imageModel))) changed = true;
    if (patch.videoModel && (await pickModel(page, "Video", patch.videoModel))) changed = true;
    if (changed) {
      await pause(page, 300);
      await p.getByRole("button", { name: "Save", exact: true }).click({ timeout: 5000 });
      await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    }
    return before;
  } finally {
    // Saved, or left unchanged: never leave the settings view covering the chat.
    await clearBackdrops(page);
    await toChat(page);
  }
}

// ---- Asking and waiting ----

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = panel(page).locator(".ProseMirror").first();
  await box.click({ timeout: 6000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  // Enter submits in Flow's prompt box, so the prompt goes in as one line.
  await page.keyboard.insertText(text.replace(/\s*\n+\s*/g, " ").trim());
  await pause(page, 700);
  const start = panel(page).getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button stayed disabled: the prompt was not accepted.");
  await start.click({ timeout: 5000 });
}

export interface WaitOptions {
  timeoutMs: number;
  maxCredits: number;
  progress: (note: string) => void;
  cancelled: () => boolean;
}

export interface WaitResult {
  timedOut: boolean;
  refused?: string;
  said: string;
  // Flow's own words when the agent's reply or the page says the request failed (waiting stopped at once).
  trouble?: string;
}

// What the agent last said, without the icon words of the feedback buttons.
async function agentText(page: Page): Promise<string> {
  const text = await panel(page).innerText().catch(() => "");
  return text.replace(/\b(thumb_up|thumb_down|content_copy|flag|check|close|arrow_forward_ios|arrow_forward|add|article_spark|tune|stop|edit_square|menu)\b/g, " ").replace(/\s+/g, " ").trim();
}

// The agent is working while its Stop button shows or a tile in the grid counts up ("NN%"). A paid request makes it stop and
// ask first (card with Approve / Always approve / Reject: "Would you like me to kick off this 1 video generation, costing
// 7 credits?"): that is answered here against max_credits, never approved blindly.
export async function waitForAgent(page: Page, o: WaitOptions): Promise<WaitResult> {
  const p = panel(page);
  const stop = p.getByRole("button", { name: "Stop", exact: true });
  const approve = p.locator('[role="radio"]').filter({ hasText: /^\s*(check\s*)?Approve\s*$/ });
  const reject = p.locator('[role="radio"]').filter({ hasText: /Reject\s*$/ });
  const deadline = Date.now() + o.timeoutMs;
  const started = Date.now();
  let sawWork = false;
  let idleSince = 0;
  let refused: string | undefined;
  for (;;) {
    await pause(page, 2000);
    if (o.cancelled()) {
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 3000 }).catch(() => {});
      return { timedOut: false, refused: "cancelled", said: await agentText(page) };
    }
    const pending = (await approve.first().isVisible().catch(() => false)) && (await approve.first().getAttribute("aria-disabled")) !== "true" && (await approve.first().getAttribute("aria-checked")) !== "true";
    if (pending) {
      const text = await agentText(page);
      const costs = [...text.matchAll(/costing\s+([\d,]+)\s+credits?/gi)];
      const cost = costs.length ? Number(costs.at(-1)![1]!.replace(/,/g, "")) : undefined;
      if (cost !== undefined && cost <= o.maxCredits) {
        o.progress(`approving ${cost} credit(s) (max_credits ${o.maxCredits})`);
        await approve.first().click({ timeout: 4000 });
      } else {
        refused = `The agent asked to spend ${cost === undefined ? "an unknown number of" : cost} credits and max_credits is ${o.maxCredits}, so it was refused. Nothing was generated for that request.`;
        o.progress("refusing a paid request");
        await reject.first().click({ timeout: 4000 });
      }
      sawWork = true;
      idleSince = 0;
      continue;
    }
    const counting = await page.evaluate(() => /\d+%/.test((document.querySelector("main") as HTMLElement | null)?.innerText ?? "")).catch(() => false);
    const working = counting || (await stop.isVisible().catch(() => false));
    if (working) {
      sawWork = true;
      idleSince = 0;
      o.progress(counting ? "Flow is rendering" : "the agent is working");
    } else {
      // The agent's reply says it failed ("Something went wrong") or Flow is overloaded: stop here, not at the timeout.
      const said = await agentText(page);
      const t = flowTrouble(said);
      if (t && t.kind !== "failed") {
        const banner = flowTrouble((await flowNotice(page)).banner);
        return { timedOut: false, refused, said, trouble: troubleMessage(banner ?? t) };
      }
      idleSince ||= Date.now();
      // Done: idle for a few seconds after it worked, or nothing started at all for 25 s (the agent may just have answered).
      if ((sawWork && Date.now() - idleSince > 5000) || (!sawWork && Date.now() - started > 25_000)) return { timedOut: false, refused, said: await agentText(page) };
    }
    if (Date.now() > deadline) {
      // A hung request must not sink the run: stop the agent and keep whatever finished.
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 3000 }).catch(() => {});
      await pause(page, 2000);
      return { timedOut: true, refused, said: await agentText(page) };
    }
  }
}

// ---- Matching tiles to scenes ----

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Ported from flow-mcp (matchScenes). Returns, per scene, the indexes of the tiles that belong to it (best match first). A
// tile counts when at least half of the scene's meaningful words appear in the prompt Flow stored for that tile. Every scene
// first gets its single best tile; leftover tiles go to their best scene as extra takes.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  const sceneWords = scenes.map(words);
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      if (score < 0.5 || usedTiles.has(tile) || (firstPass && out[scene]!.length)) continue;
      out[scene]!.push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

// ---- The image run ----

const pad2 = (n: number) => String(n).padStart(2, "0");
// Bulk downloads at an even pace of about 4-4.4 s each (flow-mcp, 2026-10-19).
const downloadPace = () => 4000 + Math.random() * 400;

function askFor(job: FlowJob, indexes: number[], retry: boolean): string {
  const p = job.params;
  const script = indexes.map((i) => `Scene ${p.numbers[i]}: ${p.scenes[i]!.replace(/\s*\n+\s*/g, " ").trim()}`).join(" ");
  const each = p.variants > 1 ? `${p.variants} separate variations of each scene (${indexes.length * p.variants} images in all)` : `exactly ${indexes.length} separate image${indexes.length > 1 ? "s" : ""}, one per numbered scene, in scene order`;
  const lead = retry ? `Some images from the last request failed. Generate them again now: ${each}` : `Generate ${each}`;
  return `${lead}. Images only, never video. ${p.aspect} aspect ratio. Do not ask questions, generate now, and do not change the wording of any scene. ${script}`;
}

// New tiles of this request, once none of them is still rendering.
async function collectFresh(page: Page, known: Set<string>): Promise<{ tiles: Tile[]; errors: number }> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const r = await scanNew(page, known);
    if (!r.fresh.some((t) => t.busy) || Date.now() > deadline) return { tiles: r.fresh.filter((t) => !t.busy), errors: r.errors };
    await pause(page, 3000);
  }
}

export async function runImages(page: Page, job: FlowJob, hooks: { progress: (s: string) => void; cancelled: () => boolean }): Promise<JobOutcome> {
  const p = job.params;
  const progress = (s: string) => {
    job.progress = s;
    hooks.progress(s);
  };
  progress("opening the project");
  const project = await openProject(page, p.project, p.create_project ?? false);
  job.project = { id: project.id, name: project.name };
  await ensureProjectGrid(page);
  await ensureAgentPanel(page);

  const notes: string[] = [];
  if (project.created) notes.push(`created the project "${project.name}"`);
  const files: FlowFile[] = [];
  const done = new Set<number>();
  let restore: AgentSettings | undefined;
  let timedOut = false;
  let said = "";
  let failedTiles = 0;
  let asked = 0;
  let trouble: string | undefined;
  try {
    progress("setting the agent's image defaults");
    restore = await setAgentSettings(page, { imageAspect: p.aspect, imageCount: p.variants, imageModel: p.model ?? "latest" });
    const known = new Set(await topIds(page));
    let lastProduced: number | undefined;
    for (let round = 0; ; round++) {
      const todo = sceneRound(p.scenes.length, done, round, lastProduced);
      if (!todo.length) break;
      if (round) {
        progress(`asking the agent again for ${todo.length} scene(s)`);
        notes.push(`asked again for ${todo.map((i) => p.numbers[i]).join(", ")}`);
      }
      await newSession(page);
      await sendPrompt(page, askFor(job, todo, round > 0));
      asked++;
      const waited = await waitForAgent(page, {
        timeoutMs: 3 * 60_000 + todo.length * p.variants * 30_000,
        maxCredits: p.max_credits,
        progress,
        cancelled: () => Boolean(job.cancelRequested),
      });
      said = waited.said;
      timedOut ||= waited.timedOut;
      if (waited.refused === "cancelled") throw new Error("cancelled");
      if (waited.refused) throw new Error(waited.refused);
      trouble = waited.trouble ?? trouble;

      progress("collecting the new tiles");
      const fresh = await collectFresh(page, known);
      failedTiles += fresh.errors;
      for (const t of fresh.tiles) known.add(tileKey(t));
      const images = fresh.tiles.filter((t) => t.kind === "image");

      // Tiles finish in any order and the agent may reword, so each is matched to its scene by the prompt Flow stored for it.
      const prompts: string[] = [];
      for (const [k, t] of images.entries()) {
        progress(`matching image ${k + 1} of ${images.length} to its scene`);
        prompts.push(await storedPrompt(page, await tileResolver(page, t.id)()).catch(() => ""));
      }
      const assigned = matchScenes(todo.map((i) => p.scenes[i]!), prompts);
      let produced = 0;
      for (const [n, tileIndexes] of assigned.entries()) {
        const sceneIndex = todo[n]!;
        const number = p.numbers[sceneIndex]!;
        if (!tileIndexes.length) continue;
        let ok = false;
        for (const [v, ti] of tileIndexes.entries()) {
          if (hooks.cancelled()) throw new Error("cancelled");
          const t = images[ti]!;
          const started = Date.now();
          progress(`downloading scene ${number}`);
          try {
            const file = await downloadTile(page, tileResolver(page, t.id), join(p.output_dir, `${p.file_stem}-${pad2(number)}${v ? `-v${v + 1}` : ""}`), p.size);
            files.push({ scene: number, file, media_id: t.id, title: t.title, variant: v + 1 });
            ok = true;
          } catch (err) {
            notes.push(`download of scene ${number} failed: ${(err as Error).message.split("\n")[0]}`);
          }
          await pause(page, Math.max(0, downloadPace() - (Date.now() - started)));
        }
        // Only a real download counts, or a missing scene would be silently skipped and the note would lie.
        if (ok) {
          done.add(sceneIndex);
          produced++;
        }
      }
      if (images.length > prompts.filter(Boolean).length) notes.push(`${images.length - prompts.filter(Boolean).length} new tile(s) had no readable stored prompt`);
      lastProduced = produced;
      // Asking again while Flow says it is failing or overloaded only repeats the failure.
      if (waited.trouble && !produced) break;
    }
  } finally {
    progress("putting the agent settings back");
    if (restore) {
      await setAgentSettings(page, restore).catch((err: Error) => notes.push(`COULD NOT RESTORE the agent settings (${err.message.split("\n")[0]}); previous: ${JSON.stringify(restore)}`));
    }
    await clearPrompt(page).catch(() => {});
  }
  const failed = p.scenes.map((_, i) => i).filter((i) => !done.has(i)).map((i) => p.numbers[i]!);
  files.sort((a, b) => a.scene - b.scene || a.variant - b.variant);
  if (timedOut) notes.push("the agent stalled and was stopped");
  if (trouble) notes.push(trouble);
  if (failedTiles) notes.push(`${failedTiles} tile(s) failed in Flow (nothing charged)`);
  if (!files.length) throw new Error(`${trouble ? `${trouble} ` : ""}No image could be made for any scene (${asked} request(s)). The agent said: ${said.slice(-400) || "nothing"}`);
  return {
    files,
    failed,
    project: job.project,
    note: [failed.length ? `still failed: scene ${failed.join(", ")} (flow_retry)` : "", `${done.size} of ${p.scenes.length} scene(s) delivered`, ...notes].filter(Boolean).join(" · "),
  };
}
