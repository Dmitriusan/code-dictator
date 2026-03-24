import * as vscode from 'vscode';
import * as fs from 'fs';
import { StorageService } from './storage/StorageService';
import { StatusBar } from './ui/StatusBar';
import { RecorderManager } from './recorder/RecorderManager';
import type { AudioDiagnostics } from './recorder/NativeRecorder';
import { isAudioSilent } from './recorder/AudioAnalysis';
import { UsageTracker } from './tracking/UsageTracker';
import { HistoryManager } from './tracking/History';
import { TextInjector } from './injection/TextInjector';
import { createProvider } from './providers/ProviderFactory';
import { format } from './postprocess/Formatter';
import { removeFillerWords } from './postprocess/FillerWords';
import { applyCodeAware } from './postprocess/CodeAware';
import { cleanup as llmCleanup, setCleanupLogger } from './postprocess/LLMCleanup';
import { showLanguagePicker, showLanguageConfigurator } from './ui/LanguagePicker';
import { runSetupWizard } from './ui/SetupWizard';
import { HoldModeController } from './recorder/HoldModeController';
import { configureDiagnosticLog, diagLog, disposeDiagnosticLog } from './DiagnosticLog';
import { playCompletionChime } from './ui/SoundPlayer';
import { isHallucination, isSuspiciouslyShort } from './postprocess/HallucinationFilter';
import type { TranscriptionResult } from './types';

let storageService: StorageService;
let statusBar: StatusBar;
let recorder: RecorderManager;
let usageTracker: UsageTracker;
let historyManager: HistoryManager;
let textInjector: TextInjector;
let holdController: HoldModeController;
let cleanupKeyWarningShown = false;
/** Tracks the in-flight handleStartRecording() promise so hold-release can wait for it. */
let startRecordingPromise: Promise<void> | null = null;
/**
 * Guards against concurrent recording state transitions.
 * Set while a start/stop operation is in flight so rapid Alt+D presses are ignored.
 */
let isTransitioning = false;
/**
 * AbortController for the in-flight transcription/cleanup pipeline.
 * Set at the start of handleStopAndTranscribe(), cleared on completion.
 * Allows the user to cancel transcription or AI cleanup via Escape.
 */
let pipelineAbort: AbortController | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Initialize services
  storageService = new StorageService(context);
  // Migrate settings from old key names (v1.x → v2.x) before reading anything
  storageService.migrateSettings().catch(() => { /* best-effort */ });
  configureDiagnosticLog(storageService.getSettings().diagnosticLogging);
  setCleanupLogger(diagLog);
  statusBar = new StatusBar();
  recorder = new RecorderManager(context.extensionUri);
  usageTracker = new UsageTracker(storageService);
  historyManager = new HistoryManager(storageService);
  textInjector = new TextInjector();
  holdController = new HoldModeController();

  // Wire hold-mode callbacks
  holdController.onStart(() => {
    const p = handleStartRecording();
    startRecordingPromise = p;
    p.finally(() => { if (startRecordingPromise === p) { startRecordingPromise = null; } });
  });
  holdController.onRelease(async () => {
    // If recording startup is still in flight, wait for it before stopping.
    // This prevents the race where stop arrives before the webview's
    // MediaRecorder has initialised.
    if (startRecordingPromise) {
      await startRecordingPromise;
    }
    if (recorder.isRecording) {
      handleStopAndTranscribe();
    }
  });

  // Push disposables
  context.subscriptions.push(statusBar);
  context.subscriptions.push(recorder);

  // Initialize status bar state
  const settings = storageService.getSettings();
  statusBar.updateLanguage(settings.language);
  statusBar.updateCost(usageTracker.getStatusBarText(), settings.showCostIndicator);

  // Set initial recording/processing context
  vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
  vscode.commands.executeCommand('setContext', 'codeDictator.isProcessing', false);

  // Wire up recorder events
  context.subscriptions.push(
    recorder.onError((message) => {
      vscode.window.showErrorMessage(`Code Dictator: ${message}`);
      statusBar.updateState('idle');
      vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
    }),
  );

  // Reset UI when recording is cancelled internally (e.g. no-audio auto-cancel)
  context.subscriptions.push(
    recorder.onRecordingStopped(() => {
      statusBar.updateState('idle');
      vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
    }),
  );

  context.subscriptions.push(
    recorder.onTrackEnded((diagnostics?: AudioDiagnostics) => {
      const reason = diagnostics?.reason ?? 'No audio from microphone';
      const suggestion = diagnostics?.suggestion
        ?? 'This commonly happens when a Bluetooth headset switches to another device. Try switching to a different microphone in your OS sound settings.';
      vscode.window.showWarningMessage(
        `Code Dictator: ${reason}. ${suggestion}`,
      );
    }),
  );

  context.subscriptions.push(
    recorder.onSilenceDetected(() => {
      // Auto-stop on silence / max duration / track ended — respect the
      // transition lock so this doesn't race with a concurrent user toggle.
      if (recorder.isRecording && !isTransitioning) {
        isTransitioning = true;
        handleStopAndTranscribe().finally(() => { isTransitioning = false; });
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.toggleRecording', async () => {
      const settings = storageService.getSettings();

      if (settings.recordingMode === 'hold') {
        // Hold mode: each keydown (initial + OS repeats) goes through the
        // debounce controller. First press starts recording; when repeats
        // stop (key released), the controller fires the release callback.
        holdController.handleKeyDown();
      } else {
        // Toggle mode: serialize start/stop — ignore rapid presses while
        // a state transition is in flight.
        if (isTransitioning) {
          diagLog('Extension', 'Toggle ignored: state transition in progress');
          return;
        }

        isTransitioning = true;
        try {
          if (recorder.isRecording) {
            await handleStopAndTranscribe();
          } else {
            await handleStartRecording();
          }
        } finally {
          isTransitioning = false;
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.cancelRecording', () => {
      if (recorder.isRecording) {
        // Cancel active recording
        holdController.cancel(); // no-op if not in hold mode
        recorder.cancelRecording();
        statusBar.updateState('idle');
        vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
        statusBar.showTransientMessage('$(x) Cancelled', 1500);
      } else if (pipelineAbort) {
        // Cancel in-flight transcription or AI cleanup
        diagLog('Extension', 'Cancelling transcription/cleanup pipeline');
        pipelineAbort.abort();
      } else {
        // Defensive: reset any stale UI state (e.g. recorder error left status bar stuck)
        statusBar.updateState('idle');
        vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
        vscode.commands.executeCommand('setContext', 'codeDictator.isProcessing', false);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.showHistory', () => {
      historyManager.showHistoryQuickPick();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.transcribeFile', () => {
      handleTranscribeFile();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.showUsage', () => {
      handleShowUsage();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.selectLanguage', async () => {
      const currentSettings = storageService.getSettings();
      const code = await showLanguagePicker(currentSettings);
      if (code !== undefined) {
        statusBar.updateLanguage(code);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'codeDictator');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.setApiKey', async () => {
      await runSetupWizard(storageService);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.setCleanupApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Code Dictator — Cleanup API Key (OpenAI)',
        prompt: 'Paste your OpenAI API key for LLM cleanup (stored securely in your OS keychain)',
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
        validateInput: (v) => !v.trim().startsWith('sk-') ? 'OpenAI keys start with sk-' : undefined,
      });
      if (key) {
        await storageService.setApiKey('openai-cleanup', key.trim());
        vscode.window.setStatusBarMessage('$(check) Code Dictator: Cleanup API key saved.', 3000);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeDictator.configureLanguages', async () => {
      const currentSettings = storageService.getSettings();
      await showLanguageConfigurator(currentSettings);
      // Refresh status bar after language config changes
      const newSettings = storageService.getSettings();
      statusBar.updateLanguage(newSettings.language);
    }),
  );

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeDictator')) {
        const newSettings = storageService.getSettings();
        statusBar.updateLanguage(newSettings.language);
        statusBar.updateCost(usageTracker.getStatusBarText(), newSettings.showCostIndicator);
        configureDiagnosticLog(newSettings.diagnosticLogging);
      }
    }),
  );

  // Show onboarding on first activation
  const onboarded = context.globalState.get<boolean>('codeDictator.onboarded', false);
  if (!onboarded) {
    context.globalState.update('codeDictator.onboarded', true);
    // Run setup wizard, then show walkthrough
    runSetupWizard(storageService).then(() => {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'irrationalways.code-dictator#codeDictator.setup',
        false,
      );
    });
  }
}

async function handleStartRecording(): Promise<void> {
  const settings = storageService.getSettings();
  const provider = createProvider(settings, (p) => storageService.getApiKey(p));

  // Validate provider config before starting
  const valid = await provider.validateConfig();
  if (!valid) {
    const action = await vscode.window.showErrorMessage(
      `Code Dictator: ${provider.name} is not configured. Please set your API key.`,
      'Set API Key',
      'Open Settings',
    );
    if (action === 'Set API Key') {
      vscode.commands.executeCommand('codeDictator.setApiKey');
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand('codeDictator.openSettings');
    }
    return;
  }

  try {
    diagLog('Extension', `Starting recording: provider=${settings.provider}, isolation=${settings.audioIsolation}, maxDuration=${settings.maxRecordingDuration}s`);
    await recorder.startRecording(
      settings.audioIsolation,
      settings.silenceTimeout,
      settings.maxRecordingDuration,
    );
    // Show recording indicator AFTER recorder is ready — so the user
    // sees the red mic icon only when audio is actually being captured
    statusBar.updateState('recording');
    vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', true);
  } catch (error) {
    statusBar.updateState('idle');
    vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Code Dictator: Failed to start recording — ${message}`);
  }
}

async function handleStopAndTranscribe(): Promise<void> {
  const settings = storageService.getSettings();

  // Create an AbortController so the user can cancel transcription/cleanup via Escape
  const abort = new AbortController();
  pipelineAbort = abort;

  try {
    // Stop recording and get audio data
    statusBar.updateState('transcribing');
    vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
    vscode.commands.executeCommand('setContext', 'codeDictator.isProcessing', true);

    const audioPayload = await recorder.stopRecording();
    diagLog('Extension', `Recording stopped: ${Math.round(audioPayload.durationMs / 1000)}s, ${audioPayload.buffer.length} bytes, mime=${audioPayload.mimeType}`);

    // Guard against empty/too-short recordings (e.g. stale timer, device disconnect)
    const MIN_AUDIO_BYTES = 1000; // ~30ms of 16kHz 16-bit mono
    if (audioPayload.buffer.length < MIN_AUDIO_BYTES) {
      statusBar.updateState('idle');
      diagLog('Extension', `Audio too short (${audioPayload.buffer.length} bytes), skipping transcription`);
      statusBar.showTransientMessage('$(warning) Recording too short', 2000);
      return;
    }

    // Guard against silence-filled recordings (e.g. PipeWire lost hardware,
    // default source is auto_null.monitor, mic producing zero samples).
    // Whisper hallucinates on silence, so skip transcription entirely.
    if (isAudioSilent(audioPayload.buffer)) {
      statusBar.updateState('idle');
      diagLog('Extension', 'Audio is silent (all zeros / near-zero), skipping transcription');
      vscode.window.showWarningMessage(
        'Code Dictator: Microphone is producing silence. Your audio device may have disconnected. Check your OS sound settings or restart your audio system.',
      );
      return;
    }

    // Build Whisper prompt hint to reduce hallucinations.
    const whisperPrompt = buildWhisperPrompt();

    // Transcribe
    const provider = createProvider(settings, (p) => storageService.getApiKey(p));
    diagLog('STT', `Calling ${provider.name} (${provider.id}), language: ${settings.language || 'auto'}, mimeType: ${audioPayload.mimeType}, audioSize: ${audioPayload.buffer.length} bytes${whisperPrompt ? ', prompt hint: yes' : ''}`);
    let result: TranscriptionResult;
    try {
      result = await provider.transcribe(audioPayload.buffer, {
        language: settings.language || undefined,
        prompt: whisperPrompt,
        mimeType: audioPayload.mimeType,
        signal: abort.signal,
      });
    } catch (error) {
      statusBar.updateState('idle');
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Code Dictator: Transcription failed — ${message}`);
      return;
    }
    diagLog('STT', `Result: "${result.text}", language=${result.language ?? 'n/a'}, duration=${result.duration ?? 'n/a'}s, cost=${result.cost ?? 'n/a'}`);

    if (!result.text.trim() || isHallucination(result.text)) {
      statusBar.updateState('idle');
      if (result.text.trim()) {
        diagLog('STT', `Hallucination filtered: "${result.text}"`);
      }
      statusBar.showTransientMessage('$(warning) No speech detected', 2000);
      return;
    }

    // Warn if transcription is suspiciously short relative to recording duration
    if (isSuspiciouslyShort(result.text, audioPayload.durationMs)) {
      diagLog('STT', `Suspiciously short transcription: ${result.text.split(/\s+/).length} words for ${Math.round(audioPayload.durationMs / 1000)}s recording`);
      vscode.window.showWarningMessage(
        `Code Dictator: Transcription may be inaccurate — got only ${result.text.split(/\s+/).length} words from a ${Math.round(audioPayload.durationMs / 1000)}s recording. The audio may have been unclear.`,
      );
    }

    // Post-processing pipeline
    let text = result.text;

    // Step 1: Auto-formatting (always applied)
    text = format(text);

    // Step 2: Language-aware filler word removal (no API cost)
    // Priority: provider-detected language → user setting → English fallback
    if (settings.fillerRemoval) {
      const detectedLang = result.language || settings.language || 'en';
      text = removeFillerWords(text, detectedLang);
    }

    // Step 3: Code-aware replacements
    if (settings.codeAwareMode) {
      text = applyCodeAware(text);
    }

    // Step 4: AI-powered cleanup (optional)
    const detectedLang = result.language || settings.language || undefined;
    if (settings.aiTextCleanup) {
      const cleanupKey = await storageService.getApiKey('openai-cleanup')
        || await storageService.getApiKey('openai');
      if (cleanupKey) {
        diagLog('Extension', 'Starting AI cleanup with model=' + settings.cleanupModel);
        statusBar.updateState('cleaning');
        try {
          text = await llmCleanup(text, cleanupKey, settings.cleanupModel, settings.preferredLanguages, detectedLang, abort.signal);
          diagLog('Extension', 'AI cleanup complete');
        } catch (error) {
          console.warn('Code Dictator: AI cleanup failed, using raw text', error);
          diagLog('Extension', 'AI cleanup failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      } else if (!cleanupKeyWarningShown) {
        cleanupKeyWarningShown = true;
        const action = await vscode.window.showWarningMessage(
          'AI Text Cleanup is enabled but no OpenAI API key is configured.',
          'Set OpenAI API Key',
        );
        if (action === 'Set OpenAI API Key') {
          vscode.commands.executeCommand('codeDictator.setCleanupApiKey');
        }
      }
    }

    // Inject text
    const destination = await textInjector.inject(
      text,
      settings.defaultTarget,
      settings.autoCopyToClipboard,
    );

    // Track usage
    await usageTracker.record(result, provider.id, audioPayload.durationMs);

    // Update status bar
    statusBar.updateState('idle');
    statusBar.updateCost(usageTracker.getStatusBarText(), settings.showCostIndicator);

    // Silent feedback via status bar — no popups to interrupt the dictate→review→dictate flow
    const charCount = text.length;
    const duration = Math.round(audioPayload.durationMs / 1000);
    statusBar.showTransientMessage(`$(check) ${charCount} chars, ${duration}s → ${destination}`, undefined, true);

    // Completion sound (if enabled)
    if (settings.successfulTranscriptionSound) {
      playCompletionChime();
    }
  } catch (error) {
    statusBar.updateState('idle');
    vscode.commands.executeCommand('setContext', 'codeDictator.isRecording', false);
    const message = error instanceof Error ? error.message : String(error);
    // Suppress error messages for user-initiated cancellations (AbortError from fetch)
    if (error instanceof DOMException && error.name === 'AbortError') {
      diagLog('Extension', 'Pipeline cancelled by user');
      statusBar.showTransientMessage('$(x) Cancelled', 1500);
    } else if (!message.includes('cancelled')) {
      vscode.window.showErrorMessage(`Code Dictator: ${message}`);
    }
  } finally {
    pipelineAbort = null;
    vscode.commands.executeCommand('setContext', 'codeDictator.isProcessing', false);
  }
}

/**
 * Build a prompt hint for Whisper to reduce hallucinations.
 * Avoids mentioning specific non-English languages — that biases Whisper
 * toward detecting/translating into those languages even when user speaks English.
 */
function buildWhisperPrompt(): string {
  // Whisper's prompt parameter works best as example-style text.
  // Providing coding vocabulary context reduces hallucinations like
  // phantom subtitle attributions ("Субтитры подготовил DimaTorzok").
  return 'Software development discussion. Technical terms, API names, function names, and code-related vocabulary.';
}

async function handleTranscribeFile(): Promise<void> {
  const fileUris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'Audio Files': ['mp3', 'wav', 'webm', 'ogg', 'flac', 'm4a', 'mp4', 'mpeg', 'mpga'],
      'All Files': ['*'],
    },
    title: 'Select an audio file to transcribe',
  });

  if (!fileUris || fileUris.length === 0) {
    return;
  }

  const fileUri = fileUris[0];
  const settings = storageService.getSettings();

  // Validate provider
  const provider = createProvider(settings, (p) => storageService.getApiKey(p));
  const valid = await provider.validateConfig();
  if (!valid) {
    const action = await vscode.window.showErrorMessage(
      `Code Dictator: ${provider.name} is not configured.`,
      'Set API Key',
    );
    if (action === 'Set API Key') {
      vscode.commands.executeCommand('codeDictator.setApiKey');
    }
    return;
  }

  try {
    statusBar.updateState('transcribing');

    // Read the file
    const audioBuffer = Buffer.from(await fs.promises.readFile(fileUri.fsPath));

    // Derive MIME type from file extension so the STT API receives the correct filename hint
    const ext = fileUri.fsPath.split('.').pop()?.toLowerCase() ?? '';
    const extMimeMap: Record<string, string> = {
      mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4', mp4: 'audio/mp4',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      webm: 'audio/webm',
    };
    const fileMimeType = extMimeMap[ext] ?? 'audio/webm';

    // Transcribe
    const result = await provider.transcribe(audioBuffer, {
      language: settings.language || undefined,
      mimeType: fileMimeType,
    });

    if (!result.text.trim()) {
      statusBar.updateState('idle');
      statusBar.showTransientMessage('$(warning) No speech in file', 2000);
      return;
    }

    // Post-process
    let text = result.text;
    text = format(text);
    if (settings.fillerRemoval) {
      text = removeFillerWords(text, result.language || settings.language || 'en');
    }

    if (settings.codeAwareMode) {
      text = applyCodeAware(text);
    }

    const detectedLang = result.language || settings.language || undefined;
    if (settings.aiTextCleanup) {
      const cleanupKey = await storageService.getApiKey('openai-cleanup')
        || await storageService.getApiKey('openai');
      if (cleanupKey) {
        statusBar.updateState('cleaning');
        try {
          text = await llmCleanup(text, cleanupKey, settings.cleanupModel, settings.preferredLanguages, detectedLang);
        } catch {
          // Fall through with raw text
        }
      } else if (!cleanupKeyWarningShown) {
        cleanupKeyWarningShown = true;
        const action = await vscode.window.showWarningMessage(
          'AI Text Cleanup is enabled but no OpenAI API key is configured.',
          'Set OpenAI API Key',
        );
        if (action === 'Set OpenAI API Key') {
          vscode.commands.executeCommand('codeDictator.setCleanupApiKey');
        }
      }
    }

    // Inject
    const destination = await textInjector.inject(
      text,
      settings.defaultTarget,
      settings.autoCopyToClipboard,
    );

    // Prefer the provider-returned duration (seconds) over the raw buffer heuristic,
    // which assumes 16-bit mono 16 kHz PCM and is wildly off for compressed formats.
    const durationMs = result.duration != null
      ? result.duration * 1000
      : (audioBuffer.length / 32) * 1000;   // fallback: 16-bit 16 kHz = 32 bytes/ms
    await usageTracker.record(result, provider.id, durationMs);

    statusBar.updateState('idle');
    statusBar.updateCost(usageTracker.getStatusBarText(), settings.showCostIndicator);

    const charCount = text.length;
    statusBar.showTransientMessage(`$(check) File: ${charCount} chars → ${destination}`, undefined, true);

    if (settings.successfulTranscriptionSound) {
      playCompletionChime();
    }
  } catch (error) {
    statusBar.updateState('idle');
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Code Dictator: File transcription failed — ${message}`);
  }
}

async function handleShowUsage(): Promise<void> {
  const stats = usageTracker.getStats();

  const items: vscode.QuickPickItem[] = [
    {
      label: '$(calendar) Today',
      description: `${stats.todayTranscriptions} transcriptions`,
      detail: `Duration: ${usageTracker.formatDuration(stats.todayDurationMs)} | Cost: ${usageTracker.formatCost(stats.todayEstimatedCost)}`,
    },
    {
      label: '$(calendar) This Week',
      description: `${stats.weekTranscriptions} transcriptions`,
      detail: `Duration: ${usageTracker.formatDuration(stats.weekDurationMs)} | Cost: ${usageTracker.formatCost(stats.weekEstimatedCost)}`,
    },
    {
      label: '$(history) All Time',
      description: `${stats.totalTranscriptions} transcriptions`,
      detail: `Duration: ${usageTracker.formatDuration(stats.totalDurationMs)} | Cost: ${usageTracker.formatCost(stats.totalEstimatedCost)}`,
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(book) View History',
      description: 'Browse past transcriptions',
    },
    {
      label: '$(gear) Open Settings',
      description: 'Configure Code Dictator',
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Code Dictator — Usage & Costs',
  });

  if (!selected) {
    return;
  }

  if (selected.label.includes('View History')) {
    historyManager.showHistoryQuickPick();
  } else if (selected.label.includes('Open Settings')) {
    vscode.commands.executeCommand('codeDictator.openSettings');
  }
}

export function deactivate(): void {
  disposeDiagnosticLog();
}
