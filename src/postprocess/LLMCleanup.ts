const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4.1-nano';
const SYSTEM_PROMPT =
  'You are a speech-to-text post-processor. Clean up the transcribed text: remove filler words (um, uh, like, you know), fix punctuation, add paragraph breaks. Output ONLY the cleaned text, nothing else.';

/**
 * Clean up transcribed text using an LLM to remove filler words,
 * fix punctuation, and improve readability.
 * Returns the cleaned text, or the original text on failure.
 */
export async function cleanup(
  text: string,
  apiKey: string,
  model?: string,
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
          { role: 'system', content: SYSTEM_PROMPT },
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
