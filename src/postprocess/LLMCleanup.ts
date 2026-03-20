import { LANGUAGES } from '../types';

const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-mini';

// Optional diagnostic logger injected by the extension at startup.
// Keeps this module free of vscode imports so it stays unit-testable.
let logFn: ((source: string, message: string) => void) | undefined;

export function setCleanupLogger(fn: (source: string, message: string) => void): void {
  logFn = fn;
}

/** Unicode script ranges for output language validation. */
const SCRIPT_RANGES: Record<string, RegExp> = {
  uk: /[\u0400-\u04FF]/,   // Cyrillic
  ru: /[\u0400-\u04FF]/,
  bg: /[\u0400-\u04FF]/,
  sr: /[\u0400-\u04FF]/,
  el: /[\u0370-\u03FF]/,   // Greek
  he: /[\u0590-\u05FF]/,   // Hebrew
  ar: /[\u0600-\u06FF]/,   // Arabic
  th: /[\u0E00-\u0E7F]/,   // Thai
  zh: /[\u4E00-\u9FFF]/,   // CJK
  ja: /[\u3040-\u30FF]/,   // Hiragana + Katakana
  ko: /[\uAC00-\uD7AF]/,   // Hangul
  hi: /[\u0900-\u097F]/,   // Devanagari
  bn: /[\u0980-\u09FF]/,   // Bengali
  ta: /[\u0B80-\u0BFF]/,   // Tamil
};

/**
 * Check whether the LLM output preserved the expected script.
 * If the input uses a distinctive script (Cyrillic, CJK, etc.) but
 * the output lost it entirely, the model switched languages.
 */
function hasScriptMismatch(input: string, output: string, detectedLanguage?: string): boolean {
  if (!detectedLanguage) return false;

  const expectedScript = SCRIPT_RANGES[detectedLanguage];
  if (!expectedScript) return false; // Latin-script languages — can't validate by script

  const inputHasScript = expectedScript.test(input);
  const outputHasScript = expectedScript.test(output);

  // Input had the expected script but output lost it entirely
  return inputHasScript && !outputHasScript;
}

function resolveLanguageName(code: string): string | undefined {
  return LANGUAGES.find(l => l.code === code)?.name;
}

function buildSystemPrompt(detectedLanguage?: string, preferredLanguages?: string[]): string {
  const detectedName = detectedLanguage ? resolveLanguageName(detectedLanguage) : undefined;

  // Keep the prompt short and direct — nano models lose focus on long instructions.
  const lines: string[] = [];

  // Build the set of allowed languages: preferred + detected + English fallback
  const langCodes = new Set(preferredLanguages ?? []);
  if (detectedLanguage) {
    langCodes.add(detectedLanguage);
  }
  langCodes.add('en');
  const langNames = [...langCodes]
    .map(code => resolveLanguageName(code))
    .filter(Boolean);

  if (detectedName && langNames.length <= 2) {
    // Only detected + English — keep it simple
    lines.push(`LANGUAGE: ${detectedName}. Your output MUST be in ${detectedName}. Do NOT switch to any other language.`);
  } else if (detectedName) {
    // Detected language + preferred languages — keep detected as primary
    // but allow preferred languages since STT may have misidentified short phrases
    lines.push(`LANGUAGE: ${detectedName}. Your output MUST be in ${detectedName}. Allowed alternatives: ${langNames.join(', ')}. No other languages.`);
  } else if (langNames.length > 0) {
    lines.push(`LANGUAGE: Output MUST be in one of: ${langNames.join(', ')}. No other languages.`);
  }

  lines.push(
    '',
    'Clean up this speech-to-text transcription:',
    '- Remove spurious commas from speech pauses (keep grammatical ones)',
    '- Remove filler words (um, uh, like, you know)',
    '- Fix punctuation and capitalization',
    '- Do NOT rephrase or add words',
    '- KEEP the SAME language — never translate',
    '',
    'Output ONLY the cleaned text.',
  );

  return lines.filter(l => l !== undefined).join('\n');
}

function buildUserMessage(text: string, detectedLanguage?: string): string {
  const detectedName = detectedLanguage ? resolveLanguageName(detectedLanguage) : undefined;
  if (detectedName) {
    return `[${detectedName}] ${text}`;
  }
  return text;
}

/**
 * Clean up transcribed text using an LLM to remove filler words,
 * fix punctuation, and improve readability.
 * Returns the cleaned text, or the original text on failure.
 */
export async function cleanup(
  text: string,
  apiKey: string,
  model?: string,
  preferredLanguages?: string[],
  detectedLanguage?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!text.trim()) {
    return text;
  }

  if (!apiKey) {
    return text;
  }

  const requestModel = model || DEFAULT_MODEL;

  try {
    const systemPrompt = buildSystemPrompt(detectedLanguage, preferredLanguages);
    const userMessage = buildUserMessage(text, detectedLanguage);
    logFn?.('LLMCleanup', `Input: "${userMessage}" | model=${requestModel}, lang=${detectedLanguage ?? 'auto'}`);

    const response = await fetch(OPENAI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: requestModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        max_tokens: Math.max(text.length * 2, 256),
      }),
      signal,
    });

    if (!response.ok) {
      console.warn(
        `Code Dictator: LLM cleanup failed with status ${response.status}`,
      );
      return text;
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const cleaned = data.choices?.[0]?.message?.content?.trim();
    if (!cleaned) {
      logFn?.('LLMCleanup', 'Output: empty response from LLM');
      return text;
    }

    logFn?.('LLMCleanup', `Output: "${cleaned}"`);

    // Safety net: if the model switched scripts (e.g. Cyrillic → Latin),
    // discard the cleanup and return the original text.
    if (hasScriptMismatch(text, cleaned, detectedLanguage)) {
      logFn?.('LLMCleanup', 'Script mismatch detected, discarding result');
      console.warn('Code Dictator: LLM cleanup changed script, discarding result');
      return text;
    }

    return cleaned;
  } catch (error) {
    console.warn('Code Dictator: LLM cleanup failed', error);
    return text;
  }
}
