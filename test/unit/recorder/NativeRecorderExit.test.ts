import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The recorder process ends on its own (device unplugged, sound server
// restarted) instead of being stopped. spawn() is faked, so no recorder runs.
/** What the faked spawn() returns: it emits 'close', and its stderr emits 'data'. */
interface FakeRecorder extends EventEmitter {
  stderr: EventEmitter;
}
const spawned = vi.hoisted(() => ({ children: [] as FakeRecorder[] }));

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));
vi.mock('../../../src/DiagnosticLog', () => ({ diagLog: vi.fn() }));

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
import { diagLog } from '../../../src/DiagnosticLog';

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

async function startRecording(recorder: NativeRecorder): Promise<FakeRecorder> {
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

describe("NativeRecorder: the recorder's stderr when it ends on its own", () => {
  const EXITED = 'Recording process exited immediately (code=1).';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(NativeRecorder, 'detectTool').mockReturnValue({ name: 'parecord', command: 'parecord' });
    spawned.children.length = 0;
    vi.mocked(diagLog).mockClear();
  });

  afterEach(() => {
    fs.rmSync(FILE, { force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Start a recorder that writes these pieces to stderr and exits with code 1; resolves to the start's error. */
  async function startupError(...stderr: string[]): Promise<string> {
    const started = new NativeRecorder().start(0);
    const outcome = started.then(() => 'the start succeeded', (error: Error) => error.message);
    const child = spawned.children.at(-1)!;
    for (const piece of stderr) {
      child.stderr.emit('data', Buffer.from(piece));
    }
    child.emit('close', 1, null);
    return outcome;
  }

  function logged(): string {
    return vi.mocked(diagLog).mock.calls.map(([, text]) => text).join('\n');
  }

  it('adds what the recorder wrote to the startup error', async () => {
    expect(await startupError('Connection failure: Connection refused\n'))
      .toBe(`${EXITED} Connection failure: Connection refused`);
  });

  it('puts stderr that arrives in pieces back together', async () => {
    expect(await startupError('Connection fail', 'ure: Connection refused\n'))
      .toBe(`${EXITED} Connection failure: Connection refused`);
  });

  it('shows stderr as one line', async () => {
    const message = await startupError('pa_context_connect() failed:\r\n\tConnection  refused\n\n', 'Error opening\u0007 input\n');

    expect(message).toBe(`${EXITED} pa_context_connect() failed: Connection refused Error opening input`);
  });

  it('adds nothing when the recorder wrote nothing', async () => {
    expect(await startupError()).toBe(EXITED);
  });

  it('adds nothing when the recorder wrote only blank lines', async () => {
    expect(await startupError('\n \n\t\n')).toBe(EXITED);
  });

  it('keeps a stderr of 300 characters whole', async () => {
    const stderr = `${'a'.repeat(100)} ${'b'.repeat(199)}`;

    expect(stderr).toHaveLength(300);
    expect(await startupError(stderr)).toBe(`${EXITED} ${stderr}`);
  });

  it('cuts a longer stderr from the front and keeps 300 characters in all', async () => {
    const banner = 'x'.repeat(1000); // ffmpeg prints its build configuration first
    const reason = 'Error opening input: Connection refused';

    const message = await startupError(`${banner}\n${reason}\n`);

    const tail = message.slice(`${EXITED} `.length);
    expect(message.startsWith(`${EXITED} …x`)).toBe(true);
    expect(tail).toHaveLength(300);
    expect(tail.endsWith(` ${reason}`)).toBe(true);
  });

  it('cuts the first character that does not fit, not one more', async () => {
    const stderr = 'a' + 'b'.repeat(300);

    expect(await startupError(stderr)).toBe(`${EXITED} …${'b'.repeat(299)}`);
  });

  it('logs all of stderr, not only the end', async () => {
    const stderr = `${'x'.repeat(1000)}\nConnection failure: Connection refused`;

    await startupError(stderr, '\n');

    expect(logged()).toContain(`Process exited during startup. code=1, signal=null, stderr=${stderr}`);
  });

  it('logs the stderr of a recorder that dies mid-recording', async () => {
    const child = await startRecording(new NativeRecorder());

    child.stderr.emit('data', Buffer.from('Stream error: Connection terminated\n'));
    child.emit('close', 1, null);

    expect(logged()).toContain('code=1, signal=null, stderr=Stream error: Connection terminated');
  });
});
