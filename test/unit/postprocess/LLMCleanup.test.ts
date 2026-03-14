import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '../../../src/postprocess/LLMCleanup';

describe('LLMCleanup.cleanup()', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty text for empty input', async () => {
    const result = await cleanup('', 'sk-test-key');
    expect(result).toBe('');
  });

  it('returns whitespace-only text unchanged', async () => {
    const result = await cleanup('   ', 'sk-test-key');
    expect(result).toBe('   ');
  });

  it('returns original text when API key is empty', async () => {
    const result = await cleanup('um hello like world', '');
    expect(result).toBe('um hello like world');
  });

  it('calls OpenAI API and returns cleaned text on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello world' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('um hello like world', 'sk-test-key');
    expect(result).toBe('Hello world');
  });

  it('verifies correct API call structure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned text' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test text', 'sk-test-key', 'gpt-4.1-mini');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer sk-test-key');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.model).toBe('gpt-4.1-mini');
    expect(body.temperature).toBe(0.1);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('test text');
  });

  it('uses default model when none specified', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test', 'sk-test-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4.1-nano');
  });

  it('returns original text on API error (non-ok response)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('um hello', 'sk-test-key');
    expect(result).toBe('um hello');
  });

  it('returns original text on API 401 error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('test text', 'sk-bad-key');
    expect(result).toBe('test text');
  });

  it('returns original text on network error (does not throw)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    globalThis.fetch = mockFetch;

    const result = await cleanup('hello world', 'sk-test-key');
    expect(result).toBe('hello world');
  });

  it('returns original text when response has no choices', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('test', 'sk-test-key');
    expect(result).toBe('test');
  });

  it('returns original text when message content is empty', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('test', 'sk-test-key');
    expect(result).toBe('test');
  });

  it('trims whitespace from cleaned text', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '  cleaned text  ' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('test', 'sk-test-key');
    expect(result).toBe('cleaned text');
  });

  it('sets max_tokens proportional to input length', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'result' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('a'.repeat(200), 'sk-test-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(400); // 200 * 2
  });

  it('sets minimum max_tokens of 256 for short input', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hi' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('hi', 'sk-test-key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(256); // Math.max(2*2, 256) = 256
  });
});
