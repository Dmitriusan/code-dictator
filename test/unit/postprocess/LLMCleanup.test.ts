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
    expect(body.temperature).toBe(0);
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
    expect(body.model).toBe('gpt-4.1-mini');
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

  it('includes detected language in system prompt and user message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test', 'sk-test-key', undefined, ['en', 'uk'], 'en');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt = body.messages[0].content;
    const userMessage = body.messages[1].content;
    expect(systemPrompt).toContain('English');
    expect(systemPrompt).toContain('Ukrainian');
    expect(systemPrompt).toContain('ALLOWED LANGUAGES');
    // Detected language is NOT used to force a single language
    expect(systemPrompt).not.toContain('MUST be in English. Do NOT');
    // User message has no language tag prefix — just the text
    expect(userMessage).toBe('test');
  });

  it('allows mixed-language output in prompt', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test', 'sk-test-key', undefined, ['en', 'uk'], 'uk');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt: string = body.messages[0].content;
    expect(systemPrompt).toContain('mix them');
    expect(systemPrompt).toContain('Preserve English technical terms');
  });

  it('puts language constraint before cleanup instructions', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test', 'sk-test-key', undefined, ['en', 'uk'], 'uk');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt: string = body.messages[0].content;
    const langIndex = systemPrompt.indexOf('ALLOWED LANGUAGES:');
    const cleanupIndex = systemPrompt.indexOf('Clean up');
    expect(langIndex).toBeLessThan(cleanupIndex);
  });

  it('includes all preferred languages plus English when no detected language', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'cleaned' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    await cleanup('test', 'sk-test-key', undefined, ['uk']);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt = body.messages[0].content;
    expect(systemPrompt).toContain('English');
    expect(systemPrompt).toContain('Ukrainian');
    expect(body.messages[1].content).toBe('test');
  });

  it('discards result when LLM switches script (Cyrillic → Latin)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        // Input is Ukrainian (Cyrillic), output is Polish (Latin) — script mismatch
        choices: [{ message: { content: 'Okej, zobaczmy jak to dziala' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('Окей, подивимось як це працює', 'sk-test-key', undefined, ['en', 'uk'], 'uk');
    // Should return original text because script changed
    expect(result).toBe('Окей, подивимось як це працює');
  });

  it('accepts result when script is preserved', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Окей, подивимось як це працює.' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('Окей, подивимось як це працює', 'sk-test-key', undefined, ['en', 'uk'], 'uk');
    expect(result).toBe('Окей, подивимось як це працює.');
  });

  it('does not validate script for Latin-script languages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Hello world' } }],
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await cleanup('um hello world', 'sk-test-key', undefined, ['en'], 'en');
    expect(result).toBe('Hello world');
  });
});
