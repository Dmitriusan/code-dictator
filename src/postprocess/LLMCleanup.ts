import { LANGUAGES } from '../types';

const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-nano';

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

  if (detectedName) {
    lines.push(`LANGUAGE: ${detectedName}. Your output MUST be in ${detectedName}. Do NOT switch to any other language.`);
  } else {
    // Resolve allowed languages for the constraint
    const langCodes = new Set(preferredLanguages ?? []);
    langCodes.add('en');
    const langNames = [...langCodes]
      .map(code => resolveLanguageName(code))
      .filter(Boolean);
    if (langNames.length > 0) {
      lines.push(`LANGUAGE: Output MUST be in one of: ${langNames.join(', ')}. No other languages.`);
    }
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
): Promise<string> {
  if (!text.trim()) {
    return text;
  }

  if (!apiKey) {
    return text;
  }

  const requestModel = model || DEFAULT_MODEL;

  try {
    const response = await fetch(OPENAI_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: requestModel,
        messages: [
          { role: 'system', content: buildSystemPrompt(detectedLanguage, preferredLanguages) },
          { role: 'user', content: buildUserMessage(text, detectedLanguage) },
        ],
        temperature: 0,
        max_tokens: Math.max(text.length * 2, 256),
      }),
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
      return text;
    }

    // Safety net: if the model switched scripts (e.g. Cyrillic → Latin),
    // discard the cleanup and return the original text.
    if (hasScriptMismatch(text, cleaned, detectedLanguage)) {
      console.warn('Code Dictator: LLM cleanup changed script, discarding result');
      return text;
    }

    return cleaned;
  } catch (error) {
    console.warn('Code Dictator: LLM cleanup failed', error);
    return text;
  }
}
