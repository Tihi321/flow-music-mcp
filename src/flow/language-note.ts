// Pure helper (no playwright/env imports) so it can be unit-tested.
// whisper's auto-detection can pick a neighbour of a close language (seen: Croatian heard as Ukrainian, written in Cyrillic).
const CYRILLIC_LANGUAGES = new Set(["uk", "ru", "sr", "bg", "mk", "be"]);

export function languageNote(requested: string, detected: string): string | undefined {
  if (requested !== "auto" || !CYRILLIC_LANGUAGES.has(detected)) return undefined;
  return `Auto-detection chose "${detected}" (Cyrillic script). If the speech was in a Latin-script language (for example Croatian, Bosnian or Serbian in Latin letters), pass \`language\` (hr, bs, sr...) and run it again.`;
}
