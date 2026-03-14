import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

export class CustomProvider implements STTProvider {
  readonly name = 'Custom Whisper-Compatible';
  readonly id = 'custom';

  constructor(
    private readonly endpoint: string,
    private readonly getApiKey?: () => Promise<string | undefined>,
  ) {}

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
      `whisper-1\r\n`
    ));

    // language field (optional)
    if (options.language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${options.language}\r\n`
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

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Custom API error (${response.status}): ${errorText}`);
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
