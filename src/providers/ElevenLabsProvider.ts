import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const COST_PER_SECOND = 0.000111; // $0.40/hour

const DEFAULT_MODEL = 'scribe_v2';

export class ElevenLabsProvider implements STTProvider {
  readonly name: string;
  readonly id = 'elevenlabs';
  private readonly model: string;

  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    model?: string,
  ) {
    this.model = model || DEFAULT_MODEL;
    this.name = `ElevenLabs ${this.model}`;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured. Use "Code Dictator: Set API Key" to set it.');
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

    // model_id field
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model_id"\r\n\r\n` +
      `${this.model}\r\n`
    ));

    // language_code field (optional)
    if (options.language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language_code"\r\n\r\n` +
        `${options.language}\r\n`
      ));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error('Unable to reach ElevenLabs — check your internet connection and try again');
    }

    if (!response.ok) {
      throw new Error(await ElevenLabsProvider.formatHttpError(response));
    }

    const data = await response.json() as {
      text?: string;
      language_code?: string;
      language_probability?: number;
      words?: Array<{ start: number; end: number; text: string }>;
    };

    if (!data.text && data.text !== '') {
      throw new Error('ElevenLabs returned an unexpected response format');
    }

    // Estimate duration from word timestamps if available
    let duration: number | undefined;
    if (data.words && data.words.length > 0) {
      const lastWord = data.words[data.words.length - 1];
      duration = lastWord.end;
    }

    const durationSec = duration ?? (audio.length / 16000); // rough fallback
    const cost = durationSec * COST_PER_SECOND;

    return {
      text: data.text ?? '',
      language: data.language_code,
      confidence: data.language_probability,
      duration,
      cost,
    };
  }

  estimateCost(durationMs: number): number {
    return (durationMs / 1000) * COST_PER_SECOND;
  }

  private static async formatHttpError(response: Response): string {
    const body = await response.text().catch(() => '');
    let detail = '';
    let detailStatus = '';
    try {
      const json = JSON.parse(body);
      detail = json?.detail?.message || (typeof json?.detail === 'string' ? json.detail : '') || json?.error?.message || '';
      detailStatus = json?.detail?.status || '';
    } catch {
      detail = body.slice(0, 200);
    }

    switch (response.status) {
      case 401:
        if (detailStatus === 'quota_exceeded') {
          return `ElevenLabs quota exceeded.${detail ? ' ' + detail : ''} Top up your balance at elevenlabs.io/billing.`;
        }
        return 'ElevenLabs API key is invalid or expired. Use "Code Dictator: Set API Key" to update it.';
      case 402:
        return 'ElevenLabs account has insufficient credits. Top up your balance at elevenlabs.io/billing.';
      case 429:
        return 'ElevenLabs rate limit reached. Please wait a moment and try again.';
      case 500:
      case 502:
      case 503:
        return 'ElevenLabs service is temporarily unavailable. Please try again later.';
      default:
        return `ElevenLabs API error (${response.status})${detail ? ': ' + detail : ''}`;
    }
  }

  async validateConfig(): Promise<boolean> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return false;
    }
    // ElevenLabs keys don't have a strict prefix format, just check non-empty
    if (apiKey.trim().length < 10) {
      return false;
    }
    return true;
  }
}
