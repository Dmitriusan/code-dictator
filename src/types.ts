// STT Provider types
export interface TranscribeOptions {
  language?: string;
  format?: string;
  mimeType?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  confidence?: number;
  cost?: number;
}

export interface STTProvider {
  readonly name: string;
  readonly id: string;
  transcribe(audio: Buffer, options: TranscribeOptions): Promise<TranscriptionResult>;
  estimateCost(durationMs: number): number;
  validateConfig(): Promise<boolean>;
}

// Recording types
export type RecordingMode = 'toggle';
export type AudioIsolation = 'off' | 'basic' | 'aggressive';
export type InjectionTarget = 'auto' | 'editor' | 'clipboard';
export type ProviderType = 'elevenlabs' | 'openai' | 'custom';

// Settings
export interface CodeDictatorSettings {
  provider: ProviderType;
  customApiUrl: string;
  recordingMode: RecordingMode;
  audioIsolation: AudioIsolation;
  language: string;
  preferredLanguages: string[];
  autoCleanup: boolean;
  cleanupModel: string;
  codeAwareMode: boolean;
  defaultTarget: InjectionTarget;
  autoCopyToClipboard: boolean;
  showCostIndicator: boolean;
  maxRecordingDuration: number;
  silenceTimeout: number;
}

// History
export interface HistoryEntry {
  id: string;
  timestamp: string;
  text: string;
  duration: number;
  charCount: number;
  provider: string;
  estimatedCost: number;
  language?: string;
}

// Usage
export interface UsageStats {
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

// Webview messages
export type MessageFromWebview =
  | { type: 'ready' }
  | { type: 'audioData'; data: string; mimeType: string; durationMs: number }
  | { type: 'recordingStarted' }
  | { type: 'recordingStopped' }
  | { type: 'recordingError'; message: string }
  | { type: 'silenceDetected' };

export type MessageToWebview =
  | { type: 'startRecording'; isolation: AudioIsolation; silenceTimeout: number; maxDuration: number }
  | { type: 'stopRecording' }
  | { type: 'cancelRecording' }
  | { type: 'ping' };

// Language definitions
export interface Language {
  code: string;
  name: string;
}

export const LANGUAGES: Language[] = [
  { code: '', name: 'Auto-detect' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ru', name: 'Russian' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ms', name: 'Malay' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'ta', name: 'Tamil' },
  { code: 'bn', name: 'Bengali' },
];
