import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsProvider } from '../../../src/providers/ElevenLabsProvider';

describe('ElevenLabsProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('estimateCost()', () => {
    it('estimates cost for 60 seconds correctly', () => {
      const provider = new ElevenLabsProvider(async () => 'test-key');
      const cost = provider.estimateCost(60000);
      // 60s * $0.000111/s = $0.00666
      expect(cost).toBeCloseTo(0.00666, 4);
    });

    it('estimates cost for 0 duration', () => {
      const provider = new ElevenLabsProvider(async () => 'test-key');
      expect(provider.estimateCost(0)).toBe(0);
    });

    it('estimates cost for 1 hour', () => {
      const provider = new ElevenLabsProvider(async () => 'test-key');
      const cost = provider.estimateCost(3600000);
      // 3600s * $0.000111/s = $0.3996
      expect(cost).toBeCloseTo(0.3996, 3);
    });

    it('estimates cost for 1 second', () => {
      const provider = new ElevenLabsProvider(async () => 'test-key');
      const cost = provider.estimateCost(1000);
      expect(cost).toBeCloseTo(0.000111, 6);
    });
  });

  describe('validateConfig()', () => {
    it('returns false if getApiKey returns undefined', async () => {
      const provider = new ElevenLabsProvider(async () => undefined);
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key is empty string', async () => {
      const provider = new ElevenLabsProvider(async () => '');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key is too short (< 10 chars)', async () => {
      const provider = new ElevenLabsProvider(async () => 'short');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key is exactly 9 characters', async () => {
      const provider = new ElevenLabsProvider(async () => '123456789');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key is whitespace padded but trimmed < 10', async () => {
      const provider = new ElevenLabsProvider(async () => '  short  ');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns true for a valid-looking key (10+ chars)', async () => {
      const provider = new ElevenLabsProvider(async () => 'xi_abcdefghij1234567890');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for a key that is exactly 10 characters', async () => {
      const provider = new ElevenLabsProvider(async () => '1234567890');
      expect(await provider.validateConfig()).toBe(true);
    });
  });

  describe('transcribe()', () => {
    it('throws when no API key is configured', async () => {
      const provider = new ElevenLabsProvider(async () => undefined);
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs API key not configured'
      );
    });

    it('sends correct request to ElevenLabs API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'hello world',
          language_code: 'en',
          language_probability: 0.95,
          words: [
            { start: 0, end: 0.5, text: 'hello' },
            { start: 0.6, end: 1.0, text: 'world' },
          ],
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-api-key-12345');
      const audio = Buffer.from('fake-audio-data');
      const result = await provider.transcribe(audio, {});

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
      expect(options.method).toBe('POST');
      expect(options.headers['xi-api-key']).toBe('test-api-key-12345');
      expect(options.headers['Content-Type']).toContain('multipart/form-data');

      expect(result.text).toBe('hello world');
      expect(result.language).toBe('en');
      expect(result.confidence).toBe(0.95);
    });

    it('includes language_code when language is specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'привіт',
          language_code: 'uk',
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-api-key-12345');
      const audio = Buffer.from('fake-audio-data');
      await provider.transcribe(audio, { language: 'uk' });

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('language_code');
      expect(bodyStr).toContain('uk');
    });

    it('does not include language_code when language is not specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'hello',
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-api-key-12345');
      const audio = Buffer.from('fake-audio-data');
      await provider.transcribe(audio, {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).not.toContain('language_code');
    });

    it('throws user-friendly message on 401 (invalid key)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'bad-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs API key is invalid or expired'
      );
    });

    it('throws quota exceeded message on 401 with quota_exceeded detail', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
          detail: {
            status: 'quota_exceeded',
            message: 'This request exceeds your quota of 10000. You have 12 credits remaining, while 129 credits are required for this request.',
          },
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'valid-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs quota exceeded'
      );
    });

    it('throws user-friendly message on 402 (insufficient credits)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => JSON.stringify({ detail: { message: 'Quota exceeded' } }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs account has insufficient credits'
      );
    });

    it('throws user-friendly message on 429 (rate limit)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs rate limit reached'
      );
    });

    it('throws user-friendly message on 500/503 (service unavailable)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => { throw new Error('stream error'); },
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs service is temporarily unavailable'
      );
    });

    it('includes detail in error for unknown status codes', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 418,
        text: async () => 'I am a teapot',
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'ElevenLabs API error (418): I am a teapot'
      );
    });

    it('throws user-friendly message on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-key-12345678');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'Unable to reach ElevenLabs'
      );
    });

    it('calculates duration from word timestamps', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'hello world',
          words: [
            { start: 0, end: 0.5, text: 'hello' },
            { start: 0.6, end: 1.2, text: 'world' },
          ],
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-api-key-12345');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      expect(result.duration).toBe(1.2);
    });

    it('includes model_id as scribe_v2 in request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new ElevenLabsProvider(async () => 'test-api-key-12345');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('model_id');
      expect(bodyStr).toContain('scribe_v2');
    });
  });
});
