import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockShowQuickPick = vi.fn();
const mockSetStatusBarMessage = vi.fn();
const mockConfigUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock('vscode', () => ({
  default: {
    window: {
      showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
      setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        update: mockConfigUpdate,
      })),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    setStatusBarMessage: (...args: unknown[]) => mockSetStatusBarMessage(...args),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      update: mockConfigUpdate,
    })),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
}));

import { showLanguagePicker, showLanguageConfigurator } from '../../../src/ui/LanguagePicker';
import type { CodeDictatorSettings } from '../../../src/types';

function makeSettings(overrides: Partial<CodeDictatorSettings> = {}): CodeDictatorSettings {
  return {
    provider: 'elevenlabs',
    customApiUrl: '',
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
    ...overrides,
  };
}

describe('showLanguagePicker', () => {
  beforeEach(() => {
    mockShowQuickPick.mockReset();
    mockConfigUpdate.mockClear();
  });

  it('returns undefined when user cancels', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const result = await showLanguagePicker(makeSettings());
    expect(result).toBeUndefined();
  });

  it('shows full language list when no preferred languages', async () => {
    mockShowQuickPick.mockResolvedValue({ code: 'en', label: 'English' });
    await showLanguagePicker(makeSettings({ preferredLanguages: [] }));

    const items = mockShowQuickPick.mock.calls[0][0];
    // Full list should have all 37 languages
    expect(items.length).toBeGreaterThan(30);
  });

  it('shows preferred shortlist with separator when preferred are set', async () => {
    mockShowQuickPick.mockResolvedValue({ code: 'en', label: 'English' });
    await showLanguagePicker(makeSettings({ preferredLanguages: ['en', 'uk'] }));

    const items = mockShowQuickPick.mock.calls[0][0];
    // Auto-detect + 2 preferred + separator + "Show all" = 5
    expect(items.length).toBe(5);
  });

  it('updates language setting when language is selected', async () => {
    mockShowQuickPick.mockResolvedValue({ code: 'de', label: 'German' });
    const result = await showLanguagePicker(makeSettings());

    expect(result).toBe('de');
    expect(mockConfigUpdate).toHaveBeenCalledWith('language', 'de', 1); // Global
  });

  it('marks current language as (current)', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    await showLanguagePicker(makeSettings({ language: 'en' }));

    const items = mockShowQuickPick.mock.calls[0][0];
    const english = items.find((i: any) => i.code === 'en');
    expect(english?.description).toBe('(current)');
  });

  it('handles "Show all languages" action from preferred list', async () => {
    // First pick: "Show all"
    mockShowQuickPick
      .mockResolvedValueOnce({ action: 'showAll', label: 'Show all languages...' })
      .mockResolvedValueOnce({ code: 'ja', label: 'Japanese' });

    const result = await showLanguagePicker(makeSettings({ preferredLanguages: ['en'] }));
    expect(result).toBe('ja');
    expect(mockShowQuickPick).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when "Show all" secondary pick is cancelled', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ action: 'showAll', label: 'Show all languages...' })
      .mockResolvedValueOnce(undefined);

    const result = await showLanguagePicker(makeSettings({ preferredLanguages: ['en'] }));
    expect(result).toBeUndefined();
  });

  it('returns selected code for auto-detect (empty string)', async () => {
    mockShowQuickPick.mockResolvedValue({ code: '', label: 'Auto-detect' });
    const result = await showLanguagePicker(makeSettings());
    expect(result).toBe('');
  });
});

describe('showLanguageConfigurator', () => {
  beforeEach(() => {
    mockShowQuickPick.mockReset();
    mockConfigUpdate.mockClear();
    mockSetStatusBarMessage.mockClear();
  });

  it('does nothing when user cancels', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    await showLanguageConfigurator(makeSettings());
    expect(mockConfigUpdate).not.toHaveBeenCalled();
  });

  it('updates preferredLanguages setting on confirm', async () => {
    mockShowQuickPick.mockResolvedValue([
      { code: 'en', label: 'English' },
      { code: 'uk', label: 'Ukrainian' },
    ]);
    await showLanguageConfigurator(makeSettings());
    expect(mockConfigUpdate).toHaveBeenCalledWith('preferredLanguages', ['en', 'uk'], 1);
  });

  it('shows status bar message with selected language names', async () => {
    mockShowQuickPick.mockResolvedValue([
      { code: 'en', label: 'English' },
    ]);
    await showLanguageConfigurator(makeSettings());
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('English'),
      3000,
    );
  });

  it('shows "cleared" message when no languages selected', async () => {
    mockShowQuickPick.mockResolvedValue([]);
    await showLanguageConfigurator(makeSettings());
    expect(mockSetStatusBarMessage).toHaveBeenCalledWith(
      expect.stringContaining('cleared'),
      3000,
    );
  });

  it('pre-selects currently preferred languages', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    await showLanguageConfigurator(makeSettings({ preferredLanguages: ['en', 'de'] }));

    const items = mockShowQuickPick.mock.calls[0][0];
    const en = items.find((i: any) => i.code === 'en');
    const de = items.find((i: any) => i.code === 'de');
    const fr = items.find((i: any) => i.code === 'fr');
    expect(en?.picked).toBe(true);
    expect(de?.picked).toBe(true);
    expect(fr?.picked).toBe(false);
  });

  it('excludes auto-detect from configurator items', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    await showLanguageConfigurator(makeSettings());

    const items = mockShowQuickPick.mock.calls[0][0];
    const autoDetect = items.find((i: any) => i.code === '');
    expect(autoDetect).toBeUndefined();
  });
});
