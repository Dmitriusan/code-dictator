import * as vscode from 'vscode';

export type StatusBarState = 'idle' | 'recording' | 'transcribing' | 'cleaning';

export class StatusBar implements vscode.Disposable {
  private readonly micButton: vscode.StatusBarItem;
  private readonly languageIndicator: vscode.StatusBarItem;
  private readonly costIndicator: vscode.StatusBarItem;
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

    // Cost indicator — next to language
    this.costIndicator = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      98,
    );
    this.costIndicator.command = 'codeDictator.showUsage';
    this.costIndicator.name = 'Code Dictator: Cost';

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

  updateCost(text: string, showCost: boolean): void {
    if (!showCost || !text) {
      this.costIndicator.hide();
      return;
    }
    this.costIndicator.text = text;
    this.costIndicator.tooltip = 'Code Dictator: Today\'s estimated cost. Click for details.';
    this.costIndicator.show();
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
    this.costIndicator.hide();
  }

  dispose(): void {
    this.stopRecordingTimer();
    if (this.transientTimer) {
      clearTimeout(this.transientTimer);
      this.transientTimer = undefined;
    }
    this.micButton.dispose();
    this.languageIndicator.dispose();
    this.costIndicator.dispose();
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
