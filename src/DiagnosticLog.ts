import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
let enabled = false;

export function configureDiagnosticLog(isEnabled: boolean): void {
  enabled = isEnabled;
  if (enabled && !channel) {
    channel = vscode.window.createOutputChannel('Code Dictator');
  }
}

export function diagLog(source: string, message: string): void {
  if (!enabled) {
    return;
  }
  if (!channel) {
    channel = vscode.window.createOutputChannel('Code Dictator');
  }
  const timestamp = new Date().toISOString().slice(11, 23);
  channel.appendLine(`[${timestamp}] [${source}] ${message}`);
}

export function disposeDiagnosticLog(): void {
  if (channel) {
    channel.dispose();
    channel = undefined;
  }
}
