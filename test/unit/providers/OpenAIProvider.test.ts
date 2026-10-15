import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../../../src/providers/OpenAIProvider';

describe('OpenAIProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('estimateCost()', () => {
    it('estimates cost for 60 seconds correctly', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      const cost = provider.estimateCost(60000);
      // 60s * $0.000075/s = $0.0045
      expect(cost).toBeCloseTo(0.0045, 4);
    });

    it('estimates cost for 0 duration', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      expect(provider.estimateCost(0)).toBe(0);
    });

    it('estimates cost for 1 second', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      const cost = provider.estimateCost(1000);
      expect(cost).toBeCloseTo(0.000075, 6);
    });

    it('estimates cost for 1 hour', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      const cost = provider.estimateCost(3600000);
      // 3600s * $0.000075/s = $0.27
      expect(cost).toBeCloseTo(0.27, 3);
    });
  });

  describe('validateConfig()', () => {
    it('returns false if no key (undefined)', async () => {
      const provider = new OpenAIProvider(async () => undefined);
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key is empty string', async () => {
      const provider = new OpenAIProvider(async () => '');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false if key does not start with "sk-"', async () => {
      const provider = new OpenAIProvider(async () => 'not-a-valid-key');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false for key starting with "SK-" (case sensitive)', async () => {
      const provider = new OpenAIProvider(async () => 'SK-test123');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns true for "sk-test123"', async () => {
      const provider = new OpenAIProvider(async () => 'sk-test123');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for key with just "sk-" prefix', async () => {
      const provider = new OpenAIProvider(async () => 'sk-');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for a realistic OpenAI key', async () => {
      const provider = new OpenAIProvider(
        async () => 'sk-proj-abc123def456ghi789jkl012mno345'
      );
      expect(await provider.validateConfig()).toBe(true);
    });
  });

  describe('transcribe()', () => {
    it('throws when no API key is configured', async () => {
      const provider = new OpenAIProvider(async () => undefined);
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI API key not configured'
      );
    });

    it('sends correct request to OpenAI API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'hello world' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio-data');
      const result = await provider.transcribe(audio, {});

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer sk-test-key');
      expect(options.headers['Content-Type']).toContain('multipart/form-data');

      expect(result.text).toBe('hello world');
      expect(result.cost).toBeGreaterThan(0);
    });

    it('sends the language as languages[], which gpt-transcribe takes instead of language', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'bonjour' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), { language: 'fr' });

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('name="languages[]"\r\n\r\nfr\r\n');
      expect(bodyStr).not.toContain('name="language"');
    });

    it('does not include language when not specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'hello' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).not.toContain('name="language');
    });

    it('includes prompt when specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'hello' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {
        prompt: 'Transcription of a software developer speaking English and Ukrainian.',
      });

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('name="prompt"');
      expect(bodyStr).toContain('software developer');
    });

    it('does not include prompt when not specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'hello' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).not.toContain('name="prompt"');
    });

    it('uses gpt-transcribe by default', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('name="model"\r\n\r\ngpt-transcribe\r\n');
      expect(provider.name).toBe('OpenAI gpt-transcribe');
    });

    it.each([
      'whisper-1',
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'gpt-4o-mini-transcribe-2025-12-15',
      'gpt-4o-transcribe-diarize',
    ])('sends gpt-transcribe in place of the retired %s', async (retired) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key', retired);
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyStr = (mockFetch.mock.calls[0][1].body as Buffer).toString();
      expect(bodyStr).toContain('name="model"\r\n\r\ngpt-transcribe\r\n');
      expect(bodyStr).not.toContain(retired);
    });

    it('requests the json response format, as gpt-transcribe rejects verbose_json', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyStr = (mockFetch.mock.calls[0][1].body as Buffer).toString();
      expect(bodyStr).toContain('name="response_format"\r\n\r\njson\r\n');
    });

    it('returns the detected language code and the billed duration', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          text: 'bonjour',
          languages: [{ code: 'fr' }],
          usage: { type: 'duration', seconds: 3 },
        }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      expect(result.language).toBe('fr');
      expect(result.duration).toBe(3);
    });

    it('leaves the language unset when none was detected', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'hmm', languages: [] }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      expect(result.language).toBeUndefined();
    });

    it('uses the billed duration for cost estimation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test', usage: { type: 'duration', seconds: 30 } }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      // 30s * $0.000075/s = $0.00225
      expect(result.cost).toBeCloseTo(0.00225, 5);
    });

    it('throws user-friendly message on 401 (invalid key)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI API key is invalid or expired'
      );
    });

    it('throws user-friendly message on 429 (rate limit / quota)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI rate limit or quota exceeded'
      );
    });

    it('throws user-friendly message on 503 (service unavailable)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI service is temporarily unavailable'
      );
    });

    it('throws user-friendly message on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'Unable to reach OpenAI'
      );
    });

    it('throws on unexpected response format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI returned an unexpected response format'
      );
    });
  });
});
