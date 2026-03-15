import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => {
  const createMockConfiguration = (values: Record<string, unknown> = {}) => ({
    get: vi.fn(<T>(key: string, defaultValue?: T): T => {
      return (key in values ? values[key] : defaultValue) as T;
    }),
    update: vi.fn().mockResolvedValue(undefined),
  });

  return {
    default: {
      workspace: {
        getConfiguration: vi.fn(() => createMockConfiguration({
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
        })),
      },
    },
    workspace: {
      getConfiguration: vi.fn(() => createMockConfiguration({
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
      })),
    },
  };
});

import { StorageService } from '../../../src/storage/StorageService';

function createMockContext() {
  const secretStore = new Map<string, string>();
  const globalStateStore = new Map<string, unknown>();

  return {
    secrets: {
      get: vi.fn(async (key: string) => secretStore.get(key)),
      store: vi.fn(async (key: string, value: string) => { secretStore.set(key, value); }),
      delete: vi.fn(async (key: string) => { secretStore.delete(key); }),
      onDidChange: vi.fn(),
    },
    globalState: {
      get: vi.fn(<T>(key: string, defaultValue?: T): T => {
        return (globalStateStore.has(key) ? globalStateStore.get(key) : defaultValue) as T;
      }),
      update: vi.fn(async (key: string, value: unknown) => { globalStateStore.set(key, value); }),
      keys: vi.fn(() => [...globalStateStore.keys()]),
      setKeysForSync: vi.fn(),
    },
    subscriptions: [],
    extensionUri: { fsPath: '/mock' },
    _secretStore: secretStore,
    _globalStateStore: globalStateStore,
  };
}

describe('StorageService', () => {
  let ctx: ReturnType<typeof createMockContext>;
  let storage: StorageService;

  beforeEach(() => {
    ctx = createMockContext();
    storage = new StorageService(ctx as any);
  });

  describe('getSettings()', () => {
    it('returns default settings from configuration', () => {
      const settings = storage.getSettings();
      expect(settings.provider).toBe('elevenlabs');
      expect(settings.recordingMode).toBe('toggle');
      expect(settings.audioIsolation).toBe('basic');
      expect(settings.language).toBe('');
      expect(settings.preferredLanguages).toEqual([]);
      expect(settings.autoCleanup).toBe(false);
      expect(settings.codeAwareMode).toBe(true);
      expect(settings.defaultTarget).toBe('clipboard');
      expect(settings.autoCopyToClipboard).toBe(true);
      expect(settings.showCostIndicator).toBe(true);
      expect(settings.maxRecordingDuration).toBe(300);
      expect(settings.silenceTimeout).toBe(0);
      expect(settings.diagnosticLogging).toBe(false);
    });
  });

  describe('API key management', () => {
    it('stores and retrieves API key', async () => {
      await storage.setApiKey('elevenlabs', 'test-key-123');
      const key = await storage.getApiKey('elevenlabs');
      expect(key).toBe('test-key-123');
    });

    it('returns undefined for unset keys', async () => {
      const key = await storage.getApiKey('openai');
      expect(key).toBeUndefined();
    });

    it('stores keys per provider independently', async () => {
      await storage.setApiKey('elevenlabs', 'el-key');
      await storage.setApiKey('openai', 'oai-key');
      expect(await storage.getApiKey('elevenlabs')).toBe('el-key');
      expect(await storage.getApiKey('openai')).toBe('oai-key');
    });

    it('uses correct key format in secrets store', async () => {
      await storage.setApiKey('elevenlabs', 'key');
      expect(ctx.secrets.store).toHaveBeenCalledWith('codeDictator.elevenlabs.apiKey', 'key');
    });
  });

  describe('History', () => {
    it('starts with empty history', () => {
      expect(storage.getHistory()).toEqual([]);
    });

    it('adds entry to beginning of history', async () => {
      const entry = {
        id: '1', timestamp: '2024-01-01T00:00:00Z', text: 'hello',
        duration: 5000, charCount: 5, provider: 'elevenlabs',
        estimatedCost: 0.001,
      };
      await storage.addToHistory(entry);
      const history = storage.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].text).toBe('hello');
    });

    it('prepends new entries (newest first)', async () => {
      await storage.addToHistory({
        id: '1', timestamp: '2024-01-01T00:00:00Z', text: 'first',
        duration: 1000, charCount: 5, provider: 'test', estimatedCost: 0,
      });
      await storage.addToHistory({
        id: '2', timestamp: '2024-01-01T00:01:00Z', text: 'second',
        duration: 1000, charCount: 6, provider: 'test', estimatedCost: 0,
      });
      const history = storage.getHistory();
      expect(history[0].text).toBe('second');
      expect(history[1].text).toBe('first');
    });

    it('truncates history to 50 entries', async () => {
      for (let i = 0; i < 55; i++) {
        await storage.addToHistory({
          id: `${i}`, timestamp: '2024-01-01T00:00:00Z', text: `entry ${i}`,
          duration: 1000, charCount: 7, provider: 'test', estimatedCost: 0,
        });
      }
      expect(storage.getHistory()).toHaveLength(50);
    });

    it('clears history', async () => {
      await storage.addToHistory({
        id: '1', timestamp: '2024-01-01T00:00:00Z', text: 'test',
        duration: 1000, charCount: 4, provider: 'test', estimatedCost: 0,
      });
      await storage.clearHistory();
      expect(storage.getHistory()).toEqual([]);
    });
  });

  describe('Usage stats', () => {
    it('returns zero stats when nothing stored', () => {
      const stats = storage.getUsageStats();
      expect(stats.totalTranscriptions).toBe(0);
      expect(stats.todayTranscriptions).toBe(0);
      expect(stats.weekTranscriptions).toBe(0);
    });

    it('records and accumulates usage', async () => {
      await storage.recordUsage(5000, 0.001);
      await storage.recordUsage(3000, 0.002);

      const stats = storage.getUsageStats();
      expect(stats.totalTranscriptions).toBe(2);
      expect(stats.totalDurationMs).toBe(8000);
      expect(stats.totalEstimatedCost).toBeCloseTo(0.003);
      expect(stats.todayTranscriptions).toBe(2);
    });

    it('resets daily counters when date changes', async () => {
      // Record usage today
      await storage.recordUsage(5000, 0.001);

      // Simulate date change by modifying the stored date
      ctx._globalStateStore.set('codeDictator.usageDate', '2024-01-01');

      // Record new usage (which triggers a day change)
      await storage.recordUsage(3000, 0.002);

      const stats = storage.getUsageStats();
      // Today should only have the new recording
      expect(stats.todayTranscriptions).toBe(1);
      expect(stats.todayDurationMs).toBe(3000);
      // Total should have both
      expect(stats.totalTranscriptions).toBe(2);
    });
  });

  describe('UI state', () => {
    it('stores and retrieves UI state', async () => {
      await storage.setUiState('lastTab', 'settings');
      expect(storage.getUiState<string>('lastTab')).toBe('settings');
    });

    it('returns undefined for unset UI state', () => {
      expect(storage.getUiState('nonexistent')).toBeUndefined();
    });

    it('uses codeDictator.ui prefix for keys', async () => {
      await storage.setUiState('key', 'value');
      expect(ctx.globalState.update).toHaveBeenCalledWith('codeDictator.ui.key', 'value');
    });
  });
});
