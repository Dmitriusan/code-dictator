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
      // 60s * $0.0001/s = $0.006
      expect(cost).toBeCloseTo(0.006, 4);
    });

    it('estimates cost for 0 duration', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      expect(provider.estimateCost(0)).toBe(0);
    });

    it('estimates cost for 1 second', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      const cost = provider.estimateCost(1000);
      expect(cost).toBeCloseTo(0.0001, 6);
    });

    it('estimates cost for 1 hour', () => {
      const provider = new OpenAIProvider(async () => 'sk-test');
      const cost = provider.estimateCost(3600000);
      // 3600s * $0.0001/s = $0.36
      expect(cost).toBeCloseTo(0.36, 3);
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

    it('includes language when specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'bonjour' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), { language: 'fr' });

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('name="language"');
      expect(bodyStr).toContain('fr');
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
      expect(bodyStr).not.toContain('name="language"');
    });

    it('includes whisper-1 model in request', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('whisper-1');
    });

    it('requests verbose_json response format for language detection', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyStr = (mockFetch.mock.calls[0][1].body as Buffer).toString();
      expect(bodyStr).toContain('verbose_json');
    });

    it('returns detected language from verbose_json response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'bonjour', language: 'fr', duration: 2.5 }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      expect(result.language).toBe('fr');
      expect(result.duration).toBe(2.5);
    });

    it('uses duration from verbose_json for cost estimation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test', duration: 30 }),
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const result = await provider.transcribe(Buffer.from('audio'), {});

      // 30s * $0.0001/s = $0.003
      expect(result.cost).toBeCloseTo(0.003, 4);
    });

    it('throws with error message on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });
      globalThis.fetch = mockFetch;

      const provider = new OpenAIProvider(async () => 'sk-test-key');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'OpenAI API error (429): Rate limit exceeded'
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
