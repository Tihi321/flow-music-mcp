// The default spending cap for one paid Flow call (a video scene, a continuation, a video edit, a Flow-voice take) when
// the caller passes no max_credits. The user sets it in .env as FLOW_MUSIC_MCP_MAX_CREDITS (user, 2026-10-22: videos are
// few, so a generous default is fine). The live quote is still checked against it before anything starts. Images are
// free and keep a cap of 0, so a paid image model would be refused rather than charged.
export const DEFAULT_MAX_CREDITS = 50;

export function defaultMaxCredits(): number {
  // Unset or empty means the default: Number("") would be 0, which silently refuses every video.
  const text = (process.env.FLOW_MUSIC_MCP_MAX_CREDITS ?? "").trim();
  const raw = text === "" ? NaN : Number(text);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MAX_CREDITS;
}

export const capOf = (given: number | undefined): number => (given === undefined ? defaultMaxCredits() : given);
