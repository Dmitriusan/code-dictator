import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { diagLog } from '../DiagnosticLog';

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
  private tempFile: string | null = null;
  private _isRecording = false;
  private startTime = 0;
  private onUnexpectedExit: (() => void) | null = null;
  private onSilenceDetected: (() => void) | null = null;
  private onNoAudioData: (() => void) | null = null;
  private stderrData = '';
  private stoppingGracefully = false;
  private silenceTimeout = 0;
  private silenceStart: number | null = null;
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null;

  get isRecording(): boolean {
    return this._isRecording;
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

    // Fallback: check PATH
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

  async start(silenceTimeout = 0): Promise<void> {
    if (this._isRecording) {
      throw new Error('Already recording');
    }

    const tool = NativeRecorder.detectTool();
    if (!tool) {
      throw new Error('No native recording tool found (arecord or sox)');
    }

    this.silenceTimeout = silenceTimeout;
    this.tempFile = path.join(os.tmpdir(), `code-dictator-${Date.now()}.wav`);

    // When silence detection is needed, pipe stdout so we can analyze audio levels.
    // pw-record does NOT support stdout piping, so it always writes to file.
    const useStdoutPipe = silenceTimeout > 0 && (tool.name === 'arecord' || tool.name === 'parecord');

    let args: string[];
    if (tool.name === 'pw-record') {
      // pw-record always writes to file (no stdout pipe support)
      args = ['--format', 's16', '--rate', '16000', '--channels', '1', this.tempFile];
    } else if (tool.name === 'parecord') {
      if (useStdoutPipe) {
        // Output raw PCM to stdout for real-time analysis
        args = ['--format=s16le', '--rate=16000', '--channels=1', '--raw'];
      } else {
        args = ['--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', this.tempFile];
      }
    } else if (tool.name === 'arecord') {
      if (useStdoutPipe) {
        // Output raw PCM to stdout for real-time analysis
        args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-'];
      } else {
        args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', this.tempFile];
      }
    } else if (tool.command.endsWith('rec')) {
      args = ['-r', '16000', '-c', '1', '-b', '16', this.tempFile];
    } else {
      // sox with default input
      args = ['-d', '-r', '16000', '-c', '1', '-b', '16', this.tempFile];
    }

    return new Promise((resolve, reject) => {
      try {
        this.stderrData = '';
        let settled = false;
        this.process = spawn(tool.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        diagLog('NativeRecorder', `Spawned ${tool.command} ${args.join(' ')}`);

        // Capture stderr for diagnostics
        this.process.stderr?.on('data', (chunk: Buffer) => {
          this.stderrData += chunk.toString();
        });

        // If piping stdout, write raw PCM to file and analyze for silence
        if (useStdoutPipe) {
          const writeStream = fs.createWriteStream(this.tempFile);
          // Write WAV header (will be finalized on stop)
          writeStream.write(createWavHeader());
          let totalBytes = 0;
          let stdoutChunks = 0;

          this.process.stdout?.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
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
            if (this._isRecording && totalBytes === 0) {
              diagLog('NativeRecorder', 'No audio data received after 2s — mic may be unavailable');
              if (this.onNoAudioData) { this.onNoAudioData(); }
            }
          }, 2000);

          this.process.on('close', () => {
            diagLog('NativeRecorder', `Process closed. Total stdout: ${totalBytes} bytes in ${stdoutChunks} chunks`);
            writeStream.end();
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

      const handleClose = () => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);

        // Small delay to let the write stream flush
        setTimeout(() => {
          try {
            if (fs.existsSync(tempFile)) {
              const buffer = fs.readFileSync(tempFile);

              // Fix WAV header sizes if we wrote raw PCM with a placeholder header
              if (buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
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
        }, 100);
      };

      proc.on('close', handleClose);
      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);
        this.cleanup();
        reject(err);
      });

      // Graceful stop
      proc.kill('SIGTERM');

      // Force kill after 5s
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

  setNoAudioDataHandler(handler: () => void): void {
    this.onNoAudioData = handler;
  }

  getElapsedTime(): number {
    if (!this._isRecording) return 0;
    return Date.now() - this.startTime;
  }

  private cleanup(): void {
    this.process = null;
    this.tempFile = null;
    this._isRecording = false;
    this.startTime = 0;
    this.onUnexpectedExit = null;
    this.onSilenceDetected = null;
    this.onNoAudioData = null;
    this.stderrData = '';
    this.stoppingGracefully = false;
    this.silenceTimeout = 0;
    this.silenceStart = null;
    this.chunkCount = 0;
    this.noiseFloorEma = 0;
    this.speechPeakEma = -60;
    this.vadReady = false;
    this.hasSeenSpeech = false;
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
