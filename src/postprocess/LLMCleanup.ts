import { LANGUAGES } from '../types';

const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-nano';
const BASE_SYSTEM_PROMPT = `You are a speech-to-text post-processor for developer dictation. Clean up the transcribed text:

1. Remove spurious commas that speech-to-text engines insert at speech pauses. Example: "Check out the, project, folder" → "Check out the project folder". Keep only grammatically correct commas (lists, clauses, "Also, …").
2. Remove any remaining filler words (um, uh, like, you know, basically, sort of).
3. Fix punctuation and capitalization.
4. Do NOT rephrase, summarize, or add words — preserve the speaker's exact meaning and vocabulary.
5. KEEP the text in the SAME language as the input. Never translate to another language.

Output ONLY the cleaned text, nothing else.`;

function buildSystemPrompt(preferredLanguages?: string[]): string {
  if (!preferredLanguages || preferredLanguages.length === 0) {
    return BASE_SYSTEM_PROMPT;
  }

  // Always include English
  const langCodes = new Set(preferredLanguages);
  langCodes.add('en');

  const langNames = [...langCodes]
    .map(code => LANGUAGES.find(l => l.code === code)?.name)
    .filter(Boolean);

  return BASE_SYSTEM_PROMPT + `\n6. The output text MUST be in one of these languages: ${langNames.join(', ')}. Do not produce text in any other language. Code snippets and technical terms are exempt from this rule.`;
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
          { role: 'system', content: buildSystemPrompt(preferredLanguages) },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
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

    return cleaned;
  } catch (error) {
    console.warn('Code Dictator: LLM cleanup failed', error);
    return text;
  }
}
