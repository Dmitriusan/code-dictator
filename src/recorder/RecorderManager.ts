import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AudioDataPayload, AudioIsolation, MessageFromWebview, MessageToWebview } from '../types';
import { getRecorderWebviewContent, MIC_PERMISSION_DENIED } from './RecorderWebviewContent';
import { NativeRecorder, type AudioDiagnostics } from './NativeRecorder';
import { NoRecorderError } from './NoRecorderError';
import { diagLog } from '../DiagnosticLog';
import type { LiveTranscription } from '../transcription/LiveTranscription';

/** A stopped recording, with the live transcription that followed it (see setLiveTranscription). */
export interface RecordedAudio extends AudioDataPayload {
  live?: LiveTranscription;
}

type RecorderEvent = 'recordingStarted' | 'recordingStopped' | 'audioData' | 'error' | 'silenceDetected' | 'trackEnded';

export class RecorderManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private _isRecording = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly listeners = new Map<RecorderEvent, Array<(...args: any[]) => void>>();
  private audioDataResolve: ((payload: AudioDataPayload) => void) | undefined;
  private audioDataReject: ((error: Error) => void) | undefined;
  private readyResolve: (() => void) | undefined;
  private disposables: vscode.Disposable[] = [];
  private nativeRecorder: NativeRecorder | null = null;
  // Audio data that arrived before stopRecording() was called (e.g. Bluetooth
  // device disconnected → track.onended → MediaRecorder auto-stopped).
  private pendingAudioPayload: AudioDataPayload | undefined;
  // Max duration timeout — must be cleared when recording stops to prevent
  // a stale timer from killing the next recording session.
  private maxDurationTimeout: ReturnType<typeof setTimeout> | undefined;
  // Set during the webview permission-detection window to intercept errors
  // before they propagate to external onError handlers.
  private permissionErrorHandler: ((msg: string) => void) | undefined;
  // Set once the webview recorder has been refused the microphone. Later
  // starts in this window then fail at once instead of reopening its tab.
  private webviewMicDenied = false;
  // The native start in progress. A recorder that is still starting cannot be
  // cancelled yet, so cancelRecording() marks the start and the start cancels
  // the recorder as soon as it runs.
  private nativeStart: { cancelled: boolean } | undefined;
  // Starts a live transcription of each native recording (see setLiveTranscription)
  private liveFactory: ((file: string) => LiveTranscription | undefined) | undefined;
  // The live transcription of the native recording in progress, with the recorder it follows
  private live: { recorder: NativeRecorder; session: LiveTranscription } | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * Have every native recording followed while it records: `factory` gets the
   * file the recorder writes and returns the live transcription that reads it,
   * or undefined for none. stopRecording() hands it over with the audio;
   * a recording that is cancelled, lost or fails to stop cancels it.
   */
  setLiveTranscription(factory: (file: string) => LiveTranscription | undefined): void {
    this.liveFactory = factory;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  onRecordingStarted(handler: () => void): vscode.Disposable {
    return this.addListener('recordingStarted', handler);
  }

  onRecordingStopped(handler: () => void): vscode.Disposable {
    return this.addListener('recordingStopped', handler);
  }

  onAudioData(handler: (payload: AudioDataPayload) => void): vscode.Disposable {
    return this.addListener('audioData', handler);
  }

  onError(handler: (message: string) => void): vscode.Disposable {
    return this.addListener('error', handler);
  }

  onSilenceDetected(handler: () => void): vscode.Disposable {
    return this.addListener('silenceDetected', handler);
  }

  onTrackEnded(handler: (diagnostics?: AudioDiagnostics) => void): vscode.Disposable {
    return this.addListener('trackEnded', handler);
  }

  async startRecording(
    isolation: AudioIsolation,
    silenceTimeout: number,
    maxDuration: number,
  ): Promise<void> {
    if (this._isRecording) {
      if (this.nativeStart?.cancelled) {
        // Hold mode: pressed again while a start cancelled with Escape is
        // still running. Its recorder becomes this recording.
        diagLog('RecorderManager', 'Start requested while a cancelled start is still running — keeping its recorder');
        this.nativeStart.cancelled = false;
      }
      return;
    }

    // Claim recording state immediately to prevent concurrent startRecording()
    // calls from racing through the async gaps below (TOCTOU fix).
    this._isRecording = true;

    // Primary: native recorder. VS Code does not grant extension webviews
    // microphone access (microsoft/vscode#113916), so the webview recorder is
    // only a last resort for machines without a native recording tool.
    if (NativeRecorder.isAvailable()) {
      diagLog('RecorderManager', 'Using native recorder path');
      try {
        await this.startNativeRecording(silenceTimeout, maxDuration);
      } catch (error) {
        // Release the claim, or every later start would return early above
        this._isRecording = false;
        this.nativeRecorder = null;
        throw error;
      }
      return;
    }

    if (this.webviewMicDenied) {
      diagLog('RecorderManager', `No native recorder found, skipping webview recorder (refused the microphone earlier in this window: ${MIC_PERMISSION_DENIED})`);
      this._isRecording = false;
      throw new NoRecorderError();
    }

    // Last resort: webview MediaRecorder
    diagLog('RecorderManager', 'No native recorder found, trying webview recorder path');
    let permissionWindow: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.ensurePanel();

      // Start recording with a short timeout to detect errors quickly.
      // We intercept ALL webview errors during the startup window so they don't
      // reach external onError listeners (which would show an error popup before
      // this start reports the failure itself).
      await new Promise<void>((resolve, reject) => {
        this.permissionErrorHandler = (msg: string) => {
          reject(new Error(msg));
        };

        const message: MessageToWebview = {
          type: 'startRecording',
          isolation,
          silenceTimeout,
          maxDuration,
        };
        this.panel!.webview.postMessage(message);
        // _isRecording already set above — no duplicate needed

        // Give the webview time to fail or succeed.
        // getUserMedia can take several seconds when the OS shows a
        // permission dialog, so use a generous 5 s window before assuming
        // the webview is working and clearing the error handler.
        permissionWindow = setTimeout(() => {
          this.permissionErrorHandler = undefined;
          resolve();
        }, 5000);
      });
    } catch (webviewError) {
      // Webview recording failed, and there is no native recorder to fall back to.
      // Clear the window's timer so it can't disarm a later start's error handler.
      clearTimeout(permissionWindow);
      this.permissionErrorHandler = undefined;
      // Cleared before the tab is closed, so onDidDispose doesn't report
      // "Recording panel was closed"
      this._isRecording = false;
      if (this.panel) {
        this.panel.dispose();
        this.panel = undefined;
      }

      const errorMsg = webviewError instanceof Error ? webviewError.message : String(webviewError);
      diagLog('RecorderManager', `Webview recorder failed: ${errorMsg}`);
      if (errorMsg === MIC_PERMISSION_DENIED) {
        this.webviewMicDenied = true;
      }

      // The webview's reason stays in the log: users are told what to install instead
      throw new NoRecorderError();
    }
  }

  private async startNativeRecording(silenceTimeout: number, maxDuration: number): Promise<void> {
    // The handlers below act only while `recorder` is still this.nativeRecorder:
    // in hold mode the next recording can start while this one is still stopping.
    const recorder = new NativeRecorder();
    this.nativeRecorder = recorder;

    // If the native process exits unexpectedly, stop recording and report
    recorder.setUnexpectedExitHandler(() => {
      diagLog('RecorderManager', 'Native recorder exited unexpectedly — stopping');
      this.dropLive(recorder);
      this._isRecording = false;
      this.emit('error', 'Recording process exited unexpectedly. Enable diagnostic logging in settings for details.');
    });

    // Wire up silence detection
    if (silenceTimeout > 0) {
      recorder.setSilenceHandler(() => {
        if (this.nativeRecorder !== recorder) {
          return;
        }
        diagLog('RecorderManager', 'Native recorder silence detected, auto-stopping');
        this.emit('silenceDetected');
      });
    }

    // Warn early if mic isn't producing any audio data, then auto-cancel
    // after 2 more seconds. We cancel (SIGKILL) rather than stop+transcribe
    // because parecord connected to an errored PipeWire stream can hang on
    // SIGTERM, and there's nothing to transcribe anyway.
    recorder.setNoAudioDataHandler((diagnostics) => {
      setTimeout(() => {
        if (this._isRecording && this.nativeRecorder === recorder) {
          // Re-check: parecord/PulseAudio can buffer ~2s before flushing the
          // first chunk, so the initial "no audio" warning may have fired just
          // before data started flowing. Don't cancel if audio has since arrived.
          if (recorder.hasReceivedAudio()) {
            diagLog('RecorderManager', 'Audio data started flowing during grace period — keeping recording alive');
            return;
          }
          diagLog('RecorderManager', 'Auto-cancelling recording — no audio data after 4s');
          this.emit('trackEnded', diagnostics);
          this.clearMaxDurationTimeout();
          this.dropLive(recorder);
          recorder.cancel();
          this.nativeRecorder = null;
          this._isRecording = false;
          this.emit('recordingStopped');
        }
      }, 2000);
    });

    const start = { cancelled: false };
    this.nativeStart = start;
    try {
      await recorder.start(silenceTimeout);
    } finally {
      if (this.nativeStart === start) {
        this.nativeStart = undefined;
      }
    }
    if (start.cancelled) {
      // Escape came while the recorder was starting: nothing may record
      diagLog('RecorderManager', 'Recording was cancelled while the native recorder was starting — cancelling it');
      recorder.cancel();
      this.nativeRecorder = null;
      this._isRecording = false;
      return;
    }
    this._isRecording = true;
    diagLog('RecorderManager', `Started native recording, silenceTimeout=${silenceTimeout}s`);
    this.startLive(recorder);
    this.emit('recordingStarted');

    // Max duration enforcement — clear any stale timeout first
    this.clearMaxDurationTimeout();
    if (maxDuration > 0) {
      const startedAt = Date.now();
      this.maxDurationTimeout = setTimeout(() => {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        this.maxDurationTimeout = undefined;
        if (this._isRecording && this.nativeRecorder?.isRecording) {
          diagLog('RecorderManager', `Max duration reached after ${elapsed}s (limit=${maxDuration}s), auto-stopping`);
          this.emit('silenceDetected'); // Reuse silence signal to auto-stop
        } else {
          diagLog('RecorderManager', `Max duration timer fired after ${elapsed}s but recording already stopped — ignoring`);
        }
      }, maxDuration * 1000);
    }
  }

  private clearMaxDurationTimeout(): void {
    if (this.maxDurationTimeout) {
      diagLog('RecorderManager', 'Clearing max duration timeout');
      clearTimeout(this.maxDurationTimeout);
      this.maxDurationTimeout = undefined;
    }
  }

  /**
   * Stop and return the recording. `signal` is the transcription pipeline's:
   * a live transcription handed over with the audio is cancelled when it aborts.
   */
  async stopRecording(signal?: AbortSignal): Promise<RecordedAudio> {
    diagLog('RecorderManager', `stopRecording called. maxDurationTimeout=${this.maxDurationTimeout !== undefined ? 'SET' : 'NONE'}, isRecording=${this._isRecording}`);
    this.clearMaxDurationTimeout();

    // If audio data already arrived (e.g. track ended due to Bluetooth
    // disconnect), return it immediately instead of asking the webview.
    if (this.pendingAudioPayload) {
      const payload = this.pendingAudioPayload;
      this.pendingAudioPayload = undefined;
      this._isRecording = false;
      diagLog('RecorderManager', 'Returning pending audio payload from unsolicited stop');
      return payload;
    }

    // Native recording path
    const recorder = this.nativeRecorder;
    if (recorder?.isRecording) {
      this._isRecording = false;
      const live = this.takeLive(recorder);
      let result: AudioDataPayload;
      // It stops reading the file the recorder is about to delete, and from
      // now on belongs to the pipeline, whose Escape cancels it
      live?.detach(signal);
      try {
        result = await recorder.stop();
      } catch (error) {
        live?.cancel();
        throw error;
      }
      // A recording started while this one was stopping stays tracked, so
      // stop, Escape and dispose still reach it
      if (this.nativeRecorder === recorder) {
        this.nativeRecorder = null;
      }
      return live ? { ...result, live } : result;
    }

    if (!this._isRecording || !this.panel) {
      throw new Error('Not currently recording');
    }

    // Mark as not-recording immediately to prevent a concurrent stopRecording()
    // call from entering this code path and overwriting audioDataResolve/Reject.
    this._isRecording = false;

    return new Promise<AudioDataPayload>((resolve, reject) => {
      this.audioDataResolve = resolve;
      this.audioDataReject = reject;

      // Set a timeout in case the webview doesn't respond
      const timeout = setTimeout(() => {
        this.audioDataResolve = undefined;
        this.audioDataReject = undefined;
        this._isRecording = false;
        reject(new Error('Recording stop timed out after 10 seconds'));
      }, 10000);

      const originalResolve = this.audioDataResolve;
      this.audioDataResolve = (payload) => {
        clearTimeout(timeout);
        this.audioDataResolve = undefined;
        this.audioDataReject = undefined;
        originalResolve(payload);
      };
      const originalReject = this.audioDataReject;
      this.audioDataReject = (error) => {
        clearTimeout(timeout);
        this.audioDataResolve = undefined;
        this.audioDataReject = undefined;
        originalReject(error);
      };

      const message: MessageToWebview = { type: 'stopRecording' };
      this.panel!.webview.postMessage(message);
    });
  }

  cancelRecording(): void {
    this.clearMaxDurationTimeout();

    // The native recorder is still starting: its start cancels it as soon as
    // it runs, and keeps the claim until then so no second recorder starts
    if (this.nativeStart) {
      diagLog('RecorderManager', 'Cancel requested while the native recorder is starting');
      this.nativeStart.cancelled = true;
      return;
    }

    // Native recording path
    if (this.nativeRecorder?.isRecording) {
      this.dropLive(this.nativeRecorder);
      this.nativeRecorder.cancel();
      this.nativeRecorder = null;
      this._isRecording = false;
      return;
    }

    // Always reject a pending stopRecording() promise so the user isn't stuck
    // waiting for the timeout. stopRecording() sets _isRecording = false before
    // creating the promise, so we must check audioDataReject independently.
    if (this.audioDataReject) {
      this.audioDataReject(new Error('Recording cancelled'));
      this.audioDataResolve = undefined;
      this.audioDataReject = undefined;
    }

    if (!this._isRecording || !this.panel) {
      return;
    }

    this._isRecording = false;

    const message: MessageToWebview = { type: 'cancelRecording' };
    this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.cancelRecording();
    this.live?.session.cancel();
    this.live = undefined;
    if (this.nativeRecorder) {
      this.nativeRecorder.cancel();
      this.nativeRecorder = null;
    }
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.listeners.clear();
  }

  /** Start following a native recording that has just started, if live transcription is on. */
  private startLive(recorder: NativeRecorder): void {
    const file = recorder.outputFile;
    if (!this.liveFactory || !file) {
      return;
    }
    // A previous recording's transcription that was never handed over goes now
    this.live?.session.cancel();
    this.live = undefined;
    try {
      const session = this.liveFactory(file);
      if (session) {
        this.live = { recorder, session };
      }
    } catch (error) {
      diagLog('RecorderManager', `Live transcription not started: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Hand over the live transcription of `recorder`'s recording, if it has one. */
  private takeLive(recorder: NativeRecorder): LiveTranscription | undefined {
    if (this.live?.recorder !== recorder) {
      return undefined;
    }
    const { session } = this.live;
    this.live = undefined;
    return session;
  }

  /** `recorder`'s recording ends without transcription: so does its live transcription. */
  private dropLive(recorder: NativeRecorder): void {
    this.takeLive(recorder)?.cancel();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addListener(event: RecorderEvent, handler: (...args: any[]) => void): vscode.Disposable {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);

    return new vscode.Disposable(() => {
      const h = this.listeners.get(event);
      if (h) {
        const idx = h.indexOf(handler);
        if (idx >= 0) {
          h.splice(idx, 1);
        }
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emit(event: RecorderEvent, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (e) {
          console.error(`RecorderManager: error in ${event} handler`, e);
        }
      }
    }
  }

  private async ensurePanel(): Promise<void> {
    if (this.panel) {
      // Verify the panel is still alive by sending a ping
      try {
        await new Promise<void>((resolve, reject) => {
          this.readyResolve = resolve;
          const timeout = setTimeout(() => {
            this.readyResolve = undefined;
            reject(new Error('Panel not responding'));
          }, 3000);
          this.readyResolve = () => {
            clearTimeout(timeout);
            resolve();
          };
          this.panel!.webview.postMessage({ type: 'ping' } as MessageToWebview);
        });
        return;
      } catch {
        // Panel is dead, recreate it
        this.panel.dispose();
        this.panel = undefined;
      }
    }

    // Dispose stale panel-scoped listeners from a previous panel so they
    // don't accumulate across panel recreations.
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    const nonce = crypto.randomBytes(16).toString('hex');

    this.panel = vscode.window.createWebviewPanel(
      'codeDictatorRecorder',
      'Code Dictator: Recorder',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = getRecorderWebviewContent(nonce);

    // Handle messages from the webview
    const messageDisposable = this.panel.webview.onDidReceiveMessage(
      (message: MessageFromWebview) => {
        this.handleWebviewMessage(message);
      },
    );
    this.disposables.push(messageDisposable);

    // Handle panel disposal
    const disposeDisposable = this.panel.onDidDispose(() => {
      this.panel = undefined;
      if (this._isRecording) {
        this._isRecording = false;
        this.emit('error', 'Recording panel was closed');
        if (this.audioDataReject) {
          this.audioDataReject(new Error('Recording panel was closed'));
          this.audioDataResolve = undefined;
          this.audioDataReject = undefined;
        }
      }
    });
    this.disposables.push(disposeDisposable);

    // Wait for the webview to signal ready
    await new Promise<void>((resolve) => {
      // Timeout fallback — some webviews take a moment. Cleared on 'ready', so
      // it can't take the resolver of a later start's wait.
      const timeout = setTimeout(() => {
        this.readyResolve = undefined;
        resolve();
      }, 5000);
      this.readyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });

    // Hide the recorder tab — switch back to the user's active editor.
    // The webview stays alive thanks to retainContextWhenHidden: true.
    await vscode.commands.executeCommand('workbench.action.previousEditor');
  }

  private handleWebviewMessage(message: MessageFromWebview): void {
    switch (message.type) {
      case 'ready': {
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = undefined;
        }
        break;
      }
      case 'recordingStarted': {
        // Note: _isRecording is already set at the top of startRecording()
        // (before ensurePanel). Do NOT set it here — a late-arriving
        // recordingStarted (e.g. slow getUserMedia finishing after a stop/cancel)
        // would resurrect the flag and leave the extension in an inconsistent state.
        this.emit('recordingStarted');
        break;
      }
      case 'recordingStopped': {
        this.emit('recordingStopped');
        break;
      }
      case 'audioData': {
        const buffer = Buffer.from(message.data, 'base64');
        const payload: AudioDataPayload = {
          buffer,
          mimeType: message.mimeType,
          durationMs: message.durationMs,
        };
        this.emit('audioData', payload);
        if (this.audioDataResolve) {
          // Normal path: stopRecording() is waiting for this data.
          this._isRecording = false;
          this.audioDataResolve(payload);
          this.audioDataResolve = undefined;
          this.audioDataReject = undefined;
        } else {
          // Unsolicited audio data — e.g. Bluetooth device disconnected,
          // track ended, MediaRecorder auto-stopped. Store the payload and
          // signal the extension to trigger handleStopAndTranscribe().
          // Keep _isRecording = true so the silenceDetected guard passes.
          diagLog('RecorderManager', 'Unsolicited audioData received (track ended?), storing and signaling stop');
          this.pendingAudioPayload = payload;
          this.emit('trackEnded');
          this.emit('silenceDetected');
        }
        break;
      }
      case 'recordingError': {
        this._isRecording = false;
        if (this.permissionErrorHandler) {
          // During the permission-detection window: route to internal handler only,
          // so external onError listeners don't show a premature error popup.
          this.permissionErrorHandler(message.message);
        } else {
          this.emit('error', message.message);
          if (this.audioDataReject) {
            this.audioDataReject(new Error(message.message));
            this.audioDataResolve = undefined;
            this.audioDataReject = undefined;
          }
        }
        break;
      }
      case 'silenceDetected': {
        diagLog('RecorderManager', 'silenceDetected received from webview');
        this.emit('silenceDetected');
        break;
      }
      case 'trackMuted': {
        // Mic track was muted (common with Bluetooth switching). The recording
        // continues but captures silence. Notify the user immediately.
        this.emit('trackEnded');
        break;
      }
      case 'diagnosticLog': {
        diagLog('Webview', message.message);
        break;
      }
    }
  }
}
