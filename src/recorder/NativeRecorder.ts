import { spawn, execSync, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { diagLog } from '../DiagnosticLog';

export interface AudioDiagnostics {
  /** Human-readable explanation of why audio capture failed */
  reason: string;
  /** Actionable fix suggestion for the user */
  suggestion: string;
}

interface NativeTool {
  name: string;
  command: string;
}

/**
 * Native audio recorder fallback for Linux (and optionally macOS/Windows)
 * when the webview MediaRecorder doesn't have mic permissions.
 * Uses arecord (ALSA) or sox/rec if available.
 */
export class NativeRecorder {
  private process: ChildProcess | null = null;
  private toolName: string | null = null;
  private tempFile: string | null = null;
  private _isRecording = false;
  private startTime = 0;
  private onUnexpectedExit: (() => void) | null = null;
  private onSilenceDetected: (() => void) | null = null;
  private onNoAudioData: ((diagnostics: AudioDiagnostics) => void) | null = null;
  private stderrData = '';
  private stoppingGracefully = false;
  private writeStream: fs.WriteStream | null = null;
  private silenceTimeout = 0;
  private silenceStart: number | null = null;
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private totalBytesReceived = 0;

  get isRecording(): boolean {
    return this._isRecording;
  }

  /** True once at least one audio chunk has been received from the recorder process. */
  hasReceivedAudio(): boolean {
    return this.totalBytesReceived > 0;
  }

  static detectTool(): NativeTool | null {
    const platform = process.platform;

    // Linux: prefer PulseAudio/PipeWire tools over raw ALSA.
    // arecord talks directly to ALSA and cannot see Bluetooth devices,
    // which are routed through PulseAudio/PipeWire.
    if (platform === 'linux') {
      // parecord (PulseAudio CLI — works on both PulseAudio and PipeWire
      // via the PulseAudio compatibility layer. Supports stdout piping
      // with --raw, which pw-record does not.)
      try {
        execSync('which parecord', { stdio: 'ignore' });
        return { name: 'parecord', command: 'parecord' };
      } catch { /* not found */ }

      // pw-record (PipeWire native — does NOT support stdout piping,
      // so silence detection is unavailable with this tool)
      try {
        execSync('which pw-record', { stdio: 'ignore' });
        return { name: 'pw-record', command: 'pw-record' };
      } catch { /* not found */ }

      // arecord (ALSA fallback — no Bluetooth support)
      try {
        execSync('which arecord', { stdio: 'ignore' });
        return { name: 'arecord', command: 'arecord' };
      } catch { /* not found */ }
    }

    // Windows: prefer ffmpeg over sox — sox on Windows lacks a working
    // audio device driver, while ffmpeg uses DirectShow which works reliably.
    if (platform === 'win32') {
      const ffmpegPath = findExecutableWindows('ffmpeg');
      if (ffmpegPath) {
        return { name: 'ffmpeg', command: ffmpegPath };
      }
    }

    // sox/rec (cross-platform)
    if (platform === 'darwin') {
      // macOS: check Homebrew paths directly (VS Code doesn't inherit shell PATH)
      for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
        const recPath = path.join(dir, 'rec');
        if (isExecutable(recPath)) {
          return { name: 'sox', command: recPath };
        }
        const soxPath = path.join(dir, 'sox');
        if (isExecutable(soxPath)) {
          return { name: 'sox', command: soxPath };
        }
      }
    }

    // ffmpeg (cross-platform fallback, checked before sox since it's more reliable).
    // Windows handles ffmpeg above, so here `platform` is always non-win32 → `which`.
    if (platform !== 'win32') {
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
        return { name: 'ffmpeg', command: 'ffmpeg' };
      } catch { /* not found */ }
    }

    // Fallback: check PATH for sox/rec
    const recCmd = platform === 'win32' ? 'sox' : 'rec';
    const which = platform === 'win32' ? 'where' : 'which';
    try {
      execSync(`${which} ${recCmd}`, { stdio: 'ignore' });
      return { name: 'sox', command: recCmd };
    } catch { /* not found */ }

    try {
      execSync(`${which} sox`, { stdio: 'ignore' });
      return { name: 'sox', command: 'sox' };
    } catch { /* not found */ }

    return null;
  }

  static isAvailable(): boolean {
    return NativeRecorder.detectTool() !== null;
  }

  /**
   * Build the recorder process arguments for a given tool. All recorders are
   * configured for 16-bit mono 16 kHz PCM. Pure function (no side effects) so
   * the argument logic — including the parecord low-latency fix — is unit-testable.
   */
  static buildArgs(toolName: string, command: string, useStdoutPipe: boolean, tempFile: string): string[] {
    if (toolName === 'ffmpeg') {
      // ffmpeg: uses DirectShow on Windows, default device on macOS/Linux.
      // Writes WAV to file (no stdout pipe — ffmpeg writes headers at end);
      // it flushes on graceful 'q' shutdown, so it doesn't need a latency cap.
      const inputArgs = process.platform === 'win32'
        ? ['-f', 'dshow', '-i', `audio=${detectWindowsAudioDevice(command)}`]
        : ['-f', process.platform === 'darwin' ? 'avfoundation' : 'pulse', '-i', 'default'];
      return [
        ...inputArgs,
        '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
        '-y', tempFile,
      ];
    }

    if (toolName === 'pw-record') {
      // pw-record always writes to file (no stdout pipe support).
      return ['--format', 's16', '--rate', '16000', '--channels', '1', tempFile];
    }

    if (toolName === 'parecord') {
      // --latency-msec caps the PulseAudio/PipeWire capture buffer. Without it,
      // parecord negotiates a large (~1-2 s) record fragment, and on stop the
      // process is signalled and exits WITHOUT draining that buffer — so the
      // last 1-2 seconds of speech are silently dropped. Empirically (PipeWire,
      // 16 kHz mono): no flag → 1-2 s lost; --latency-msec=100 → ~0.1 s. Neither
      // SIGINT nor SIGTERM makes parecord flush, so a small capture buffer is the
      // only reliable fix. arecord/pw-record don't over-buffer and need no flag.
      const lowLatency = '--latency-msec=100';
      return useStdoutPipe
        // Output raw PCM to stdout for real-time silence analysis.
        ? [lowLatency, '--format=s16le', '--rate=16000', '--channels=1', '--raw']
        : [lowLatency, '--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', tempFile];
    }

    if (toolName === 'arecord') {
      return useStdoutPipe
        // Output raw PCM to stdout for real-time silence analysis.
        ? ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-']
        : ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', tempFile];
    }

    if (command.endsWith('rec')) {
      // sox's `rec` alias records from the default input device implicitly.
      return ['-r', '16000', '-c', '1', '-b', '16', tempFile];
    }

    // sox with explicit default input device (-d).
    return ['-d', '-r', '16000', '-c', '1', '-b', '16', tempFile];
  }

  async start(silenceTimeout = 0): Promise<void> {
    if (this._isRecording) {
      throw new Error('Already recording');
    }

    const tool = NativeRecorder.detectTool();
    if (!tool) {
      throw new Error('No native recording tool found (ffmpeg, arecord, or sox). On Windows, install ffmpeg: winget install Gyan.FFmpeg');
    }

    this.silenceTimeout = silenceTimeout;
    this.toolName = tool.name;
    this.tempFile = path.join(os.tmpdir(), `code-dictator-${Date.now()}.wav`);

    // When silence detection is needed, pipe stdout so we can analyze audio levels.
    // pw-record and ffmpeg do NOT support stdout piping for silence detection.
    const useStdoutPipe = silenceTimeout > 0 && (tool.name === 'arecord' || tool.name === 'parecord');

    const args = NativeRecorder.buildArgs(tool.name, tool.command, useStdoutPipe, this.tempFile);

    return new Promise((resolve, reject) => {
      try {
        this.stderrData = '';
        let settled = false;
        // When piping stdout for silence detection, we consume the stream in real-time.
        // When writing to file (pw-record, no-silence modes), use 'ignore' to avoid
        // pipe buffer deadlock on long recordings (OS pipe buffer is only 64KB).
        // ffmpeg needs stdin piped so we can send 'q' for graceful shutdown on Windows
        // (TerminateProcess/SIGINT kills it before it can flush WAV data to disk).
        const stdioOpt: ('ignore' | 'pipe')[] = useStdoutPipe
          ? ['ignore', 'pipe', 'pipe']
          : tool.name === 'ffmpeg'
            ? ['pipe', 'ignore', 'pipe']
            : ['ignore', 'ignore', 'pipe'];
        this.process = spawn(tool.command, args, { stdio: stdioOpt });
        diagLog('NativeRecorder', `Spawned ${tool.command} ${args.join(' ')}`);

        // Capture stderr for diagnostics (capped to prevent unbounded growth)
        this.process.stderr?.on('data', (chunk: Buffer) => {
          if (this.stderrData.length < 10000) {
            this.stderrData += chunk.toString();
          }
        });

        // If piping stdout, write raw PCM to file and analyze for silence.
        // tempFile is assigned above (before this Promise), so the non-null
        // assertion is safe — TS just can't carry the narrowing into the closure.
        if (useStdoutPipe) {
          this.writeStream = fs.createWriteStream(this.tempFile!);
          const writeStream = this.writeStream;
          // Write WAV header (will be finalized on stop)
          writeStream.write(createWavHeader());
          let stdoutChunks = 0;

          this.process.stdout?.on('data', (chunk: Buffer) => {
            this.totalBytesReceived += chunk.length;
            const totalBytes = this.totalBytesReceived;
            stdoutChunks++;
            writeStream.write(chunk);
            this.analyzeChunkForSilence(chunk);
            // Log first chunk and then every ~5 seconds (at 16kHz mono 16-bit ≈ 32KB/s)
            if (stdoutChunks === 1 || totalBytes % 160000 < chunk.length) {
              diagLog('NativeRecorder', `stdout data: chunk#${stdoutChunks}, chunkSize=${chunk.length}, totalBytes=${totalBytes}`);
            }
          });

          // Detect "no data flowing" — if mic is unavailable (e.g. Bluetooth
          // hijacked by phone), the process runs but stdout produces nothing.
          setTimeout(() => {
            if (this._isRecording && this.totalBytesReceived === 0) {
              const diag = NativeRecorder.diagnosePulseAudioSource();
              diagLog('NativeRecorder', `No audio data received after 2s — ${diag.reason}`);
              if (this.onNoAudioData) { this.onNoAudioData(diag); }
            }
          }, 2000);

          this.process.on('close', () => {
            diagLog('NativeRecorder', `Process closed. Total stdout: ${this.totalBytesReceived} bytes in ${stdoutChunks} chunks`);
            // writeStream is flushed and closed in stop() to avoid race conditions
          });
        }

        this.process.on('error', (err) => {
          diagLog('NativeRecorder', `Process error: ${err.message}`);
          settled = true;
          this.cleanup();
          reject(new Error(`Failed to start recording: ${err.message}`));
        });

        // Detect process exit — if it happens before the startup timer,
        // reject the promise instead of leaving _isRecording in a zombie state.
        this.process.on('close', (code, signal) => {
          if (!settled && !this._isRecording) {
            // Process exited during startup (before the 150ms timer)
            settled = true;
            diagLog('NativeRecorder', `Process exited during startup. code=${code}, signal=${signal}, stderr=${this.stderrData.trim()}`);
            this.cleanup();
            reject(new Error(`Recording process exited immediately (code=${code}). ${this.stderrData.trim()}`));
            return;
          }
          if (this._isRecording && !this.stoppingGracefully) {
            const elapsed = Math.round((Date.now() - this.startTime) / 1000);
            diagLog('NativeRecorder', `Process exited unexpectedly after ${elapsed}s. code=${code}, signal=${signal}, stderr=${this.stderrData.trim()}`);
            this._isRecording = false;
            if (this.onUnexpectedExit) {
              this.onUnexpectedExit();
            }
          }
        });

        // Give it a moment to start
        setTimeout(() => {
          if (!settled && this.process && !this.process.killed) {
            settled = true;
            this._isRecording = true;
            this.startTime = Date.now();
            diagLog('NativeRecorder', `Recording started with ${tool.name}, silenceTimeout=${silenceTimeout}s`);
            resolve();
          }
        }, 150);
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  private chunkCount = 0;

  // Adaptive VAD state
  private noiseFloorEma = 0;    // EMA of noise floor (dBFS)
  private speechPeakEma = -60;  // EMA of speech peaks (dBFS)
  private vadReady = false;     // True once we've seen both silence and speech
  private hasSeenSpeech = false;

  // EMA smoothing factors (α). Lower = smoother/slower adaptation.
  // Noise floor adapts slowly (tracks ambient drift), speech peak adapts moderately.
  private static readonly NOISE_ALPHA = 0.05;
  private static readonly SPEECH_ALPHA = 0.1;
  // Threshold is placed at this fraction between noise floor and speech peak (in dB).
  // 0.3 = closer to noise (more sensitive), 0.7 = closer to speech (less sensitive).
  private static readonly THRESHOLD_POSITION = 0.35;
  // Minimum dB gap between noise and speech before silence detection activates.
  // Prevents false triggers when noise and speech are indistinguishable.
  private static readonly MIN_SNR_DB = 6;
  // Absolute floor: anything below this dBFS is definitely silence regardless
  // of calibration. Set low (-90) to accommodate Bluetooth headsets and other
  // low-gain mics — e.g. BT mics can have speech at -72 dBFS and noise at -80.
  // The adaptive threshold handles normal silence detection; this only catches
  // truly dead/disconnected audio streams.
  private static readonly ABSOLUTE_SILENCE_DBFS = -90;

  /**
   * Analyze raw PCM S16_LE audio data for silence detection using adaptive VAD.
   *
   * Approach: Work in dBFS (decibels relative to full scale) for perceptually
   * meaningful comparisons. Maintain two exponential moving averages — one for
   * the noise floor (slow adaptation) and one for speech peaks (moderate adaptation).
   * The silence threshold is placed between them. This adapts to any mic gain,
   * ambient noise level, and speaker volume automatically.
   */
  private analyzeChunkForSilence(chunk: Buffer): void {
    if (this.silenceTimeout <= 0) return;

    const samples = chunk.length / 2;
    if (samples === 0) return;

    // Compute RMS amplitude
    let sumSquares = 0;
    for (let i = 0; i < chunk.length - 1; i += 2) {
      const sample = chunk.readInt16LE(i);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples);

    // Convert to dBFS (0 dBFS = full scale 32768)
    const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -96;

    this.chunkCount++;

    // Bootstrap: seed the noise floor EMA with the first chunk
    if (this.chunkCount === 1) {
      this.noiseFloorEma = dbfs;
      diagLog('NativeRecorder', `VAD init: first chunk dBFS=${dbfs.toFixed(1)}`);
      return;
    }

    // Classify this chunk: is it likely speech or noise?
    // A chunk significantly above the current noise floor is speech.
    const aboveFloor = dbfs - this.noiseFloorEma;
    const isSpeechChunk = aboveFloor > NativeRecorder.MIN_SNR_DB;

    if (isSpeechChunk) {
      // Update speech peak EMA
      this.speechPeakEma = this.speechPeakEma + NativeRecorder.SPEECH_ALPHA * (dbfs - this.speechPeakEma);
      if (!this.hasSeenSpeech) {
        this.hasSeenSpeech = true;
        this.speechPeakEma = dbfs; // Seed with first speech sample
        diagLog('NativeRecorder', `VAD: first speech detected at dBFS=${dbfs.toFixed(1)}, noiseFloor=${this.noiseFloorEma.toFixed(1)}`);
      }
    } else {
      // Update noise floor EMA (only when not speaking, so speech doesn't pull it up)
      this.noiseFloorEma = this.noiseFloorEma + NativeRecorder.NOISE_ALPHA * (dbfs - this.noiseFloorEma);
    }

    // Compute adaptive threshold: interpolate between noise floor and speech peak
    const snr = this.speechPeakEma - this.noiseFloorEma;
    const threshold = this.noiseFloorEma + snr * NativeRecorder.THRESHOLD_POSITION;

    // VAD is ready once we've seen speech and have a meaningful SNR
    if (!this.vadReady && this.hasSeenSpeech && snr >= NativeRecorder.MIN_SNR_DB) {
      this.vadReady = true;
      diagLog('NativeRecorder', `VAD ready: noiseFloor=${this.noiseFloorEma.toFixed(1)}dB, speechPeak=${this.speechPeakEma.toFixed(1)}dB, SNR=${snr.toFixed(1)}dB, threshold=${threshold.toFixed(1)}dB`);
    }

    // Log periodically
    if (this.chunkCount % 50 === 0) {
      diagLog('NativeRecorder', `VAD: dBFS=${dbfs.toFixed(1)}, floor=${this.noiseFloorEma.toFixed(1)}, speech=${this.speechPeakEma.toFixed(1)}, thr=${threshold.toFixed(1)}, SNR=${snr.toFixed(1)}, ready=${this.vadReady}`);
    }

    // Don't detect silence until we've calibrated by hearing actual speech
    if (!this.vadReady) return;

    const isSilent = dbfs < threshold || dbfs < NativeRecorder.ABSOLUTE_SILENCE_DBFS;

    if (isSilent) {
      if (this.silenceStart === null) {
        this.silenceStart = Date.now();
      } else {
        const silentMs = Date.now() - this.silenceStart;
        if (silentMs >= this.silenceTimeout * 1000) {
          diagLog('NativeRecorder', `Silence timeout: ${silentMs}ms silent, dBFS=${dbfs.toFixed(1)}, threshold=${threshold.toFixed(1)}`);
          this.silenceStart = null;
          if (this.onSilenceDetected) {
            this.onSilenceDetected();
          }
        }
      }
    } else {
      this.silenceStart = null;
    }
  }

  async stop(): Promise<{ buffer: Buffer; mimeType: string; durationMs: number }> {
    if (!this._isRecording || !this.process) {
      throw new Error('Not recording');
    }

    this.stoppingGracefully = true;
    const tempFile = this.tempFile!;
    const proc = this.process;
    const durationMs = Date.now() - this.startTime;
    diagLog('NativeRecorder', `Stopping recording after ${Math.round(durationMs / 1000)}s`);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let killTimeout: ReturnType<typeof setTimeout> | null = null;

      const readAndResolve = () => {
        try {
          if (fs.existsSync(tempFile)) {
            const buffer = fs.readFileSync(tempFile);

            // Fix WAV header sizes — only for stdout-piped recordings where
            // we wrote the placeholder header ourselves with a fixed 44-byte
            // layout. For tools like ffmpeg that write their own WAV files
            // and may include extra chunks (LIST/INFO) before the data chunk,
            // this fixup would corrupt a valid header. Only apply when we know
            // the layout is "44-byte header + raw PCM" (i.e. we wrote it).
            if (this.writeStream && buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
              const dataSize = buffer.length - 44;
              buffer.writeUInt32LE(dataSize + 36, 4); // RIFF chunk size
              buffer.writeUInt32LE(dataSize, 40);      // data chunk size
            }

            fs.unlinkSync(tempFile);
            this.cleanup();
            resolve({ buffer, mimeType: 'audio/wav', durationMs });
          } else {
            this.cleanup();
            reject(new Error('Recording file not found'));
          }
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      };

      const handleClose = () => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);

        // Wait for writeStream to flush all buffered data to disk
        let readDone = false;
        const readOnce = () => { if (!readDone) { readDone = true; readAndResolve(); } };
        if (this.writeStream) {
          this.writeStream.end(readOnce);
          // Safety timeout in case 'finish' callback never fires
          setTimeout(readOnce, 2000);
        } else {
          // File-based recording (no stdout pipe).
          // ffmpeg needs extra time after receiving 'q' to flush its write
          // buffers and finalize the WAV header before we read the file.
          const flushDelay = this.toolName === 'ffmpeg' ? 800 : 100;
          setTimeout(readOnce, flushDelay);
        }
      };

      proc.on('close', handleClose);
      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);
        this.cleanup();
        reject(err);
      });

      // Graceful stop signal depends on the tool:
      // - ffmpeg on Windows: send 'q\n' to stdin. On Windows, Node.js maps
      //   all signals to TerminateProcess() (immediate kill), so ffmpeg never
      //   gets a chance to flush its write buffers or finalize the WAV header,
      //   resulting in 0-byte or corrupt files. Sending 'q' via stdin triggers
      //   ffmpeg's own graceful shutdown path which properly closes the file.
      // - ffmpeg on Unix: SIGINT also works, but stdin 'q' is equally fine.
      // - sox/rec: SIGINT is the standard stop that flushes audio buffers.
      // - parecord/arecord/pw-record: SIGTERM is fine since we handle the
      //   WAV header ourselves (stdout-piped) or the header is already valid.
      if (this.toolName === 'ffmpeg' && proc.stdin) {
        try {
          proc.stdin.write('q');
          proc.stdin.end();
          diagLog('NativeRecorder', 'Sent q to ffmpeg stdin for graceful stop');
        } catch {
          // stdin closed or broken — fall back to signal
          try { proc.kill('SIGINT'); } catch { /* ignore */ }
        }
      } else {
        const stopSignal = this.toolName === 'sox' ? 'SIGINT' : 'SIGTERM';
        proc.kill(stopSignal);
      }

      // Force kill after 5s if the process hasn't exited gracefully.
      killTimeout = setTimeout(() => {
        if (!resolved) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          setTimeout(() => { if (!resolved) handleClose(); }, 2000);
        }
      }, 5000);
    });
  }

  cancel(): void {
    if (this.process) {
      // SIGKILL: unconditional immediate kill on all platforms.
      // Node.js maps this to TerminateProcess() on Windows.
      try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
    }
    if (this.tempFile && fs.existsSync(this.tempFile)) {
      try { fs.unlinkSync(this.tempFile); } catch { /* ignore */ }
    }
    this.cleanup();
  }

  setUnexpectedExitHandler(handler: () => void): void {
    this.onUnexpectedExit = handler;
  }

  setSilenceHandler(handler: () => void): void {
    this.onSilenceDetected = handler;
  }

  setNoAudioDataHandler(handler: (diagnostics: AudioDiagnostics) => void): void {
    this.onNoAudioData = handler;
  }

  getElapsedTime(): number {
    if (!this._isRecording) return 0;
    return Date.now() - this.startTime;
  }

  /**
   * Query PipeWire/PulseAudio for the default source state.
   * Returns a diagnostic with the reason and a user-actionable suggestion.
   */
  static diagnosePulseAudioSource(): AudioDiagnostics {
    if (process.platform !== 'linux') {
      return {
        reason: 'No audio data from microphone',
        suggestion: 'Check your microphone in OS sound settings.',
      };
    }

    try {
      // Get the default source name
      const defaultSource = execSync('pactl get-default-source 2>/dev/null', {
        timeout: 3000,
        encoding: 'utf-8',
      }).trim();

      if (!defaultSource) {
        return {
          reason: 'No default audio source configured',
          suggestion: 'Set a default microphone in your OS sound settings.',
        };
      }

      // Check if it's a monitor (output loopback), not a real mic
      if (defaultSource.includes('.monitor')) {
        return {
          reason: `Default source "${defaultSource}" is an output monitor, not a microphone`,
          suggestion: 'Select an actual microphone as default input in your OS sound settings.',
        };
      }

      // Query PipeWire node state — pw-cli info accepts node names directly.
      // Sanitise the source name to prevent shell injection (source names are
      // system-controlled, but defence-in-depth).
      const safeName = defaultSource.replace(/[^a-zA-Z0-9._:\-]/g, '_');
      const nodeInfo = execSync(`pw-cli info '${safeName}' 2>/dev/null`, {
        timeout: 3000,
        encoding: 'utf-8',
      });
      const stateMatch = nodeInfo.match(/state:\s*"(\w+)"(?:\s*"([^"]*)")?/);
      if (stateMatch) {
        const state = stateMatch[1];
        const stateDetail = stateMatch[2] || '';

        if (state === 'error') {
          return {
            reason: `Audio source is in error state: "${stateDetail}"`,
            suggestion: 'Restart your audio system: run "systemctl --user restart pipewire pipewire-pulse wireplumber" in a terminal.',
          };
        }
        if (state === 'suspended') {
          return {
            reason: 'Audio source is suspended (device may be disconnected or powered off)',
            suggestion: 'Check that your microphone is connected, or try switching to a different microphone in your OS sound settings.',
          };
        }
        diagLog('NativeRecorder', `PipeWire source state: ${state} ${stateDetail}`);
      }
    } catch {
      // pw-cli or pactl not available — fall through to generic message
    }

    return {
      reason: 'Microphone is not producing audio',
      suggestion: 'This commonly happens when a Bluetooth headset switches to another device. Try switching to a different microphone in your OS sound settings.',
    };
  }

  private cleanup(): void {
    this.process = null;
    this.toolName = null;
    this.tempFile = null;
    this._isRecording = false;
    this.startTime = 0;
    this.onUnexpectedExit = null;
    this.onSilenceDetected = null;
    this.onNoAudioData = null;
    this.stderrData = '';
    this.stoppingGracefully = false;
    this.writeStream = null;
    this.silenceTimeout = 0;
    this.silenceStart = null;
    this.chunkCount = 0;
    this.noiseFloorEma = 0;
    this.speechPeakEma = -60;
    this.vadReady = false;
    this.hasSeenSpeech = false;
    this.totalBytesReceived = 0;
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
      this.silenceCheckInterval = null;
    }
  }
}

/**
 * Create a WAV header for 16-bit mono 16kHz PCM.
 * Data size is set to max (will be truncated by actual file size on read).
 */
function createWavHeader(): Buffer {
  const header = Buffer.alloc(44);
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const maxDataSize = 0x7FFFFFFF - 36; // max possible

  header.write('RIFF', 0);
  header.writeUInt32LE(maxDataSize + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(maxDataSize, 40);

  return header;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable on Windows by checking PATH and common installation locations.
 * VS Code's Node process may not inherit the latest PATH changes (e.g. after
 * winget install), so we also probe well-known directories.
 */
function findExecutableWindows(name: string): string | null {
  // 1. Check PATH via 'where'
  try {
    const result = execSync(`where ${name}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 5000 });
    const firstLine = result.trim().split(/\r?\n/)[0];
    if (firstLine) return firstLine;
  } catch { /* not in PATH */ }

  // 2. Probe common installation directories (winget, choco, scoop, manual)
  const exe = `${name}.exe`;
  const home = os.homedir();
  const probePaths = [
    // winget packages
    path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
    // chocolatey
    path.join('C:', 'ProgramData', 'chocolatey', 'bin', exe),
    // scoop
    path.join(home, 'scoop', 'shims', exe),
    // manual install common paths
    path.join('C:', name, 'bin', exe),
    path.join('C:', 'Program Files', name, 'bin', exe),
    path.join('C:', 'Program Files', name, exe),
  ];

  // Also scan winget package directories for nested executables
  const wingetPkgs = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  try {
    const dirs = fs.readdirSync(wingetPkgs);
    for (const dir of dirs) {
      if (dir.toLowerCase().includes(name.toLowerCase())) {
        const pkgDir = path.join(wingetPkgs, dir);
        const found = findExeRecursive(pkgDir, exe, 3);
        if (found) {
          probePaths.unshift(found);
          break;
        }
      }
    }
  } catch { /* winget dir doesn't exist */ }

  for (const p of probePaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      diagLog('NativeRecorder', `Found ${name} at: ${p}`);
      return p;
    } catch { /* not found */ }
  }

  return null;
}

/** Recursively search for an exe file, limited to maxDepth levels. */
function findExeRecursive(dir: string, exe: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === exe.toLowerCase()) {
        return fullPath;
      }
      if (entry.isDirectory() && maxDepth > 1) {
        const found = findExeRecursive(fullPath, exe, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* permission error, etc. */ }
  return null;
}

/**
 * Detect the default Windows audio input device name for ffmpeg DirectShow.
 * Runs `ffmpeg -list_devices` and picks the first audio device.
 *
 * Uses spawnSync (not execSync) to avoid cmd.exe shell quoting issues
 * with long paths containing spaces (e.g. winget package directories).
 */
function detectWindowsAudioDevice(ffmpegCmd: string): string {
  const result = spawnSync(ffmpegCmd, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    timeout: 10000,
  });
  // ffmpeg writes device list to stderr (may exit 0 or 1 depending on version)
  const output = result.stderr?.toString() ?? '';
  if (output) {
    diagLog('NativeRecorder', `ffmpeg device list output (${output.length} chars)`);
    return parseAudioDeviceFromFfmpegOutput(output);
  }
  if (result.error) {
    diagLog('NativeRecorder', `ffmpeg device list error: ${result.error.message}`);
  }
  // Fallback: generic name that often works
  diagLog('NativeRecorder', 'Could not detect Windows audio device, using fallback "Microphone"');
  return 'Microphone';
}

function parseAudioDeviceFromFfmpegOutput(output: string): string {
  // Match lines like: [dshow] "Microphone (Realtek Audio)" (audio)
  // Also handles newer ffmpeg format: [in#0] "Device Name" (audio)
  const audioRegex = /]\s*"([^"]+)"\s*\(audio\)/g;
  let match;
  while ((match = audioRegex.exec(output)) !== null) {
    const deviceName = match[1];
    // Skip virtual/monitor devices
    if (!deviceName.toLowerCase().includes('monitor') && !deviceName.toLowerCase().includes('stereo mix')) {
      diagLog('NativeRecorder', `Detected Windows audio device: "${deviceName}"`);
      return deviceName;
    }
  }
  // If we only found monitor devices, return the first one anyway
  audioRegex.lastIndex = 0;
  match = audioRegex.exec(output);
  if (match) {
    return match[1];
  }
  diagLog('NativeRecorder', 'No audio devices found in ffmpeg output');
  return 'Microphone';
}
