import { describe, it, expect, vi } from 'vitest';
import { UsageTracker } from '../../../src/tracking/UsageTracker';
import type { StorageService } from '../../../src/storage/StorageService';

function createMockStorage(): StorageService {
  return {
    getHistory: vi.fn().mockReturnValue([]),
    addToHistory: vi.fn(),
    clearHistory: vi.fn(),
    getUsageStats: vi.fn().mockReturnValue({
      totalTranscriptions: 0,
      totalDurationMs: 0,
      totalEstimatedCost: 0,
      todayTranscriptions: 0,
      todayDurationMs: 0,
      todayEstimatedCost: 0,
      weekTranscriptions: 0,
      weekDurationMs: 0,
      weekEstimatedCost: 0,
    }),
    recordUsage: vi.fn(),
    getSettings: vi.fn(),
    getApiKey: vi.fn(),
    setApiKey: vi.fn(),
    getUiState: vi.fn(),
    setUiState: vi.fn(),
  } as unknown as StorageService;
}

describe('UsageTracker', () => {
  describe('formatCost()', () => {
    it('returns "Free" for cost of 0', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(0)).toBe('Free');
    });

    it('formats very small costs with 4 decimal places', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(0.001)).toBe('$0.0010');
    });

    it('formats costs under a penny with 4 decimal places', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(0.0099)).toBe('$0.0099');
    });

    it('formats costs at a penny boundary with 2 decimal places', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(0.01)).toBe('$0.01');
    });

    it('formats costs in cents range with 2 decimal places', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(0.12)).toBe('$0.12');
    });

    it('formats dollar amounts with 2 decimal places', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(1.5)).toBe('$1.50');
    });

    it('formats larger amounts', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(10.99)).toBe('$10.99');
    });

    it('formats whole dollar amounts', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatCost(5)).toBe('$5.00');
    });
  });

  describe('formatDuration()', () => {
    it('formats seconds only for durations under a minute', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(5000)).toBe('5s');
    });

    it('formats 0 seconds', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(0)).toBe('0s');
    });

    it('formats exactly one minute', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(60000)).toBe('1m');
    });

    it('formats minutes and seconds', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(65000)).toBe('1m 5s');
    });

    it('formats minutes without remaining seconds', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(120000)).toBe('2m');
    });

    it('formats exactly one hour', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(3600000)).toBe('1h 0m');
    });

    it('formats hours and minutes', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(3661000)).toBe('1h 1m');
    });

    it('formats multiple hours', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(7200000)).toBe('2h 0m');
    });

    it('formats hours with many minutes', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(5400000)).toBe('1h 30m');
    });

    it('truncates sub-second precision', () => {
      const tracker = new UsageTracker(createMockStorage());
      expect(tracker.formatDuration(5500)).toBe('5s');
    });
  });

  describe('record()', () => {
    it('adds a history entry and records usage', async () => {
      const storage = createMockStorage();
      const tracker = new UsageTracker(storage);

      await tracker.record(
        { text: 'hello world', cost: 0.001 },
        'elevenlabs',
        5000,
      );

      expect(storage.addToHistory).toHaveBeenCalledOnce();
      const entry = (storage.addToHistory as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(entry.text).toBe('hello world');
      expect(entry.duration).toBe(5000);
      expect(entry.charCount).toBe(11);
      expect(entry.provider).toBe('elevenlabs');
      expect(entry.estimatedCost).toBe(0.001);

      expect(storage.recordUsage).toHaveBeenCalledWith(5000, 0.001);
    });

    it('defaults cost to 0 when not provided', async () => {
      const storage = createMockStorage();
      const tracker = new UsageTracker(storage);

      await tracker.record({ text: 'test' }, 'custom', 1000);

      expect(storage.recordUsage).toHaveBeenCalledWith(1000, 0);
    });
  });

  describe('getStats()', () => {
    it('delegates to storage.getUsageStats()', () => {
      const storage = createMockStorage();
      const tracker = new UsageTracker(storage);

      const stats = tracker.getStats();

      expect(storage.getUsageStats).toHaveBeenCalledOnce();
      expect(stats.totalTranscriptions).toBe(0);
    });
  });

  describe('getStatusBarText()', () => {
    it('returns empty string when no usage today', () => {
      const storage = createMockStorage();
      const tracker = new UsageTracker(storage);

      expect(tracker.getStatusBarText()).toBe('');
    });

    it('returns cost text when there is today usage', () => {
      const storage = createMockStorage();
      (storage.getUsageStats as ReturnType<typeof vi.fn>).mockReturnValue({
        totalTranscriptions: 5,
        totalDurationMs: 30000,
        totalEstimatedCost: 0.05,
        todayTranscriptions: 2,
        todayDurationMs: 10000,
        todayEstimatedCost: 0.02,
        weekTranscriptions: 5,
        weekDurationMs: 30000,
        weekEstimatedCost: 0.05,
      });
      const tracker = new UsageTracker(storage);

      expect(tracker.getStatusBarText()).toBe('$(credit-card) $0.02');
    });
  });
});
