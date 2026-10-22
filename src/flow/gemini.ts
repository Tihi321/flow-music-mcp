// Ported from flow-mcp (github.com/GTAI-1/flow-mcp), gemini.ts
import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { geminiKey } from "./keys.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MUSIC_MCP_FFPROBE ?? "ffprobe";
const MODEL = process.env.FLOW_MUSIC_MCP_GEMINI_TTS ?? "gemini-2.5-flash-preview-tts";

// Gemini's prebuilt voices. Flow draws on the same set, so a narration made here matches one made in Flow.
export const GEMINI_VOICES = [
  { name: "Zephyr", description: "bright" }, { name: "Puck", description: "upbeat" },
  { name: "Charon", description: "informative" }, { name: "Kore", description: "firm" },
  { name: "Fenrir", description: "excitable" }, { name: "Leda", description: "youthful" },
  { name: "Orus", description: "firm" }, { name: "Aoede", description: "breezy" },
  { name: "Callirrhoe", description: "easy-going" }, { name: "Autonoe", description: "bright" },
  { name: "Enceladus", description: "breathy" }, { name: "Iapetus", description: "clear" },
  { name: "Umbriel", description: "easy-going" }, { name: "Algieba", description: "smooth" },
  { name: "Despina", description: "smooth" }, { name: "Erinome", description: "clear" },
  { name: "Algenib", description: "gravelly" }, { name: "Rasalgethi", description: "informative" },
  { name: "Laomedeia", description: "upbeat" }, { name: "Achernar", description: "soft" },
  { name: "Alnilam", description: "firm" }, { name: "Schedar", description: "even" },
  { name: "Gacrux", description: "mature" }, { name: "Pulcherrima", description: "forward" },
  { name: "Achird", description: "friendly" }, { name: "Zubenelgenubi", description: "casual" },
  { name: "Vindemiatrix", description: "gentle" }, { name: "Sadachbia", description: "lively" },
  { name: "Sadaltager", description: "knowledgeable" }, { name: "Sulafat", description: "warm" },
];

interface TtsPart {
  inlineData?: { mimeType?: string; data?: string };
}

// Speaks a line with Gemini's TTS. Free tier, no Flow credits, no length cap, and the same voices Flow uses.
export async function speakWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number }> {
  const key = geminiKey();
  if (!key) {
    throw new Error(
      `No Gemini key yet.

` +
        `1. Open aistudio.google.com/apikey and click "Create API key".
` +
        `2. Copy the whole key (older keys start with AIza, newer ones with AQ).
` +
        `3. Save it with the flow_set_key tool, or put it in ~/.flow-music-mcp/gemini-key, or set GEMINI_API_KEY. Keys are checked with Google and kept only on this computer.`,
    );
  }
  const prompt = style ? `Say ${style}: ${text}` : text;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  const body = (await res.json()) as { error?: { message?: string }; candidates?: { content?: { parts?: TtsPart[] } }[] };
  if (res.status === 429) {
    // Seen live: the 5th quick call in a row on the free tier; a retry a minute later worked.
    throw new Error(`Gemini TTS free tier allows only a few requests per minute: wait about a minute and retry. Google says: ${body.error?.message ?? "no detail"}`);
  }
  if (!res.ok) throw new Error(`Gemini TTS refused this take (${res.status}): ${body.error?.message ?? "no detail"}`);
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio for this line.");

  // The audio comes back as raw signed 16-bit PCM, so the sample rate has to come from the mime type.
  const rate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const raw = target.replace(/\.\w+$/, "") + ".pcm";
  writeFileSync(raw, Buffer.from(part.inlineData.data, "base64"));
  await run(FFMPEG, [
    "-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw,
    "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target,
  ]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  const duration = Number(stdout.trim());
  rmSync(raw, { force: true });
  return { output: target, duration };
}
