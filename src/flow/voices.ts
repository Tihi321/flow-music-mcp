// Windows local text-to-speech through System.Speech (PowerShell). Adapted from flow-mcp's localVoices/speakLocally
// (github.com/GTAI-1/flow-mcp, assemble.ts), which used macOS `say`; the Windows branch there is what this keeps.
import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { powershell, psQuote } from "./platform.js";
import { type WindowsVoice, formatArgs, formatOf, parseWindowsVoices } from "./voice-pure.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MUSIC_MCP_FFPROBE ?? "ffprobe";

// Every voice this PC has installed (Settings > Time & language > Speech), with its culture (en-US, hr-HR ...) and gender.
export async function windowsVoices(): Promise<WindowsVoice[]> {
  try {
    const out = powershell(
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name + '|' + $_.VoiceInfo.Gender }; $s.Dispose()",
    );
    return parseWindowsVoices(out);
  } catch {
    return [];
  }
}

// Speaks a line with a Windows voice, then levels it with ffmpeg like the other engines. Free and instant, but only as
// good as the installed voice. The extension of `target` decides the format (mp3, wav, ogg, m4a).
export async function speakWithWindows(text: string, voice: string, target: string): Promise<{ output: string; duration: number }> {
  const stem = target.replace(/\.\w+$/, "");
  const raw = `${stem}.raw.wav`;
  // The line goes through a file, never the command line, so quotes or symbols in it cannot break the script.
  const lineFile = `${stem}.line.txt`;
  writeFileSync(lineFile, text, "utf8");
  try {
    powershell(
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${psQuote(voice)}); $s.SetOutputToWaveFile(${psQuote(raw)}); $s.Speak([System.IO.File]::ReadAllText(${psQuote(lineFile)}, [System.Text.Encoding]::UTF8)); $s.Dispose()`,
      300_000,
    );
  } catch (err) {
    const known = (await windowsVoices()).map((v) => v.name).join(", ");
    throw new Error(`Windows speech failed for voice "${voice}" (installed: ${known || "none found"}): ${String((err as Error).message).trim().split("\n")[0]}`);
  } finally {
    rmSync(lineFile, { force: true });
  }
  try {
    await run(FFMPEG, ["-y", "-i", raw, "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", ...formatArgs(formatOf(target)), target]);
  } finally {
    rmSync(raw, { force: true });
  }
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}
