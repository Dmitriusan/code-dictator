import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const COST_PER_SECOND = 0.000075; // $0.0045/minute

const DEFAULT_MODEL = 'gpt-transcribe';

/**
 * Whisper and the GPT-4o transcription models, which OpenAI shuts down on
 * 2027-02-26 in favour of gpt-transcribe. A setting saved with one of them
 * gets gpt-transcribe instead of failing.
 */
const RETIRED_MODEL = /^(whisper-1$|gpt-4o(-mini)?-transcribe)/;

export class OpenAIProvider implements STTProvider {
  readonly name: string;
  readonly id = 'openai';
  private readonly model: string;

  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    model?: string,
  ) {
    this.model = !model || RETIRED_MODEL.test(model) ? DEFAULT_MODEL : model;
    this.name = `OpenAI ${this.model}`;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured. Use "Code Dictator: Set API Key" to set it.');
    }

    const boundary = `----CodeDictator${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];

    const mimeType = options.mimeType ?? 'audio/webm';
    const extMap: Record<string, string> = { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' };
    const ext = extMap[mimeType] ?? 'webm';

    // file field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="recording.${ext}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    ));
    parts.push(audio);
    parts.push(Buffer.from('\r\n'));

    // model field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${this.model}\r\n`
    ));

    // gpt-transcribe rejects verbose_json; its json reply still carries the
    // detected languages and the billed duration
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    ));

    // languages[] field (optional) — gpt-transcribe takes a list of expected
    // languages in place of the single language field
    if (options.language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="languages[]"\r\n\r\n` +
        `${options.language}\r\n`
      ));
    }

    // prompt field (optional) — context about the recording's vocabulary
    if (options.prompt) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${options.prompt}\r\n`
      ));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error('Unable to reach OpenAI — check your internet connection and try again');
    }

    if (!response.ok) {
      throw new Error(await OpenAIProvider.formatHttpError(response));
    }

    const data = await response.json() as {
      text?: string;
      languages?: Array<{ code?: string }>;
      usage?: { seconds?: number };
    };

    if (data.text === undefined) {
      throw new Error('OpenAI returned an unexpected response format');
    }

    const duration = data.usage?.seconds;
    const durationSec = duration ?? (audio.length / 16000);
    const cost = durationSec * COST_PER_SECOND;

    return {
      text: data.text,
      language: data.languages?.[0]?.code,
      duration,
      cost,
    };
  }

  estimateCost(durationMs: number): number {
    return (durationMs / 1000) * COST_PER_SECOND;
  }

  private static async formatHttpError(response: Response): Promise<string> {
    const body = await response.text().catch(() => '');
    let detail = '';
    try {
      const json = JSON.parse(body);
      detail = json?.error?.message || '';
    } catch {
      detail = body.slice(0, 200);
    }

    switch (response.status) {
      case 401:
        return 'OpenAI API key is invalid or expired. Use "Code Dictator: Set API Key" to update it.';
      case 429:
        return `OpenAI rate limit or quota exceeded. Check your billing at platform.openai.com.${detail ? ' (' + detail + ')' : ''}`;
      case 500:
      case 502:
      case 503:
        return 'OpenAI service is temporarily unavailable. Please try again later.';
      default:
        return `OpenAI API error (${response.status})${detail ? ': ' + detail : ''}`;
    }
  }

  async validateConfig(): Promise<boolean> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return false;
    }
    // OpenAI keys start with sk-
    return apiKey.startsWith('sk-');
  }
}
