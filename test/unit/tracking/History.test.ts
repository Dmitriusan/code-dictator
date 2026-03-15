import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockShowQuickPick = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowWarningMessage = vi.fn();
const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
const mockEdit = vi.fn(async (cb: (b: any) => void) => {
  cb({ insert: vi.fn(), replace: vi.fn() });
  return true;
});

vi.mock('vscode', () => ({
  default: {
    window: {
      showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
      showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
      showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
      activeTextEditor: undefined as unknown,
    },
    env: {
      clipboard: {
        writeText: (...args: unknown[]) => mockClipboardWrite(...args),
      },
    },
    QuickPickItemKind: { Separator: -1, Default: 0 },
  },
  window: {
    showQuickPick: (...args: unknown[]) => mockShowQuickPick(...args),
    showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
    showWarningMessage: (...args: unknown[]) => mockShowWarningMessage(...args),
    get activeTextEditor() { return (vi.mocked as any).__activeTextEditor; },
  },
  env: {
    clipboard: {
      writeText: (...args: unknown[]) => mockClipboardWrite(...args),
    },
  },
  QuickPickItemKind: { Separator: -1, Default: 0 },
}));

import { HistoryManager } from '../../../src/tracking/History';
import type { StorageService } from '../../../src/storage/StorageService';
import type { HistoryEntry } from '../../../src/types';

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: '1',
    timestamp: new Date().toISOString(),
    text: 'test transcription',
    duration: 5000,
    charCount: 18,
    provider: 'elevenlabs',
    estimatedCost: 0.001,
    ...overrides,
  };
}

function createMockStorage(entries: HistoryEntry[] = []): StorageService {
  return {
    getHistory: vi.fn(() => [...entries]),
    addToHistory: vi.fn(),
    clearHistory: vi.fn(),
    getUsageStats: vi.fn(),
    recordUsage: vi.fn(),
    getSettings: vi.fn(),
    getApiKey: vi.fn(),
    setApiKey: vi.fn(),
    getUiState: vi.fn(),
    setUiState: vi.fn(),
  } as unknown as StorageService;
}

describe('HistoryManager', () => {
  let storage: StorageService;
  let manager: HistoryManager;

  beforeEach(() => {
    mockShowQuickPick.mockReset();
    mockShowInformationMessage.mockReset();
    mockShowWarningMessage.mockReset();
    mockClipboardWrite.mockClear();
    (vi.mocked as any).__activeTextEditor = undefined;
  });

  describe('getAll()', () => {
    it('returns all history entries from storage', () => {
      const entries = [makeEntry({ id: '1' }), makeEntry({ id: '2' })];
      storage = createMockStorage(entries);
      manager = new HistoryManager(storage);

      expect(manager.getAll()).toHaveLength(2);
    });

    it('returns empty array when no history', () => {
      storage = createMockStorage();
      manager = new HistoryManager(storage);

      expect(manager.getAll()).toEqual([]);
    });
  });

  describe('search()', () => {
    const entries = [
      makeEntry({ id: '1', text: 'hello world', language: 'en', provider: 'elevenlabs' }),
      makeEntry({ id: '2', text: 'привіт світ', language: 'uk', provider: 'openai' }),
      makeEntry({ id: '3', text: 'code review notes', provider: 'custom' }),
    ];

    beforeEach(() => {
      storage = createMockStorage(entries);
      manager = new HistoryManager(storage);
    });

    it('returns all entries for empty query', () => {
      expect(manager.search('')).toHaveLength(3);
    });

    it('returns all entries for whitespace query', () => {
      expect(manager.search('   ')).toHaveLength(3);
    });

    it('searches by text content', () => {
      const results = manager.search('hello');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('1');
    });

    it('searches by language', () => {
      const results = manager.search('uk');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('2');
    });

    it('searches by provider', () => {
      const results = manager.search('custom');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('3');
    });

    it('search is case-insensitive', () => {
      const results = manager.search('HELLO');
      expect(results).toHaveLength(1);
    });

    it('returns empty for no matches', () => {
      expect(manager.search('nonexistent')).toHaveLength(0);
    });
  });

  describe('clear()', () => {
    it('delegates to storage.clearHistory()', async () => {
      storage = createMockStorage();
      manager = new HistoryManager(storage);

      await manager.clear();
      expect(storage.clearHistory).toHaveBeenCalledOnce();
    });
  });

  describe('showHistoryQuickPick()', () => {
    it('shows info message when history is empty', async () => {
      storage = createMockStorage();
      manager = new HistoryManager(storage);

      await manager.showHistoryQuickPick();
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('No transcription history'),
      );
    });

    it('shows quick pick with entries when history has items', async () => {
      storage = createMockStorage([makeEntry({ text: 'hello world' })]);
      manager = new HistoryManager(storage);
      mockShowQuickPick.mockResolvedValue(undefined); // user cancelled

      await manager.showHistoryQuickPick();
      expect(mockShowQuickPick).toHaveBeenCalledOnce();
      const items = mockShowQuickPick.mock.calls[0][0];
      // First items are entries, then separator, then "Clear History"
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items[0].label).toContain('hello world');
    });

    it('truncates long text in preview to 80 chars', async () => {
      const longText = 'a'.repeat(100);
      storage = createMockStorage([makeEntry({ text: longText })]);
      manager = new HistoryManager(storage);
      mockShowQuickPick.mockResolvedValue(undefined);

      await manager.showHistoryQuickPick();
      const items = mockShowQuickPick.mock.calls[0][0];
      expect(items[0].label.length).toBeLessThanOrEqual(80);
      expect(items[0].label).toContain('...');
    });

    it('copies to clipboard when user selects an entry then "Copy to Clipboard"', async () => {
      const entry = makeEntry({ text: 'copy this' });
      storage = createMockStorage([entry]);
      manager = new HistoryManager(storage);

      // First pick: select the entry
      mockShowQuickPick
        .mockResolvedValueOnce({ entry, label: 'copy this' })
        .mockResolvedValueOnce('Copy to Clipboard');

      await manager.showHistoryQuickPick();
      expect(mockClipboardWrite).toHaveBeenCalledWith('copy this');
    });

    it('clears history when user selects clear and confirms', async () => {
      storage = createMockStorage([makeEntry()]);
      manager = new HistoryManager(storage);

      mockShowQuickPick.mockResolvedValueOnce({ action: 'clear', label: '$(trash) Clear History' });
      mockShowWarningMessage.mockResolvedValueOnce('Clear');

      await manager.showHistoryQuickPick();
      expect(storage.clearHistory).toHaveBeenCalledOnce();
    });

    it('does not clear when user cancels confirmation', async () => {
      storage = createMockStorage([makeEntry()]);
      manager = new HistoryManager(storage);

      mockShowQuickPick.mockResolvedValueOnce({ action: 'clear', label: '$(trash) Clear History' });
      mockShowWarningMessage.mockResolvedValueOnce(undefined); // cancelled

      await manager.showHistoryQuickPick();
      expect(storage.clearHistory).not.toHaveBeenCalled();
    });
  });
});
