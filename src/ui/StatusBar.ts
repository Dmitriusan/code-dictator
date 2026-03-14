import * as vscode from 'vscode';

export type StatusBarState = 'idle' | 'recording' | 'transcribing';

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
    switch (state) {
      case 'idle':
        this.stopRecordingTimer();
        this.micButton.text = '$(mic) Dictator';
        this.micButton.tooltip = 'Code Dictator: Click to start recording (Alt+V)';
        this.micButton.backgroundColor = undefined;
        this.micButton.show();
        break;

      case 'recording':
        this.recordingStartTime = Date.now();
        this.micButton.text = '$(mic-filled) 0:00';
        this.micButton.tooltip = 'Code Dictator: Click to stop recording (Alt+V)';
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
    }
  }

  updateLanguage(languageCode: string): void {
    if (languageCode) {
      this.languageIndicator.text = `$(globe) ${languageCode.toUpperCase()}`;
      this.languageIndicator.tooltip = `Code Dictator: Language — ${languageCode}. Click to change.`;
    } else {
      this.languageIndicator.text = '$(globe) AUTO';
      this.languageIndicator.tooltip = 'Code Dictator: Auto-detect language. Click to change.';
    }
    this.languageIndicator.show();
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
   */
  showTransientMessage(text: string, durationMs = 3000): void {
    if (this.transientTimer) {
      clearTimeout(this.transientTimer);
    }
    this.micButton.text = text;
    this.micButton.backgroundColor = undefined;
    this.transientTimer = setTimeout(() => {
      this.transientTimer = undefined;
      this.updateState('idle');
    }, durationMs);
  }

  show(): void {
    this.micButton.show();
    this.languageIndicator.show();
  }

  hide(): void {
    this.micButton.hide();
    this.languageIndicator.hide();
    this.costIndicator.hide();
  }

  dispose(): void {
    this.stopRecordingTimer();
    this.micButton.dispose();
    this.languageIndicator.dispose();
    this.costIndicator.dispose();
  }

  private startRecordingTimer(): void {
    this.stopRecordingTimer();
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
