import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const COST_PER_SECOND = 0.0001; // $0.006/minute

export class OpenAIProvider implements STTProvider {
  readonly name = 'OpenAI Whisper';
  readonly id = 'openai';

  constructor(private readonly getApiKey: () => Promise<string | undefined>) {}

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

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { text?: string };

    if (data.text === undefined) {
      throw new Error('OpenAI returned an unexpected response format');
    }

    const durationSec = audio.length / 16000; // rough estimate
    const cost = durationSec * COST_PER_SECOND;

    return {
      text: data.text,
      cost,
    };
  }

  estimateCost(durationMs: number): number {
    return (durationMs / 1000) * COST_PER_SECOND;
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
