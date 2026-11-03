import type { STTProvider, TranscribeOptions, TranscriptionResult } from '../types';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const COST_PER_SECOND = 0.000111; // $0.40/hour

const DEFAULT_MODEL = 'scribe_v2';

/** ElevenLabs removed scribe_v1 on 2026-07-09; a setting saved with it gets scribe_v2. */
const RETIRED_MODEL = 'scribe_v1';

/**
 * Pauses before resending when ElevenLabs answers 429 "system_busy": its
 * servers are overloaded, the request itself is fine and a retry normally succeeds.
 */
const BUSY_RETRY_DELAYS_MS = [2000, 5000];

/** What each 429 code from ElevenLabs means — only the last is about request frequency. */
const RATE_LIMIT_REASONS: Record<string, string> = {
  system_busy: 'ElevenLabs is overloaded right now',
  concurrent_limit_exceeded: 'ElevenLabs concurrency limit reached',
  too_many_concurrent_requests: 'ElevenLabs concurrency limit reached',
  rate_limit_exceeded: 'ElevenLabs rate limit reached',
};

/**
 * ElevenLabs reports the detected language as an ISO 639-3 code ("ukr"), while
 * filler removal and the AI cleanup's script check know languages by their ISO
 * 639-1 code ("uk"). Scribe v2 languages that have one, with Mandarin and
 * Cantonese as Chinese ("zh"); the others (Filipino "fil", Cebuano "ceb"...)
 * keep their own code.
 */
const ISO_639_1: Record<string, string> = {
  afr: 'af', amh: 'am', ara: 'ar', asm: 'as', aze: 'az', bel: 'be', ben: 'bn', bos: 'bs',
  bul: 'bg', cat: 'ca', ces: 'cs', cmn: 'zh', cym: 'cy', dan: 'da', deu: 'de', ell: 'el',
  eng: 'en', est: 'et', fas: 'fa', fin: 'fi', fra: 'fr', ful: 'ff', gle: 'ga', glg: 'gl',
  guj: 'gu', hau: 'ha', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', hye: 'hy', ibo: 'ig',
  ind: 'id', isl: 'is', ita: 'it', jav: 'jv', jpn: 'ja', kan: 'kn', kat: 'ka', kaz: 'kk',
  khm: 'km', kir: 'ky', kor: 'ko', kur: 'ku', lao: 'lo', lav: 'lv', lin: 'ln', lit: 'lt',
  ltz: 'lb', lug: 'lg', mal: 'ml', mar: 'mr', mkd: 'mk', mlt: 'mt', mon: 'mn', mri: 'mi',
  msa: 'ms', mya: 'my', nep: 'ne', nld: 'nl', nor: 'no', nya: 'ny', oci: 'oc', ori: 'or',
  pan: 'pa', pol: 'pl', por: 'pt', pus: 'ps', ron: 'ro', rus: 'ru', sin: 'si', slk: 'sk',
  slv: 'sl', sna: 'sn', snd: 'sd', som: 'so', spa: 'es', srp: 'sr', swa: 'sw', swe: 'sv',
  tam: 'ta', tel: 'te', tgk: 'tg', tha: 'th', tur: 'tr', ukr: 'uk', urd: 'ur', uzb: 'uz',
  vie: 'vi', wol: 'wo', xho: 'xh', yor: 'yo', yue: 'zh', zho: 'zh', zul: 'zu',
};

/** Resolve after `ms`, or reject right away if the request is cancelled meanwhile. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class ElevenLabsProvider implements STTProvider {
  readonly name: string;
  readonly id = 'elevenlabs';
  private readonly model: string;

  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    model?: string,
  ) {
    this.model = !model || model === RETIRED_MODEL ? DEFAULT_MODEL : model;
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
    for (let attempt = 1; ; attempt++) {
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
      if (response.ok) {
        break;
      }

      const failure = await ElevenLabsProvider.readHttpError(response);
      if (failure.code !== 'system_busy') {
        throw new Error(failure.message);
      }
      const delay = BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) {
        throw new Error(`${failure.message} Tried ${attempt} times.`);
      }
      options.onRetry?.(failure.message, delay);
      await wait(delay, options.signal);
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

    const code = data.language_code?.toLowerCase();

    return {
      text: data.text ?? '',
      language: code && (ISO_639_1[code] ?? code),
      confidence: data.language_probability,
      duration,
      cost,
    };
  }

  estimateCost(durationMs: number): number {
    return (durationMs / 1000) * COST_PER_SECOND;
  }

  /** Read an error response into ElevenLabs' own error code and a user-facing message. */
  private static async readHttpError(response: Response): Promise<{ code: string; message: string }> {
    const body = await response.text().catch(() => '');
    let detail = '';
    let code = '';
    try {
      const json = JSON.parse(body);
      detail = json?.detail?.message || (typeof json?.detail === 'string' ? json.detail : '') || json?.error?.message || '';
      // `code` in current API responses, `status` in older ones
      code = json?.detail?.code || json?.detail?.status || '';
    } catch {
      detail = body.slice(0, 200);
    }
    return { code, message: ElevenLabsProvider.formatHttpError(response.status, code, detail) };
  }

  private static formatHttpError(status: number, code: string, detail: string): string {
    switch (status) {
      case 401:
        if (code === 'quota_exceeded') {
          return `ElevenLabs quota exceeded.${detail ? ' ' + detail : ''} Top up your balance at elevenlabs.io/billing.`;
        }
        return 'ElevenLabs API key is invalid or expired. Use "Code Dictator: Set API Key" to update it.';
      case 402:
        return 'ElevenLabs account has insufficient credits. Top up your balance at elevenlabs.io/billing.';
      case 429: {
        // A 429 covers several different problems, so pass on ElevenLabs' own
        // code and wording instead of always blaming the request rate.
        const reason = RATE_LIMIT_REASONS[code] ?? 'ElevenLabs rate limit reached';
        if (!code) {
          return `${reason}. Please wait a moment and try again.`;
        }
        return `${reason} (${code}).${detail ? ' ' + detail : ''}`;
      }
      case 500:
      case 502:
      case 503:
        return 'ElevenLabs service is temporarily unavailable. Please try again later.';
      default:
        return `ElevenLabs API error (${status})${detail ? ': ' + detail : ''}`;
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
