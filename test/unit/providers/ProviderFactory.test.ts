import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

import { createProvider } from '../../../src/providers/ProviderFactory';
import { ElevenLabsProvider } from '../../../src/providers/ElevenLabsProvider';
import { OpenAIProvider } from '../../../src/providers/OpenAIProvider';
import { CustomProvider } from '../../../src/providers/CustomProvider';
import type { CodeDictatorSettings } from '../../../src/types';

function makeSettings(overrides: Partial<CodeDictatorSettings> = {}): CodeDictatorSettings {
  return {
    provider: 'elevenlabs',
    customApiUrl: '',
    recordingMode: 'toggle',
    audioIsolation: 'basic',
    language: '',
    preferredLanguages: [],
    aiTextCleanup: false,
    cleanupModel: 'gpt-4.1-nano',
    codeAwareMode: true,
    defaultTarget: 'clipboard',
    autoCopyToClipboard: true,
    showCostIndicator: true,
    maxRecordingDuration: 300,
    silenceTimeout: 0,
    diagnosticLogging: false,
    ...overrides,
  };
}

describe('ProviderFactory', () => {
  const getApiKey = vi.fn(async () => 'test-key');

  it('creates ElevenLabsProvider for "elevenlabs"', () => {
    const provider = createProvider(makeSettings({ provider: 'elevenlabs' }), getApiKey);
    expect(provider).toBeInstanceOf(ElevenLabsProvider);
    expect(provider.id).toBe('elevenlabs');
  });

  it('creates OpenAIProvider for "openai"', () => {
    const provider = createProvider(makeSettings({ provider: 'openai' }), getApiKey);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.id).toBe('openai');
  });

  it('creates CustomProvider for "custom"', () => {
    const provider = createProvider(
      makeSettings({ provider: 'custom', customApiUrl: 'http://localhost:8000/api' }),
      getApiKey,
    );
    expect(provider).toBeInstanceOf(CustomProvider);
    expect(provider.id).toBe('custom');
  });

  it('passes customApiUrl to CustomProvider', async () => {
    const provider = createProvider(
      makeSettings({ provider: 'custom', customApiUrl: 'http://my-server:5000/transcribe' }),
      getApiKey,
    );
    // Validate that the URL was passed correctly by checking validateConfig
    expect(await provider.validateConfig()).toBe(true);
  });

  it('passes getApiKey function that calls with correct provider name', async () => {
    const mockGetKey = vi.fn(async (provider: string) => `key-for-${provider}`);

    const elProvider = createProvider(makeSettings({ provider: 'elevenlabs' }), mockGetKey);
    await elProvider.validateConfig();
    expect(mockGetKey).toHaveBeenCalledWith('elevenlabs');

    mockGetKey.mockClear();
    const oaiProvider = createProvider(makeSettings({ provider: 'openai' }), mockGetKey);
    await oaiProvider.validateConfig();
    expect(mockGetKey).toHaveBeenCalledWith('openai');

    mockGetKey.mockClear();
    const customProvider = createProvider(
      makeSettings({ provider: 'custom', customApiUrl: 'http://localhost:8000' }),
      mockGetKey,
    );
    // CustomProvider validates URL, not API key — but we can trigger the key getter via transcribe
    expect(customProvider.id).toBe('custom');
  });
});
