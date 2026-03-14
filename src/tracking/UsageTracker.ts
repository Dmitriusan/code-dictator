import type { StorageService } from '../storage/StorageService';
import type { TranscriptionResult, HistoryEntry, UsageStats } from '../types';

export class UsageTracker {
  constructor(private readonly storage: StorageService) {}

  async record(
    result: TranscriptionResult,
    provider: string,
    durationMs: number,
  ): Promise<void> {
    const estimatedCost = result.cost ?? 0;

    // Add history entry
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      text: result.text,
      duration: durationMs,
      charCount: result.text.length,
      provider,
      estimatedCost,
      language: result.language,
    };
    await this.storage.addToHistory(entry);

    // Update usage stats
    await this.storage.recordUsage(durationMs, estimatedCost);
  }

  getStats(): UsageStats {
    return this.storage.getUsageStats();
  }

  formatCost(cost: number): string {
    if (cost === 0) {
      return 'Free';
    }
    if (cost < 0.01) {
      return `$${cost.toFixed(4)}`;
    }
    return `$${cost.toFixed(2)}`;
  }

  getStatusBarText(): string {
    const stats = this.getStats();
    if (stats.todayEstimatedCost === 0 && stats.todayTranscriptions === 0) {
      return '';
    }
    return `$(credit-card) ${this.formatCost(stats.todayEstimatedCost)}`;
  }

  formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}
