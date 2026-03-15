import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockShowQuickPick = vi.fn();
const mockShowInputBox = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockOpenExternal = vi.fn().mockResolvedValue(true);
const mockSetStatusBarMessage = vi.fn();
const mockConfigUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock('vscode', () => ({
  default: {
    window: {
      showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
      showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
      showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
      showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
      setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        update: mockConfigUpdate,
        get: vi.fn((key: string, defaultValue?: unknown) => {
          if (key === 'provider') return 'elevenlabs';
          if (key === 'customApiUrl') return 'http://localhost:8000';
          return defaultValue;
        }),
      })),
    },
    env: {
      openExternal: (...args: unknown[]) => mockOpenExternal(...args),
    },
    Uri: {
      parse: vi.fn((s: string) => ({ toString: () => s })),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInputBox: (...args: unknown[]) => mockShowInputBox(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      update: mockConfigUpdate,
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === 'provider') return 'elevenlabs';
        if (key === 'customApiUrl') return 'http://localhost:8000';
        return defaultValue;
      }),
    })),
  },
  env: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  },
  Uri: {
    parse: vi.fn((s: string) => ({ toString: () => s })),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

import { runSetupWizard } from '../../../src/ui/SetupWizard';
import type { StorageService } from '../../../src/storage/StorageService';

function createMockStorage(overrides: Partial<Record<string, unknown>> = {}): StorageService {
  const keys = new Map<string, string>();
  return {
    getHistory: vi.fn(() => []),
    addToHistory: vi.fn(),
    clearHistory: vi.fn(),
    getUsageStats: vi.fn(),
    recordUsage: vi.fn(),
    getSettings: vi.fn(() => ({
      provider: overrides.provider ?? 'elevenlabs',
      customApiUrl: overrides.customApiUrl ?? 'http://localhost:8000',
      recordingMode: 'toggle',
      audioIsolation: 'basic',
      language: '',
      preferredLanguages: [],
      autoCleanup: false,
      cleanupModel: 'gpt-4.1-nano',
      codeAwareMode: true,
      defaultTarget: 'clipboard',
      autoCopyToClipboard: true,
      showCostIndicator: true,
      maxRecordingDuration: 300,
      silenceTimeout: 0,
      diagnosticLogging: false,
    })),
    getApiKey: vi.fn(async (provider: string) => keys.get(provider)),
    setApiKey: vi.fn(async (provider: string, key: string) => { keys.set(provider, key); }),
    getUiState: vi.fn(),
    setUiState: vi.fn(),
  } as unknown as StorageService;
}

describe('SetupWizard', () => {
  let storage: StorageService;

  beforeEach(() => {
    mockShowQuickPick.mockReset();
    mockShowInputBox.mockReset();
    mockShowInformationMessage.mockReset();
    mockShowWarningMessage.mockReset();
    mockOpenExternal.mockClear();
    mockSetStatusBarMessage.mockClear();
    mockConfigUpdate.mockClear();
    storage = createMockStorage();
  });

  it('returns false when user cancels provider selection', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const result = await runSetupWizard(storage);
    expect(result).toBe(false);
  });

  it('updates provider setting when ElevenLabs is selected', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce('xi-test-key-1234567890');

    // Make validateConfig return true for the stored key
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('xi-test-key-1234567890');

    await runSetupWizard(storage);
    expect(mockConfigUpdate).toHaveBeenCalledWith('provider', 'elevenlabs', 1);
  });

  it('returns false when user cancels ElevenLabs info message', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage.mockResolvedValueOnce(undefined); // cancelled

    const result = await runSetupWizard(storage);
    expect(result).toBe(false);
  });

  it('opens browser when "Get API Key" is selected for ElevenLabs', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage
      .mockResolvedValueOnce('Get API Key (opens browser)')
      .mockResolvedValueOnce('Enter Key');
    mockShowInputBox.mockResolvedValueOnce('xi-test-key-1234567890');
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('xi-test-key-1234567890');

    await runSetupWizard(storage);
    expect(mockOpenExternal).toHaveBeenCalledOnce();
  });

  it('stores API key for ElevenLabs', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce('  xi-test-key-1234567890  ');
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('xi-test-key-1234567890');

    await runSetupWizard(storage);
    expect(storage.setApiKey).toHaveBeenCalledWith('elevenlabs', 'xi-test-key-1234567890');
  });

  it('returns false when user cancels API key input', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce(undefined); // cancelled

    const result = await runSetupWizard(storage);
    expect(result).toBe(false);
  });

  it('handles OpenAI provider flow', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'openai', label: 'OpenAI Whisper' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce('sk-test123456');
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('sk-test123456');

    await runSetupWizard(storage);
    expect(mockConfigUpdate).toHaveBeenCalledWith('provider', 'openai', 1);
    expect(storage.setApiKey).toHaveBeenCalledWith('openai', 'sk-test123456');
  });

  it('handles Custom provider flow with URL and no auth', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ providerId: 'custom', label: 'Custom API' })
      .mockResolvedValueOnce({ id: 'no', label: 'No authentication needed' });
    mockShowInputBox.mockResolvedValueOnce('http://localhost:8000/v1/audio/transcriptions');
    storage = createMockStorage({ provider: 'custom', customApiUrl: 'http://localhost:8000/v1/audio/transcriptions' });

    await runSetupWizard(storage);
    expect(mockConfigUpdate).toHaveBeenCalledWith('provider', 'custom', 1);
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'customApiUrl',
      'http://localhost:8000/v1/audio/transcriptions',
      1,
    );
  });

  it('handles Custom provider with API key', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ providerId: 'custom', label: 'Custom API' })
      .mockResolvedValueOnce({ id: 'yes', label: 'Enter API key' });
    mockShowInputBox
      .mockResolvedValueOnce('http://localhost:8000/api')
      .mockResolvedValueOnce('custom-secret-key');
    storage = createMockStorage({ provider: 'custom', customApiUrl: 'http://localhost:8000/api' });

    await runSetupWizard(storage);
    expect(storage.setApiKey).toHaveBeenCalledWith('custom', 'custom-secret-key');
  });

  it('offers retry when validation fails', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'elevenlabs', label: 'ElevenLabs' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce('bad-key-12345');
    // validateConfig will fail because getApiKey returns a bad key
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('bad-key-12345');

    // User chooses "Continue Anyway"
    mockShowWarningMessage.mockResolvedValueOnce('Continue Anyway');

    const result = await runSetupWizard(storage);
    expect(result).toBe(true);
  });

  it('returns false when validation fails and user dismisses retry dialog', async () => {
    mockShowQuickPick.mockResolvedValueOnce({ providerId: 'openai', label: 'OpenAI' });
    mockShowInformationMessage.mockResolvedValueOnce('I already have one');
    mockShowInputBox.mockResolvedValueOnce('bad-key');
    (storage.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue('bad-key');
    mockShowWarningMessage.mockResolvedValueOnce(undefined); // dismissed

    const result = await runSetupWizard(storage);
    expect(result).toBe(false);
  });
});
