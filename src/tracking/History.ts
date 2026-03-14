import * as vscode from 'vscode';
import type { StorageService } from '../storage/StorageService';
import type { HistoryEntry } from '../types';

export class HistoryManager {
  constructor(private readonly storage: StorageService) {}

  getAll(): HistoryEntry[] {
    return this.storage.getHistory();
  }

  search(query: string): HistoryEntry[] {
    if (!query.trim()) {
      return this.getAll();
    }
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter((entry) => {
      return (
        entry.text.toLowerCase().includes(lowerQuery) ||
        (entry.language && entry.language.toLowerCase().includes(lowerQuery)) ||
        entry.provider.toLowerCase().includes(lowerQuery)
      );
    });
  }

  async clear(): Promise<void> {
    await this.storage.clearHistory();
  }

  async showHistoryQuickPick(): Promise<void> {
    const history = this.getAll();

    if (history.length === 0) {
      vscode.window.showInformationMessage('Code Dictator: No transcription history yet.');
      return;
    }

    const items: Array<vscode.QuickPickItem & { entry?: HistoryEntry; action?: string }> = [];

    // Add entries
    for (const entry of history) {
      const timeAgo = this.formatTimeAgo(entry.timestamp);
      const duration = this.formatDuration(entry.duration);
      const preview = entry.text.length > 80
        ? entry.text.slice(0, 77) + '...'
        : entry.text;

      items.push({
        label: preview,
        description: `${duration} | ${entry.provider}`,
        detail: `${timeAgo} | ${entry.charCount} chars${entry.language ? ` | ${entry.language}` : ''}`,
        entry,
      });
    }

    // Add separator and actions
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: '$(trash) Clear History',
      action: 'clear',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a transcription to copy to clipboard',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (!selected) {
      return;
    }

    if (selected.action === 'clear') {
      const confirm = await vscode.window.showWarningMessage(
        'Clear all transcription history?',
        { modal: true },
        'Clear',
      );
      if (confirm === 'Clear') {
        await this.clear();
        vscode.window.showInformationMessage('Code Dictator: History cleared.');
      }
      return;
    }

    if (selected.entry) {
      const actions = ['Copy to Clipboard', 'Insert at Cursor'];
      const action = await vscode.window.showQuickPick(actions, {
        placeHolder: 'What would you like to do with this transcription?',
      });

      if (action === 'Copy to Clipboard') {
        await vscode.env.clipboard.writeText(selected.entry.text);
        vscode.window.showInformationMessage('Code Dictator: Copied to clipboard.');
      } else if (action === 'Insert at Cursor') {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit((editBuilder) => {
            if (editor.selection.isEmpty) {
              editBuilder.insert(editor.selection.active, selected.entry!.text);
            } else {
              editBuilder.replace(editor.selection, selected.entry!.text);
            }
          });
          vscode.window.showInformationMessage('Code Dictator: Inserted at cursor.');
        } else {
          await vscode.env.clipboard.writeText(selected.entry.text);
          vscode.window.showInformationMessage('Code Dictator: No editor open — copied to clipboard instead.');
        }
      }
    }
  }

  private formatTimeAgo(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) {
      return 'just now';
    }
    if (diffMin < 60) {
      return `${diffMin}m ago`;
    }
    if (diffHour < 24) {
      return `${diffHour}h ago`;
    }
    if (diffDay < 7) {
      return `${diffDay}d ago`;
    }
    return new Date(timestamp).toLocaleDateString();
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
}
