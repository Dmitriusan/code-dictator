import * as vscode from 'vscode';
import type {
  CodeDictatorSettings,
  HistoryEntry,
  UsageStats,
  ProviderType,
} from '../types';

const HISTORY_KEY = 'codeDictator.history';
const USAGE_KEY = 'codeDictator.usage';
const USAGE_DATE_KEY = 'codeDictator.usageDate';
const USAGE_WEEK_KEY = 'codeDictator.usageWeekStart';
const MAX_HISTORY = 50;

interface StoredUsage {
  totalTranscriptions: number;
  totalDurationMs: number;
  totalEstimatedCost: number;
  todayTranscriptions: number;
  todayDurationMs: number;
  todayEstimatedCost: number;
  weekTranscriptions: number;
  weekDurationMs: number;
  weekEstimatedCost: number;
}

/** Local-time date string YYYY-MM-DD (not UTC — avoids timezone mismatch). */
function getLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local-time Monday of the current week as YYYY-MM-DD. */
function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class StorageService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSettings(): CodeDictatorSettings {
    const config = vscode.workspace.getConfiguration('codeDictator');
    return {
      provider: config.get<ProviderType>('provider', 'elevenlabs'),
      customApiUrl: config.get<string>('customApiUrl', ''),
      recordingMode: config.get<'toggle' | 'hold'>('recordingMode', 'toggle'),
      audioIsolation: config.get<'off' | 'basic' | 'aggressive'>('audioIsolation', 'basic'),
      language: config.get<string>('language', ''),
      preferredLanguages: config.get<string[]>('preferredLanguages', []),
      autoCleanup: config.get<boolean>('autoCleanup', false),
      cleanupModel: config.get<string>('cleanupModel', 'gpt-4.1-nano'),
      codeAwareMode: config.get<boolean>('codeAwareMode', true),
      defaultTarget: config.get<'clipboard' | 'editor'>('defaultTarget', 'clipboard'),
      autoCopyToClipboard: config.get<boolean>('autoCopyToClipboard', true),
      showCostIndicator: config.get<boolean>('showCostIndicator', true),
      maxRecordingDuration: config.get<number>('maxRecordingDuration', 300),
      silenceTimeout: config.get<number>('silenceTimeout', 0),
      diagnosticLogging: config.get<boolean>('diagnosticLogging', false),
    };
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    return this.context.secrets.get(`codeDictator.${provider}.apiKey`);
  }

  async setApiKey(provider: string, key: string): Promise<void> {
    await this.context.secrets.store(`codeDictator.${provider}.apiKey`, key);
  }

  getHistory(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  async addToHistory(entry: HistoryEntry): Promise<void> {
    const history = this.getHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }
    await this.context.globalState.update(HISTORY_KEY, history);
  }

  async clearHistory(): Promise<void> {
    await this.context.globalState.update(HISTORY_KEY, []);
  }

  getUsageStats(): UsageStats {
    const stored = this.context.globalState.get<StoredUsage>(USAGE_KEY);
    if (!stored) {
      return {
        totalTranscriptions: 0,
        totalDurationMs: 0,
        totalEstimatedCost: 0,
        todayTranscriptions: 0,
        todayDurationMs: 0,
        todayEstimatedCost: 0,
        weekTranscriptions: 0,
        weekDurationMs: 0,
        weekEstimatedCost: 0,
      };
    }

    const today = getLocalDate();
    const weekStart = getWeekStart();
    const storedDate = this.context.globalState.get<string>(USAGE_DATE_KEY, '');
    const storedWeek = this.context.globalState.get<string>(USAGE_WEEK_KEY, '');

    const result: UsageStats = { ...stored };

    // Reset daily counters if the day changed
    if (storedDate !== today) {
      result.todayTranscriptions = 0;
      result.todayDurationMs = 0;
      result.todayEstimatedCost = 0;
    }

    // Reset weekly counters if the week changed
    if (storedWeek !== weekStart) {
      result.weekTranscriptions = 0;
      result.weekDurationMs = 0;
      result.weekEstimatedCost = 0;
    }

    return result;
  }

  async recordUsage(durationMs: number, estimatedCost: number): Promise<void> {
    const today = getLocalDate();
    const weekStart = getWeekStart();
    const storedDate = this.context.globalState.get<string>(USAGE_DATE_KEY, '');
    const storedWeek = this.context.globalState.get<string>(USAGE_WEEK_KEY, '');
    const stats = this.getUsageStats();

    // If the stored date or week changed, getUsageStats already zeroed the counters
    stats.totalTranscriptions += 1;
    stats.totalDurationMs += durationMs;
    stats.totalEstimatedCost += estimatedCost;

    if (storedDate === today) {
      stats.todayTranscriptions += 1;
      stats.todayDurationMs += durationMs;
      stats.todayEstimatedCost += estimatedCost;
    } else {
      stats.todayTranscriptions = 1;
      stats.todayDurationMs = durationMs;
      stats.todayEstimatedCost = estimatedCost;
    }

    if (storedWeek === weekStart) {
      stats.weekTranscriptions += 1;
      stats.weekDurationMs += durationMs;
      stats.weekEstimatedCost += estimatedCost;
    } else {
      stats.weekTranscriptions = 1;
      stats.weekDurationMs = durationMs;
      stats.weekEstimatedCost = estimatedCost;
    }

    await this.context.globalState.update(USAGE_KEY, stats);
    await this.context.globalState.update(USAGE_DATE_KEY, today);
    await this.context.globalState.update(USAGE_WEEK_KEY, weekStart);
  }

  getUiState<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(`codeDictator.ui.${key}`);
  }

  async setUiState<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(`codeDictator.ui.${key}`, value);
  }
}
