import { describe, it, expect, vi, afterEach } from 'vitest';
import { CustomProvider } from '../../../src/providers/CustomProvider';

describe('CustomProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('estimateCost()', () => {
    it('always returns 0 for any duration', () => {
      const provider = new CustomProvider('http://localhost:8000/v1/audio/transcriptions');
      expect(provider.estimateCost(0)).toBe(0);
      expect(provider.estimateCost(60000)).toBe(0);
      expect(provider.estimateCost(3600000)).toBe(0);
    });

    it('returns 0 even with no endpoint', () => {
      const provider = new CustomProvider('');
      expect(provider.estimateCost(60000)).toBe(0);
    });
  });

  describe('validateConfig()', () => {
    it('returns false for empty URL', async () => {
      const provider = new CustomProvider('');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false for invalid URL (no protocol)', async () => {
      const provider = new CustomProvider('not-a-url');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false for invalid URL (random string)', async () => {
      const provider = new CustomProvider('just some text');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns false for URL with only protocol', async () => {
      // "http://" by itself is invalid according to `new URL()`
      const provider = new CustomProvider('http://');
      expect(await provider.validateConfig()).toBe(false);
    });

    it('returns true for valid HTTP URL', async () => {
      const provider = new CustomProvider('http://localhost:8000/v1/audio/transcriptions');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for valid HTTPS URL', async () => {
      const provider = new CustomProvider('https://my-whisper.example.com/transcribe');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for URL with just a host', async () => {
      const provider = new CustomProvider('http://localhost');
      expect(await provider.validateConfig()).toBe(true);
    });

    it('returns true for URL with IP address and port', async () => {
      const provider = new CustomProvider('http://192.168.1.100:5000/api');
      expect(await provider.validateConfig()).toBe(true);
    });
  });

  describe('transcribe()', () => {
    it('throws when endpoint is empty', async () => {
      const provider = new CustomProvider('');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'Custom API URL not configured'
      );
    });

    it('sends correct request to custom endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'transcribed text' }),
      });
      globalThis.fetch = mockFetch;

      const endpoint = 'http://localhost:8000/v1/audio/transcriptions';
      const provider = new CustomProvider(endpoint);
      const audio = Buffer.from('fake-audio-data');
      const result = await provider.transcribe(audio, {});

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(endpoint);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toContain('multipart/form-data');

      // No Authorization header for custom endpoints
      expect(options.headers['Authorization']).toBeUndefined();

      expect(result.text).toBe('transcribed text');
      expect(result.cost).toBe(0);
    });

    it('includes language when specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new CustomProvider('http://localhost:8000/api');
      await provider.transcribe(Buffer.from('audio'), { language: 'en' });

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('name="language"');
      expect(bodyStr).toContain('en');
    });

    it('throws with error message on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service unavailable',
      });
      globalThis.fetch = mockFetch;

      const provider = new CustomProvider('http://localhost:8000/api');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'Custom API error (503): Service unavailable'
      );
    });

    it('throws on unexpected response format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch;

      const provider = new CustomProvider('http://localhost:8000/api');
      const audio = Buffer.from('fake-audio');

      await expect(provider.transcribe(audio, {})).rejects.toThrow(
        'Custom API returned an unexpected response format'
      );
    });

    it('includes whisper-1 model in request body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'test' }),
      });
      globalThis.fetch = mockFetch;

      const provider = new CustomProvider('http://localhost:8000/api');
      await provider.transcribe(Buffer.from('audio'), {});

      const bodyBuffer = mockFetch.mock.calls[0][1].body as Buffer;
      const bodyStr = bodyBuffer.toString();
      expect(bodyStr).toContain('whisper-1');
    });
  });
});
