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
  private stderrData = '';

  get isRecording(): boolean {
    return this._isRecording;
  }

  static detectTool(): NativeTool | null {
    const platform = process.platform;

    // arecord (Linux ALSA — usually pre-installed)
    if (platform === 'linux') {
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

  async start(): Promise<void> {
    if (this._isRecording) {
      throw new Error('Already recording');
    }

    const tool = NativeRecorder.detectTool();
    if (!tool) {
      throw new Error('No native recording tool found (arecord or sox)');
    }

    this.tempFile = path.join(os.tmpdir(), `code-dictator-${Date.now()}.wav`);

    let args: string[];
    if (tool.name === 'arecord') {
      args = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', this.tempFile];
    } else if (tool.command.endsWith('rec')) {
      args = ['-r', '16000', '-c', '1', '-b', '16', this.tempFile];
    } else {
      // sox with default input
      args = ['-d', '-r', '16000', '-c', '1', '-b', '16', this.tempFile];
    }

    return new Promise((resolve, reject) => {
      try {
        this.stderrData = '';
        this.process = spawn(tool.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        diagLog('NativeRecorder', `Spawned ${tool.command} ${args.join(' ')}`);

        // Capture stderr for diagnostics
        this.process.stderr?.on('data', (chunk: Buffer) => {
          this.stderrData += chunk.toString();
        });

        this.process.on('error', (err) => {
          diagLog('NativeRecorder', `Process error: ${err.message}`);
          this.cleanup();
          reject(new Error(`Failed to start recording: ${err.message}`));
        });

        // Detect unexpected process exit during active recording
        this.process.on('close', (code, signal) => {
          if (this._isRecording) {
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
          if (this.process && !this.process.killed) {
            this._isRecording = true;
            this.startTime = Date.now();
            diagLog('NativeRecorder', `Recording started with ${tool.name}`);
            resolve();
          }
        }, 150);
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  async stop(): Promise<{ buffer: Buffer; mimeType: string; durationMs: number }> {
    if (!this._isRecording || !this.process) {
      throw new Error('Not recording');
    }

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

        try {
          if (fs.existsSync(tempFile)) {
            const buffer = fs.readFileSync(tempFile);
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
    this.stderrData = '';
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
