import * as vscode from 'vscode';
import type { StorageService } from '../storage/StorageService';
import { createProvider } from '../providers/ProviderFactory';
import type { ProviderType } from '../types';

const ELEVENLABS_REFERRAL = 'https://try.elevenlabs.io/rgoomc9z8dvv';
const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';

interface ProviderPickItem extends vscode.QuickPickItem {
  providerId: ProviderType;
}

export async function runSetupWizard(storage: StorageService): Promise<boolean> {
  // Step 1: Choose provider
  const providers: ProviderPickItem[] = [
    {
      label: '$(star-full) ElevenLabs',
      description: 'Recommended',
      detail: 'High accuracy with Scribe v2, 90+ languages, free tier available',
      providerId: 'elevenlabs',
    },
    {
      label: '$(key) OpenAI Whisper',
      detail: 'Reliable transcription if you already have an OpenAI API key',
      providerId: 'openai',
    },
    {
      label: '$(server) Custom API',
      detail: 'Any Whisper-compatible endpoint (faster-whisper-server, whisper.cpp, etc.)',
      providerId: 'custom',
    },
  ];

  const selected = await vscode.window.showQuickPick(providers, {
    placeHolder: 'Choose your speech-to-text provider',
    title: 'Code Dictator Setup',
    matchOnDetail: true,
  });

  if (!selected) return false;
  const providerId = selected.providerId;

  // Update provider setting
  const config = vscode.workspace.getConfiguration('codeDictator');
  await config.update('provider', providerId, vscode.ConfigurationTarget.Global);

  // Step 2: Get API key (provider-specific flow)
  if (providerId === 'elevenlabs') {
    const action = await vscode.window.showInformationMessage(
      'You need an ElevenLabs API key. The free plan includes transcription credits.',
      { modal: false },
      'Get API Key (opens browser)',
      'I already have one'
    );
    if (action === 'Get API Key (opens browser)') {
      await vscode.env.openExternal(vscode.Uri.parse(ELEVENLABS_REFERRAL));
      // Give user time to get the key
      await vscode.window.showInformationMessage(
        'After copying your API key from ElevenLabs, come back here and click "Enter Key".',
        'Enter Key'
      );
    }
    if (action === undefined) return false; // Cancelled

    const key = await vscode.window.showInputBox({
      title: 'Code Dictator — ElevenLabs API Key',
      prompt: 'Paste your ElevenLabs API key (stored securely in your OS keychain)',
      password: true,
      placeHolder: 'xi-...',
      ignoreFocusOut: true,
      validateInput: (v) => v.trim().length < 10 ? 'API key seems too short' : undefined,
    });
    if (!key) return false;
    await storage.setApiKey('elevenlabs', key.trim());

  } else if (providerId === 'openai') {
    const action = await vscode.window.showInformationMessage(
      'You need an OpenAI API key for Whisper transcription.',
      { modal: false },
      'Get API Key (opens browser)',
      'I already have one'
    );
    if (action === 'Get API Key (opens browser)') {
      await vscode.env.openExternal(vscode.Uri.parse(OPENAI_KEYS_URL));
      await vscode.window.showInformationMessage(
        'After copying your API key from OpenAI, come back here and click "Enter Key".',
        'Enter Key'
      );
    }
    if (action === undefined) return false;

    const key = await vscode.window.showInputBox({
      title: 'Code Dictator — OpenAI API Key',
      prompt: 'Paste your OpenAI API key (stored securely in your OS keychain)',
      password: true,
      placeHolder: 'sk-...',
      ignoreFocusOut: true,
      validateInput: (v) => !v.trim().startsWith('sk-') ? 'OpenAI keys start with sk-' : undefined,
    });
    if (!key) return false;
    await storage.setApiKey('openai', key.trim());

  } else if (providerId === 'custom') {
    const url = await vscode.window.showInputBox({
      title: 'Code Dictator — Custom API Endpoint',
      prompt: 'Enter the URL of your Whisper-compatible API',
      placeHolder: 'http://localhost:8000/v1/audio/transcriptions',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          const url = new URL(v);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'URL must use http:// or https://';
          }
          return undefined;
        } catch { return 'Please enter a valid URL'; }
      },
    });
    if (!url) return false;
    await config.update('customApiUrl', url.trim(), vscode.ConfigurationTarget.Global);

    // Optional API key for custom endpoints
    const needsKey = await vscode.window.showQuickPick(
      [
        { label: 'No authentication needed', id: 'no' },
        { label: 'Enter API key', id: 'yes' },
      ],
      { placeHolder: 'Does your endpoint require an API key?' }
    );
    if (needsKey?.id === 'yes') {
      const key = await vscode.window.showInputBox({
        title: 'Code Dictator — Custom API Key',
        prompt: 'Enter the API key for your custom endpoint',
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await storage.setApiKey('custom', key.trim());
      }
    }
  }

  // Step 3: Validate
  const settings = storage.getSettings();
  const provider = createProvider(settings, (p) => storage.getApiKey(p));
  const valid = await provider.validateConfig();

  if (valid) {
    vscode.window.setStatusBarMessage('$(check) Code Dictator: Setup complete! Press Alt+D to start dictating.', 5000);
    return true;
  } else {
    const retry = await vscode.window.showWarningMessage(
      'API key validation failed. The key may be incorrect.',
      'Try Again',
      'Continue Anyway'
    );
    if (retry === 'Try Again') {
      return runSetupWizard(storage);
    }
    return retry === 'Continue Anyway';
  }
}
