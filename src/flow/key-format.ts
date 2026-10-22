// Gemini key format checks, apart from keys.ts so they load without .env.

// Template text, not a key.
const placeholder = (key: string): boolean => /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key);

// A key is one unbroken run of characters (AI Studio keys start "AIza", newer ones "AQ"). Anything shorter or still
// holding template text is not a key.
export const plausible = (raw: string): string | undefined => {
  const key = raw.trim();
  if (!key || key.length < 20 || placeholder(key)) return undefined;
  return key;
};

// Stricter check for a key typed in: no spaces, only key characters.
export const looksLikeKey = (key: string): boolean => /^[A-Za-z0-9._~+/=-]{20,512}$/.test(key) && !placeholder(key);
