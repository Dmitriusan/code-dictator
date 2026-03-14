import * as vscode from 'vscode';
import { LANGUAGES, type CodeDictatorSettings } from '../types';

/**
 * Show a QuickPick to select the transcription language.
 * If preferredLanguages is set, shows only those plus auto-detect and a
 * separator with "Show all languages..." option.
 * Returns the selected language code or undefined if cancelled.
 */
export async function showLanguagePicker(
  settings: CodeDictatorSettings,
): Promise<string | undefined> {
  const currentLanguage = settings.language || '';
  const preferred = settings.preferredLanguages;

  interface LanguagePickItem extends vscode.QuickPickItem {
    code?: string;
    action?: string;
  }

  let items: LanguagePickItem[];

  if (preferred.length > 0) {
    items = buildPreferredList(preferred, currentLanguage);
  } else {
    items = buildFullList(currentLanguage);
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select transcription language',
    matchOnDescription: true,
  });

  if (!selected) {
    return undefined;
  }

  // Handle "Show all languages" action
  if (selected.action === 'showAll') {
    const allItems = buildFullList(currentLanguage);
    const allSelected = await vscode.window.showQuickPick(allItems, {
      placeHolder: 'Select transcription language',
      matchOnDescription: true,
    });
    if (!allSelected || allSelected.code === undefined) {
      return undefined;
    }
    await updateLanguageSetting(allSelected.code);
    return allSelected.code;
  }

  if (selected.code === undefined) {
    return undefined;
  }

  await updateLanguageSetting(selected.code);
  return selected.code;
}

function buildPreferredList(
  preferred: string[],
  currentLanguage: string,
): Array<vscode.QuickPickItem & { code?: string; action?: string }> {
  const items: Array<vscode.QuickPickItem & { code?: string; action?: string }> = [];

  // Auto-detect always first
  const autoDetect = LANGUAGES.find((l) => l.code === '');
  if (autoDetect) {
    items.push({
      label: `$(globe) ${autoDetect.name}`,
      description: currentLanguage === '' ? '(current)' : undefined,
      code: '',
    });
  }

  // Preferred languages
  for (const code of preferred) {
    const lang = LANGUAGES.find((l) => l.code === code);
    if (lang) {
      items.push({
        label: lang.name,
        description: currentLanguage === code ? '(current)' : code.toUpperCase(),
        code: lang.code,
      });
    }
  }

  // Separator
  items.push({
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
  });

  // Show all option
  items.push({
    label: '$(list-unordered) Show all languages...',
    action: 'showAll',
  });

  return items;
}

function buildFullList(
  currentLanguage: string,
): Array<vscode.QuickPickItem & { code?: string; action?: string }> {
  return LANGUAGES.map((lang) => ({
    label: lang.code === '' ? `$(globe) ${lang.name}` : lang.name,
    description:
      currentLanguage === lang.code
        ? '(current)'
        : lang.code
          ? lang.code.toUpperCase()
          : undefined,
    code: lang.code,
  }));
}

async function updateLanguageSetting(code: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('codeDictator');
  await config.update('language', code, vscode.ConfigurationTarget.Global);
}

/**
 * Multi-select QuickPick for configuring preferred languages.
 * Shows all languages with checkboxes — currently preferred ones are pre-selected.
 * Updates the `preferredLanguages` setting on confirm.
 */
export async function showLanguageConfigurator(
  settings: CodeDictatorSettings,
): Promise<void> {
  const currentPreferred = new Set(settings.preferredLanguages);

  // Build multi-select items (skip auto-detect — it's always available)
  const allLanguages = LANGUAGES.filter((l) => l.code !== '');
  const items: Array<vscode.QuickPickItem & { code: string }> = allLanguages.map((lang) => ({
    label: lang.name,
    description: lang.code.toUpperCase(),
    code: lang.code,
    picked: currentPreferred.has(lang.code),
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select your preferred languages (these appear in the quick-switch picker)',
    canPickMany: true,
    matchOnDescription: true,
  });

  if (!selected) {
    return; // Cancelled
  }

  const codes = selected.map((item) => item.code);
  const config = vscode.workspace.getConfiguration('codeDictator');
  await config.update('preferredLanguages', codes, vscode.ConfigurationTarget.Global);

  if (codes.length > 0) {
    const names = selected.map((item) => item.label).join(', ');
    vscode.window.setStatusBarMessage(`$(check) Preferred languages: ${names}`, 3000);
  } else {
    vscode.window.setStatusBarMessage('$(check) Preferred languages cleared — showing all languages', 3000);
  }
}
