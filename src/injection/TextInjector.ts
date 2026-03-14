import * as vscode from 'vscode';
import type { InjectionTarget } from '../types';

export class TextInjector {
  /**
   * Inject transcribed text into the appropriate target.
   * Returns a description of where the text was injected.
   */
  async inject(
    text: string,
    target: InjectionTarget,
    autoCopyToClipboard: boolean,
  ): Promise<string> {
    if (!text.trim()) {
      return 'Empty transcription — nothing to inject';
    }

    let destination: string;

    switch (target) {
      case 'editor':
        destination = await this.insertIntoEditor(text);
        break;
      case 'clipboard':
        destination = await this.copyToClipboard(text);
        break;
      case 'auto':
      default:
        destination = await this.autoInject(text);
        break;
    }

    // Also copy to clipboard if configured and primary target wasn't clipboard
    if (autoCopyToClipboard && target !== 'clipboard' && destination !== 'clipboard') {
      await vscode.env.clipboard.writeText(text);
    }

    return destination;
  }

  private async autoInject(text: string): Promise<string> {
    // First try: use the `type` command which works in editors, chat inputs, etc.
    try {
      await vscode.commands.executeCommand('type', { text });
      return 'active input';
    } catch {
      // `type` command failed — no focused text input
    }

    // Second try: insert into active text editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      return this.insertIntoEditor(text);
    }

    // Fallback: clipboard
    return this.copyToClipboard(text);
  }

  private async insertIntoEditor(text: string): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      // No editor available, fall back to clipboard
      return this.copyToClipboard(text);
    }

    await editor.edit((editBuilder) => {
      if (editor.selection.isEmpty) {
        // Insert at cursor position
        editBuilder.insert(editor.selection.active, text);
      } else {
        // Replace selection
        editBuilder.replace(editor.selection, text);
      }
    });

    return 'editor';
  }

  private async copyToClipboard(text: string): Promise<string> {
    await vscode.env.clipboard.writeText(text);
    return 'clipboard';
  }
}
