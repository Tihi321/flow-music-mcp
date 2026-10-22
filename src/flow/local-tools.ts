import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { HOME_DIR } from "../chrome.js";
import type { Tool } from "../mcp/tools.js";
import { assemble, voiceTrack } from "./assemble.js";
import { burnCaptions, captionedName, captionSetup, prepareSpeech, transcribe } from "./captions.js";
import { GEMINI_VOICES, speakWithGemini } from "./gemini.js";
import { languageNote } from "./language-note.js";
import { keyStatus, setGeminiKey } from "./keys.js";
import { capOf } from "./limits.js";
import { TECHNIQUES } from "./techniques.js";
import { narrateWithFlow } from "./tools.js";
import { speakWithWindows, windowsVoices } from "./voices.js";

// The local (no browser) Flow tools: voices, narration, assembly, captions, technique presets. Shapes and descriptions
// follow flow-mcp (github.com/GTAI-1/flow-mcp, core.ts / index.ts); every path is absolute.

const FLOW_OUT = join(HOME_DIR, "output");
const abs = (what: string) => z.string().min(1).refine(isAbsolute, "must be an absolute path").describe(what);
const absPath = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const outDir = z.string().refine(isAbsolute, "must be an absolute path").optional().describe(`Absolute output folder (default ${FLOW_OUT})`);

const captionFields = {
  video: abs("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z.number().min(-0.5).max(0.5).optional().describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Lowercase only: names to keep capitalised even where they start a sentence (e.g. ["Juno"]). Names in the middle of a sentence are found by themselves.'),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it, always for Croatian/Serbian/Bosnian and other close languages: auto can pick a neighbour (seen: Croatian detected as Ukrainian, in Cyrillic). auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

// narration-001, narration-002 ... so nothing is overwritten.
function nextStem(dir: string, prefix: string): string {
  const used = existsSync(dir) ? readdirSync(dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
}

export function buildLocalFlowTools(): Tool[] {
  const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>): Tool => ({
    name,
    description,
    schema,
    run: run as Tool["run"],
  });

  return [
    def(
      "flow_voices",
      "Narrator voices available for flow_narrate: Google AI Studio's (with whether a key is set up, never the key itself) and the English voices installed on this PC (engine `windows`).",
      z.object({}),
      async () => {
        const key = keyStatus();
        return {
          gemini: GEMINI_VOICES,
          gemini_ready: key.ready,
          gemini_key_source: key.source,
          gemini_key_last4: key.last4,
          windows: await windowsVoices(),
          place: { computer: "this PC", platform: process.platform, local_engine: "Windows voice" },
        };
      },
    ),
    def(
      "flow_narrate",
      "Record narration as an .m4a, free and instantly. `engine: \"gemini\"` uses Google AI Studio's text-to-speech (the same voices Flow has, needs a free key: flow_set_key, ~/.flow-music-mcp/gemini-key or GEMINI_API_KEY; takes a `style` note like 'warmly, like a documentary narrator'; the language follows the text, checked with English, Croatian, German and Spanish; the free tier allows only a few requests per minute, so wait about a minute after a 429); `engine: \"windows\"` uses a voice installed on this PC (System.Speech, no key). `engine: \"flow\"` records a cheap 360p Omni take with a Flow voice attached and extracts its sound (SPENDS CREDITS, about 4-7: ask the user first and pass max_credits; the line is capped by the take length, about 12 words per 4 s). gemini and windows cost nothing and cap nothing. flow_assemble can lay the result over a film.",
      z.object({
        out: outDir,
        name: z.string().optional().describe("File name stem (default narration-001, -002, ...)"),
        engine: z
          .enum(["gemini", "windows", "flow"])
          .default("gemini")
          .describe("'gemini' uses Google AI Studio's text-to-speech: free tier, no length limit, needs a key. 'windows' uses a voice installed on this PC: free, instant, no key. 'flow' makes a paid Flow take (capped by max_credits)."),
        max_credits: z.number().int().min(1).optional().describe("Engine flow only: the live quote of the take must not exceed it. Default: FLOW_MUSIC_MCP_MAX_CREDITS from .env (50 if unset)."),
        project: z.string().optional().describe("Engine flow only: the Flow project (name or id) to make the take in. Default: the project open in the Flow tab."),
        image: z.string().optional().describe("Engine flow only: the picture the voice speaks from (Flow needs one): 'asset:<media_id or title>' or an absolute path. Default: the project's newest image."),
        text: z.string().min(1).max(400).describe("The line to speak. About 20 words fits 8 s, 30 words fits 12 s; anything longer needs a longer take."),
        voice: z.string().min(1).default("Charon").describe("Voice name from flow_voices, e.g. Charon (informative), Aoede (breezy), Gacrux (mature) for Google; Microsoft Zira Desktop or Microsoft David Desktop for Windows (the default Charon maps to Zira there)."),
        style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly, like a documentary narrator'."),
      }),
      async (a) => {
        const output_dir = a.out ?? FLOW_OUT;
        mkdirSync(output_dir, { recursive: true });
        const stem = (a.name ?? "").replace(/[^\w.-]+/g, "_") || nextStem(output_dir, "narration");
        if (a.engine === "flow") {
          const voice = a.voice === "Charon" || !a.voice ? "Charon" : a.voice;
          return narrateWithFlow({ text: a.text, voice, out: output_dir, name: stem, max_credits: capOf(a.max_credits), project: a.project, image: a.image });
        }
        const target = join(output_dir, `${stem}.m4a`);
        const voice = a.engine === "windows" && a.voice === "Charon" ? "Microsoft Zira Desktop" : a.voice;
        const spoken = a.engine === "windows" ? await speakWithWindows(a.text.trim(), voice, target) : await speakWithGemini(a.text.trim(), voice, target, a.style);
        return { output_dir, credits: 0, engine: a.engine, voice, ...spoken };
      },
    ),
    def(
      "flow_set_key",
      "Saves a Google AI Studio (Gemini) key to ~/.flow-music-mcp/gemini-key after Google accepts it, for flow_narrate engine gemini. The key is never shown again, only its last 4 characters. Prefer the file or GEMINI_API_KEY if you would rather not paste a key into a chat.",
      z.object({ key: z.string().min(20).describe("The whole key from aistudio.google.com/apikey") }),
      async (a) => setGeminiKey(a.key),
    ),
    def(
      "flow_assemble",
      "Join video clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top; a narration longer than the footage holds the last frame. To use stills, make a clip first (ffmpeg -loop 1 -i still.png -t 5 clip.mp4). Pass `clips` (absolute paths, in play order) or `dir` holding scene-NN.mp4 / clip-NN.mp4 files. The film is saved in `out`.",
      z.object({
        out: outDir,
        dir: z.string().refine(isAbsolute, "must be an absolute path").optional().describe("Absolute folder holding the clips, used when `clips` is not given: every scene-NN.mp4 / clip-NN.mp4 / edit-NN.mp4 in it (the film is then saved there unless `out` is given)."),
        clips: z.array(absPath).optional().describe("Absolute clip paths in play order."),
        music: abs("Absolute path to a music file; looped and trimmed to the film length.").optional(),
        music_volume: z.number().min(0).max(1).default(0.25),
        clip_volume: z.number().min(0).max(1).default(1).describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
        voiceover: abs("Absolute path to a voiceover audio file, starts at 0:00.").optional(),
        voice_lines: z
          .array(
            z.object({
              file: abs("Take to cut the line from: audio or video (its sound is used)."),
              from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
              to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
              at: z.number().min(0).describe("Where the line starts in the film, seconds."),
              max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
            }),
          )
          .max(60)
          .optional()
          .describe("A timed voiceover built from separate lines, each placed at its own moment in the film. Replaces `voiceover`."),
        output_name: z.string().default("final"),
        hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
      }),
      async ({ out, dir, voice_lines, ...rest }) => {
        const folder = out ?? (rest.clips?.length ? FLOW_OUT : (dir ?? FLOW_OUT));
        const scan = { ...rest, dir: folder };
        // With a separate `dir` and an `out`, the clips are read from `dir` and the film goes to `out`.
        if (!rest.clips?.length && dir && out) scan.clips = (await listClips(dir)).slice();
        if (!voice_lines?.length) return assemble(scan);
        mkdirSync(folder, { recursive: true });
        const track = await voiceTrack(voice_lines, join(folder, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
        const film = await assemble({ ...scan, voiceover: track.file });
        return { ...film, voice: track };
      },
    ),
    def(
      "flow_transcribe",
      "Transcribe a video or audio file on this computer with every word's start and end time (whisper.cpp, local and free, about 100 languages; pass `language` when you know it). The first call installs whisper.cpp (about 15 MB, from its GitHub releases) into ~/.flow-music-mcp/whisper, and downloads a speech model once: 148 MB for English, 574 MB for any other language (flow_speech_setup does this up front). Use the times to check a take said the right words and to cut lines out of it for flow_assemble's voice_lines.",
      z.object({
        video: abs("Absolute path of a video or audio file on this computer."),
        language: z.string().default("auto").describe("Spoken language code (en, es, hr, tr, ja...) or auto. Pass it whenever you know it, always for Croatian/Serbian/Bosnian and other close languages: auto can pick a neighbour (seen: Croatian detected as Ukrainian, in Cyrillic)."),
        words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
      }),
      async (a) => {
        const t = await transcribe(a.video, a.language);
        return {
          text: t.text,
          word_count: t.words.length,
          language: t.language,
          model: t.model,
          ...(languageNote(a.language, t.language) ? { note: languageNote(a.language, t.language) } : {}),
          ...(a.words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
        };
      },
    ),
    def(
      "flow_captions",
      "Burn spoken-word captions into a video, in the style short-form apps use, for landscape or vertical footage (local and free: whisper.cpp hears the words on this computer, nothing is uploaded; whisper.cpp installs itself on first use). Styles: bold (big capitals, the spoken word lights up), highlight, reveal, clean, boxed. Works in about 100 languages, including ones written without spaces (Japanese, Chinese, Thai) and right to left (Arabic, Hebrew); pass `language` (en, es, tr, ja...) whenever you know it. The first call downloads a speech model once: 148 MB for English, 574 MB for other languages. Saves <name>-captions.mp4 plus an .srt. Before calling this, call flow_transcribe, show the user the words with any likely mishearings fixed, and get their OK: then pass the agreed words as `text` (matching words keep their timing), so the video is made once, right.",
      z.object({ ...captionFields, out: z.string().refine(isAbsolute, "must be an absolute path").optional().describe("Absolute folder to save into (default: the video's own folder)") }),
      async ({ out, ...a }) => {
        // whisper.cpp and the speech model install themselves on first use (inside transcribe).
        const dir = out ?? dirname(a.video);
        mkdirSync(dir, { recursive: true });
        return burnCaptions(a.video, a, captionedName(dir, a.video));
      },
    ),
    def(
      "flow_speech_setup",
      "Status of the speech tools behind flow_transcribe and flow_captions: whisper.cpp (this tool's own copy in ~/.flow-music-mcp/whisper, or FLOW_MUSIC_MCP_WHISPER) and the speech models in ~/.flow-music-mcp/models, with download sizes. install: true installs whisper.cpp and the English model now instead of on first use; all_languages: true also fetches the language detector and the 574 MB model for other languages.",
      z.object({
        install: z.boolean().default(false).describe("Install what is missing now (downloads)."),
        all_languages: z.boolean().default(false).describe("With install: also the other-languages model (574 MB) and the language detector (60 MB)."),
      }),
      async (a) => (a.install ? prepareSpeech(a.all_languages) : captionSetup()),
    ),
    def(
      "flow_techniques",
      "List ready-made prompt phrases for camera moves, product shots, first-to-last-frame transitions and image commands. Use the phrase in a scene prompt for flow_generate.",
      z.object({ category: z.enum(["camera", "product", "transition", "image"]).optional() }),
      async (a) => ({ techniques: TECHNIQUES.filter((t) => !a.category || t.category === a.category) }),
    ),
  ];
}

// The numbered clips of a folder, in order (same naming as flow_assemble's default scan).
async function listClips(dir: string): Promise<string[]> {
  if (!existsSync(dir)) throw new Error(`There is no folder ${dir}.`);
  return readdirSync(dir)
    .filter((f) => /^(scene|clip|edit)-\d+(-v\d+)?\.mp4$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
}
