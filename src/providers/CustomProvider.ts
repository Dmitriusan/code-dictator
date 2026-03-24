import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

const DEFAULT_MODEL = 'whisper-1';

export class CustomProvider implements STTProvider {
  readonly name = 'Custom Whisper-Compatible';
  readonly id = 'custom';
  private readonly model: string;

  constructor(
    private readonly endpoint: string,
    private readonly getApiKey?: () => Promise<string | undefined>,
    model?: string,
  ) {
    this.model = model || DEFAULT_MODEL;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult> {
    if (!this.endpoint) {
      throw new Error('Custom API URL not configured. Set codeDictator.customApiUrl in settings.');
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

    // language field (optional)
    if (options.language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${options.language}\r\n`
      ));
    }

    // prompt field (optional) — guides Whisper toward expected vocabulary/style
    if (options.prompt) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${options.prompt}\r\n`
      ));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };

    // Add authorization if an API key is configured
    const apiKey = this.getApiKey ? await this.getApiKey() : undefined;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new Error(`Unable to reach custom API at ${this.endpoint} — check the URL and your network connection`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      switch (response.status) {
        case 401:
        case 403:
          throw new Error('Custom API rejected the request — check your API key and endpoint configuration.');
        case 429:
          throw new Error('Custom API rate limit reached. Please wait and try again.');
        case 500:
        case 502:
        case 503:
          throw new Error('Custom API service is temporarily unavailable. Please try again later.');
        default:
          throw new Error(`Custom API error (${response.status})${errorText ? ': ' + errorText.slice(0, 200) : ''}`);
      }
    }

    const data = await response.json() as { text?: string };

    if (data.text === undefined) {
      throw new Error('Custom API returned an unexpected response format');
    }

    return {
      text: data.text,
      cost: 0,
    };
  }

  estimateCost(_durationMs: number): number {
    return 0; // Local/custom endpoints are assumed free
  }

  async validateConfig(): Promise<boolean> {
    if (!this.endpoint) {
      return false;
    }
    try {
      const url = new URL(this.endpoint);
      // Only allow http and https protocols to prevent file://, ftp://, etc.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
