import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// With silence auto-stop on, parecord and arecord stream raw samples to
// stdout and the recorder writes them to its temp WAV itself. That file has
// to be closed however the recording ends, and a write that fails (disk full)
// must not go unhandled. spawn() is faked, so no recorder runs; the file is
// written for real, in the OS temp dir.
interface FakeRecorder extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}
const spawned = vi.hoisted(() => ({ children: [] as FakeRecorder[] }));
/** The streams the recorder opened, oldest first. */
const opened = vi.hoisted(() => ({ streams: [] as import('fs').WriteStream[] }));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));
vi.mock('../../../src/DiagnosticLog', () => ({ diagLog: vi.fn() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createWriteStream: vi.fn((...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      opened.streams.push(stream);
      return stream;
    }),
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      // A recorder streaming to stdout: stdin ignored, stdout and stderr piped
      const child = Object.assign(new EventEmitter(), {
        stdin: null,
        stdout: new EventEmitter(),
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

// The fake clock names the recording code-dictator-981173107123.wav, a
// timestamp no real recording has, nor the other recorder tests' files (test
// files run at the same time). Only Date is faked: the file is written with
// real I/O, which the stop waits for.
const NOW = new Date('2001-02-03T04:05:07.123Z');
const FILE = path.join(os.tmpdir(), `code-dictator-${NOW.getTime()}.wav`);

/** 100 ms of a quiet tone as 16-bit mono 16 kHz PCM, as parecord delivers it. */
function samples(): Buffer {
  const chunk = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) {
    chunk.writeInt16LE(i % 2 === 0 ? 1000 : -1000, i * 2);
  }
  return chunk;
}

async function startStreaming(recorder: NativeRecorder): Promise<FakeRecorder> {
  await recorder.start(5); // silence auto-stop on: parecord streams to stdout
  return spawned.children[0];
}

/** Resolves once the stream has closed its file. */
function closed(stream: fs.WriteStream): Promise<void> {
  return stream.closed ? Promise.resolve() : new Promise((resolve) => stream.once('close', () => resolve()));
}

describe('NativeRecorder: the file a streamed recording is written to', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(NativeRecorder, 'detectTool').mockReturnValue({ name: 'parecord', command: 'parecord' });
    spawned.children.length = 0;
    opened.streams.length = 0;
  });

  afterEach(async () => {
    await Promise.all(opened.streams.map((stream) => {
      stream.destroy();
      return closed(stream);
    }));
    fs.rmSync(FILE, { force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is closed when the recording is cancelled', async () => {
    const recorder = new NativeRecorder();
    const child = await startStreaming(recorder);
    child.stdout.emit('data', samples());
    const [stream] = opened.streams;

    recorder.cancel();

    expect(stream.destroyed).toBe(true);
    await closed(stream);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('is closed when the recorder process ends on its own', async () => {
    const recorder = new NativeRecorder();
    const onExit = vi.fn();
    recorder.setUnexpectedExitHandler(onExit);
    const child = await startStreaming(recorder);
    child.stdout.emit('data', samples());
    const [stream] = opened.streams;

    child.emit('close', 1, null);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(stream.destroyed).toBe(true);
    await closed(stream);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('takes no audio the killed process still sends after a cancel', async () => {
    const recorder = new NativeRecorder();
    const child = await startStreaming(recorder);
    recorder.cancel();

    expect(() => child.stdout.emit('data', samples())).not.toThrow();
    expect(recorder.hasReceivedAudio()).toBe(false);
  });

  it('still gives a stop the whole recording, then deletes the file', async () => {
    const recorder = new NativeRecorder();
    const child = await startStreaming(recorder);
    const audio = Buffer.concat([samples(), samples()]);
    child.stdout.emit('data', audio.subarray(0, 3200));
    child.stdout.emit('data', audio.subarray(3200));

    const stopping = recorder.stop();
    child.emit('close', null, 'SIGTERM');
    const { buffer } = await stopping;

    expect(buffer.length).toBe(44 + audio.length);
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buffer.readUInt32LE(40)).toBe(audio.length); // the data size, fixed at the stop
    expect(buffer.subarray(44)).toEqual(audio);
    expect(opened.streams[0].destroyed).toBe(true);
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('turns a failed write into an error at the stop, not an unhandled one or a cut-off recording', async () => {
    const recorder = new NativeRecorder();
    const child = await startStreaming(recorder);
    child.stdout.emit('data', samples());
    const [stream] = opened.streams;
    // What fs does when a write fails: the stream is destroyed with the error
    stream.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    await closed(stream);
    child.stdout.emit('data', samples()); // the recorder keeps sending

    const stopping = recorder.stop();
    child.emit('close', null, 'SIGTERM');

    await expect(stopping).rejects.toThrow(`Could not write the recording to ${os.tmpdir()}: ENOSPC: no space left on device, write`);
    expect(fs.existsSync(FILE)).toBe(false);
    expect(recorder.isRecording).toBe(false);
  });
});
