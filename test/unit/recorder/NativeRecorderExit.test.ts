import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The recorder process ends on its own (device unplugged, sound server
// restarted) instead of being stopped. spawn() is faked, so no recorder runs.
const spawned = vi.hoisted(() => ({ children: [] as EventEmitter[] }));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      // A recorder writing a file: stdin and stdout ignored, stderr piped
      const child = Object.assign(new EventEmitter(), {
        stdin: null,
        stdout: null,
        stderr: new EventEmitter(),
        killed: false,
        kill: vi.fn(() => true),
      });
      spawned.children.push(child);
      return child;
    }),
  };
});

import { NativeRecorder } from '../../../src/recorder/NativeRecorder';

// The fake clock below names the recording code-dictator-981173106789.wav,
// a timestamp no real recording has.
const NOW = new Date('2001-02-03T04:05:06.789Z');
const FILE = path.join(os.tmpdir(), `code-dictator-${NOW.getTime()}.wav`);

/** A WAV as the recorder writes it: 44-byte header, then 16 kHz mono PCM. */
function wav(seconds: number): Buffer {
  const data = Buffer.alloc(Math.round(seconds * 32000));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  return Buffer.concat([header, data]);
}

async function startRecording(recorder: NativeRecorder): Promise<EventEmitter> {
  const started = recorder.start(0);
  await vi.advanceTimersByTimeAsync(150); // the startup window
  await started;
  return spawned.children[0];
}

describe('NativeRecorder: a recorder process that ends on its own', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(NativeRecorder, 'detectTool').mockReturnValue({ name: 'parecord', command: 'parecord' });
    spawned.children.length = 0;
  });

  afterEach(() => {
    fs.rmSync(FILE, { force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('deletes the partial recording when the process dies mid-recording', async () => {
    const recorder = new NativeRecorder();
    const onExit = vi.fn(() => {
      expect(fs.existsSync(FILE)).toBe(false); // gone before anyone is told
    });
    recorder.setUnexpectedExitHandler(onExit);
    const child = await startRecording(recorder);
    fs.writeFileSync(FILE, wav(2)); // what the recorder had captured

    child.emit('close', 1, null);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(recorder.isRecording).toBe(false);
  });

  it('deletes the file of a recorder that exits during startup', async () => {
    const recorder = new NativeRecorder();
    const started = recorder.start(0);
    started.catch(() => { /* asserted below */ });
    fs.writeFileSync(FILE, wav(0)); // parecord creates its output file before it connects

    spawned.children[0].emit('close', 1, null);

    await expect(started).rejects.toThrow('Recording process exited immediately (code=1).');
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('a stop still returns the recording, then deletes the file', async () => {
    const recorder = new NativeRecorder();
    const onExit = vi.fn();
    recorder.setUnexpectedExitHandler(onExit);
    const child = await startRecording(recorder);
    const audio = wav(2);
    fs.writeFileSync(FILE, audio);

    const stopping = recorder.stop();
    child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(100); // flush delay before the file is read

    await expect(stopping).resolves.toMatchObject({ buffer: audio, mimeType: 'audio/wav' });
    expect(onExit).not.toHaveBeenCalled();
    expect(fs.existsSync(FILE)).toBe(false);
  });
});
