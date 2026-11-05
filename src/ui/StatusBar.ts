import * as vscode from 'vscode';
import type { UsageView } from './UsageIndicator';

export type StatusBarState = 'idle' | 'initializing' | 'recording' | 'transcribing' | 'cleaning';

export class StatusBar implements vscode.Disposable {
  private readonly micButton: vscode.StatusBarItem;
  private readonly languageIndicator: vscode.StatusBarItem;
  private readonly usageIndicator: vscode.StatusBarItem;
  private recordingStartTime: number | undefined;
  private recordingTimer: ReturnType<typeof setInterval> | undefined;
  private transientTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Mic button — high priority, right-aligned
    this.micButton = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.micButton.command = 'codeDictator.toggleRecording';
    this.micButton.name = 'Code Dictator: Mic';

    // Language indicator — next to mic button
    this.languageIndicator = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.languageIndicator.command = 'codeDictator.selectLanguage';
    this.languageIndicator.name = 'Code Dictator: Language';

    // Speech-to-text usage (ElevenLabs credits, or today's cost) — next to language
    this.usageIndicator = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98,
    );
    this.usageIndicator.command = 'codeDictator.showUsage';
    this.usageIndicator.name = 'Code Dictator: Speech-to-Text Usage';

    // Set initial state
    this.updateState('idle');
  }

  updateState(state: StatusBarState): void {
    // Cancel any pending transient message timer — a state change takes
    // priority. Without this, a leftover timer from showTransientMessage()
    // can fire mid-recording and reset the status bar to idle.
    if (this.transientTimer) {
      clearTimeout(this.transientTimer);
      this.transientTimer = undefined;
    }

    switch (state) {
      case 'idle':
        this.stopRecordingTimer();
        this.micButton.text = '$(mic) Dictator';
        this.micButton.tooltip = 'Code Dictator: Click to start recording (Alt+D)';
        this.micButton.backgroundColor = undefined;
        this.micButton.color = undefined;
        this.micButton.show();
        break;

      case 'initializing':
        this.stopRecordingTimer();
        this.micButton.text = '$(loading~spin) Starting...';
        this.micButton.tooltip = 'Code Dictator: Initializing microphone...';
        this.micButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.micButton.show();
        break;

      case 'recording':
        this.micButton.text = '$(mic-filled) 0:00';
        this.micButton.tooltip = 'Code Dictator: Click to stop recording (Alt+D)';
        this.micButton.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.micButton.show();
        this.startRecordingTimer();
        break;

      case 'transcribing':
        this.stopRecordingTimer();
        this.micButton.text = '$(loading~spin) Transcribing...';
        this.micButton.tooltip = 'Code Dictator: Transcribing audio...';
        this.micButton.backgroundColor = undefined;
        this.micButton.show();
        break;

      case 'cleaning':
        this.stopRecordingTimer();
        this.micButton.text = '$(sparkle) Cleaning up...';
        this.micButton.tooltip = 'Code Dictator: AI cleanup in progress...';
        this.micButton.backgroundColor = undefined;
        this.micButton.show();
        break;
    }
  }

  updateLanguage(languageCode: string): void {
    if (languageCode) {
      this.languageIndicator.text = `$(globe) ${languageCode.toUpperCase()}`;
      this.languageIndicator.tooltip = `Code Dictator: Language — ${languageCode}. Click to change.`;
      this.languageIndicator.show();
    } else {
      this.languageIndicator.hide();
    }
  }

  /** Show the ElevenLabs credits or today's speech-to-text cost; undefined hides the item. */
  updateUsage(view: UsageView | undefined): void {
    if (!view) {
      this.usageIndicator.hide();
      return;
    }
    this.usageIndicator.text = view.text;
    this.usageIndicator.tooltip = new vscode.MarkdownString(view.tooltip, true);
    this.usageIndicator.backgroundColor = view.level
      ? new vscode.ThemeColor(`statusBarItem.${view.level}Background`)
      : undefined;
    this.usageIndicator.show();
  }

  /**
   * Show a brief success message in the mic button, then revert to idle.
   * Non-intrusive — no popup, no modal, just a status bar flash.
   *
   * When `success` is true the button is highlighted for the duration
   * (colored text or solid background, depending on `successFlashBackground` setting;
   * exact colors are theme-dependent).
   * Duration is controlled by the `successFlashDuration` setting.
   */
  showTransientMessage(text: string, durationMs = 3000, success = false): void {
    if (this.transientTimer) {
      clearTimeout(this.transientTimer);
    }

    const config = vscode.workspace.getConfiguration('codeDictator');

    if (success) {
      durationMs = (config.get<number>('feedback.flashDuration') ?? 5) * 1000;
      const useBackground = config.get<boolean>('feedback.flashBackground') ?? false;
      if (useBackground) {
        this.micButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.micButton.color = undefined;
      } else {
        this.micButton.backgroundColor = undefined;
        this.micButton.color = new vscode.ThemeColor('testing.iconPassed');
      }
    } else {
      this.micButton.backgroundColor = undefined;
      this.micButton.color = undefined;
    }

    this.micButton.text = text;
    this.transientTimer = setTimeout(() => {
      this.transientTimer = undefined;
      this.micButton.color = undefined;
      this.micButton.backgroundColor = undefined;
      this.updateState('idle');
    }, durationMs);
  }

  show(): void {
    this.micButton.show();
  }

  hide(): void {
    this.micButton.hide();
    this.languageIndicator.hide();
    this.usageIndicator.hide();
  }

  dispose(): void {
    this.stopRecordingTimer();
    if (this.transientTimer) {
      clearTimeout(this.transientTimer);
      this.transientTimer = undefined;
    }
    this.micButton.dispose();
    this.languageIndicator.dispose();
    this.usageIndicator.dispose();
  }

  private startRecordingTimer(): void {
    this.stopRecordingTimer();
    this.recordingStartTime = Date.now();
    this.recordingTimer = setInterval(() => {
      if (this.recordingStartTime) {
        const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        this.micButton.text = `$(mic-filled) ${timeStr}`;
      }
    }, 500);
  }

  private stopRecordingTimer(): void {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = undefined;
    }
    this.recordingStartTime = undefined;
  }
}
