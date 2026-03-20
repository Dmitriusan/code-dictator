import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { AudioIsolation, MessageFromWebview, MessageToWebview } from '../types';
import { getRecorderWebviewContent } from './RecorderWebviewContent';
import { NativeRecorder, type AudioDiagnostics } from './NativeRecorder';
import { diagLog } from '../DiagnosticLog';

type RecorderEvent = 'recordingStarted' | 'recordingStopped' | 'audioData' | 'error' | 'silenceDetected' | 'trackEnded';

interface AudioDataPayload {
  buffer: Buffer;
  mimeType: string;
  durationMs: number;
}

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

  constructor(private readonly extensionUri: vscode.Uri) {}

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
      return;
    }

    // Claim recording state immediately to prevent concurrent startRecording()
    // calls from racing through the ensurePanel() async gap (TOCTOU fix).
    this._isRecording = true;

    // Primary: webview MediaRecorder (uses PulseAudio/PipeWire, works everywhere)
    diagLog('RecorderManager', 'Trying webview recorder path');
    try {
      await this.ensurePanel();

      // Start recording with a short timeout to detect errors quickly.
      // We intercept ALL webview errors during the startup window so they don't
      // reach external onError listeners (which would show an error popup before
      // the native fallback gets a chance to run).
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

        // Give the webview 2s to fail or succeed
        setTimeout(() => {
          this.permissionErrorHandler = undefined;
          resolve();
        }, 2000);
      });
    } catch (webviewError) {
      // Webview recording failed — try native fallback (arecord/sox)
      this.permissionErrorHandler = undefined;
      this._isRecording = false;
      if (this.panel) {
        this.panel.webview.postMessage({ type: 'cancelRecording' } as MessageToWebview);
      }

      const errorMsg = webviewError instanceof Error ? webviewError.message : String(webviewError);
      diagLog('RecorderManager', `Webview recorder failed: ${errorMsg}`);

      if (NativeRecorder.isAvailable()) {
        diagLog('RecorderManager', 'Falling back to native recorder');
        return this.startNativeRecording(silenceTimeout, maxDuration);
      }

      throw new Error(
        `Microphone unavailable: ${errorMsg}. Please check your audio devices, or install arecord (Linux) / sox (macOS/Windows).`
      );
    }
  }

  private async startNativeRecording(silenceTimeout: number, maxDuration: number): Promise<void> {
    this.nativeRecorder = new NativeRecorder();

    // If the native process exits unexpectedly, stop recording and report
    this.nativeRecorder.setUnexpectedExitHandler(() => {
      diagLog('RecorderManager', 'Native recorder exited unexpectedly — stopping');
      this._isRecording = false;
      this.emit('error', 'Recording process exited unexpectedly. Enable diagnostic logging in settings for details.');
    });

    // Wire up silence detection
    if (silenceTimeout > 0) {
      this.nativeRecorder.setSilenceHandler(() => {
        diagLog('RecorderManager', 'Native recorder silence detected, auto-stopping');
        this.emit('silenceDetected');
      });
    }

    // Warn early if mic isn't producing any audio data, then auto-cancel
    // after 2 more seconds. We cancel (SIGKILL) rather than stop+transcribe
    // because parecord connected to an errored PipeWire stream can hang on
    // SIGTERM, and there's nothing to transcribe anyway.
    this.nativeRecorder.setNoAudioDataHandler((diagnostics) => {
      this.emit('trackEnded', diagnostics);
      setTimeout(() => {
        if (this._isRecording && this.nativeRecorder) {
          diagLog('RecorderManager', 'Auto-cancelling recording — no audio data after 4s');
          this.clearMaxDurationTimeout();
          this.nativeRecorder.cancel();
          this.nativeRecorder = null;
          this._isRecording = false;
          this.emit('recordingStopped');
        }
      }, 2000);
    });

    await this.nativeRecorder.start(silenceTimeout);
    this._isRecording = true;
    diagLog('RecorderManager', `Started native recording, silenceTimeout=${silenceTimeout}s`);

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

  async stopRecording(): Promise<AudioDataPayload> {
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
    if (this.nativeRecorder?.isRecording) {
      this._isRecording = false;
      const result = await this.nativeRecorder.stop();
      this.nativeRecorder = null;
      return result;
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
        reject(new Error('Recording stop timed out after 30 seconds'));
      }, 30000);

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

    // Native recording path
    if (this.nativeRecorder?.isRecording) {
      this.nativeRecorder.cancel();
      this.nativeRecorder = null;
      this._isRecording = false;
      return;
    }

    if (!this._isRecording || !this.panel) {
      return;
    }

    this._isRecording = false;

    // Reject any pending promise
    if (this.audioDataReject) {
      this.audioDataReject(new Error('Recording cancelled'));
      this.audioDataResolve = undefined;
      this.audioDataReject = undefined;
    }

    const message: MessageToWebview = { type: 'cancelRecording' };
    this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.cancelRecording();
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
      this.readyResolve = resolve;
      // Timeout fallback — some webviews take a moment
      setTimeout(() => {
        if (this.readyResolve) {
          this.readyResolve = undefined;
          resolve();
        }
      }, 5000);
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
