/**
 * Stand-in for parecord, pw-record and arecord in the e2e suite. It never
 * opens an audio device: it synthesises 16 kHz s16le mono PCM and writes it
 * where the real tool would, so NativeRecorder runs its normal code path.
 *
 * The suite puts small shell wrappers with the tools' names into a private
 * directory, makes that directory the extension host's whole PATH, and the
 * wrappers exec this file with the editor's own binary in Node mode
 * (ELECTRON_RUN_AS_NODE=1). CD_FAKE_DIR names the directory with the `mode`
 * file (what to produce) and markers.jsonl (one JSON line per start, write,
 * signal and exit, with pids, so a test can prove what ran and how it ended).
 *
 * File output (the last argument) is written in full at start, so its content
 * does not depend on timing. --raw output streams 100 ms chunks in real time,
 * as the silence detection expects.
 *
 * The `dictation` mode is the exception: it streams a long dictation into the
 * file as it goes, the way parecord does through libsndfile (a header that
 * declares no data, sizes filled in when the recorder is stopped), at
 * DICTATION_SPEED times real time so the suite does not wait a minute for a
 * minute of speech. Its "wrote" marker comes at the stop, with the final
 * file's hashes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type Mode = 'tone' | 'silence' | 'quiet-start' | 'short' | 'no-data' | 'exit-later' | 'exit-immediately' | 'dictation';

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
/** Nothing in the suite records this long; a forgotten fake ends itself. */
const MAX_LIFETIME_MS = 60_000;
/** Audio seconds the dictation mode produces per second of wall-clock time. */
const DICTATION_SPEED = 8;
/** Where the dictation pauses for DICTATION_PAUSE_S, in audio seconds; elsewhere words are 0.15 s apart. */
const DICTATION_PAUSES_S = [41, 63, 85, 107, 129, 151, 173, 195, 217, 239];
const DICTATION_PAUSE_S = 1.2;

const dir = process.env.CD_FAKE_DIR ?? '';
const tool = process.env.CD_FAKE_TOOL ?? path.basename(process.argv[1] ?? 'fake');
const args = process.argv.slice(2);
const mode = readMode();
const parentPid = currentParentPid();

function readMode(): Mode {
  try {
    return fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() as Mode;
  } catch {
    return 'tone';
  }
}

function mark(event: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, tool, event, ...extra });
  fs.appendFileSync(path.join(dir, 'markers.jsonl'), line + '\n');
}

/** The live parent pid: it changes when the extension host dies and this process is re-parented. */
function currentParentPid(): number {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return process.ppid;
  }
}

/** A sine at the given RMS level (dBFS), or digital silence for -Infinity. */
function tone(seconds: number, dbfs: number): Buffer {
  const samples = Math.round(SAMPLE_RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = dbfs === -Infinity ? 0 : 10 ** (dbfs / 20) * Math.SQRT2 * 32767;
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), i * 2);
  }
  return pcm;
}

/** Low-level noise, like a quiet room. */
function ambient(seconds: number, dbfs: number): Buffer {
  const samples = Math.round(SAMPLE_RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = 10 ** (dbfs / 20) * Math.sqrt(3) * 32767;
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * (Math.random() * 2 - 1)), i * 2);
  }
  return pcm;
}

function wav(pcm: Buffer, declaredBytes = pcm.length): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + declaredBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(declaredBytes, 40);
  return Buffer.concat([header, pcm]);
}

function sha1(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/**
 * 100 ms of a dictation: 0.3 s of device spin-up zeros, then 2.1 s "words"
 * (a -20 dBFS tone) 0.15 s apart in room noise (-55 dBFS), with a 1.2 s pause
 * at each of DICTATION_PAUSES_S.
 */
function dictationChunk(index: number): Buffer {
  const seconds = CHUNK_MS / 1000;
  const at = Math.round(index * seconds * 10) / 10;
  if (at < 0.3) {
    return tone(seconds, -Infinity);
  }
  const pause = DICTATION_PAUSES_S.find((p) => at >= p && at < p + DICTATION_PAUSE_S);
  if (pause !== undefined) {
    return ambient(seconds, -55);
  }
  // Words and their short gaps, counted from the end of the last long pause
  const since = DICTATION_PAUSES_S.filter((p) => at >= p + DICTATION_PAUSE_S).pop();
  const t = (at - (since === undefined ? 0.3 : since + DICTATION_PAUSE_S)) % 2.25;
  return t >= 2.1 - 1e-9 ? ambient(seconds, -55) : tone(seconds, -20);
}

/** What the recording "contains" in file mode. */
function fileContent(): Buffer {
  switch (mode) {
    case 'silence':
      return wav(tone(2, -Infinity));
    case 'quiet-start':
      return wav(Buffer.concat([tone(1.5, -Infinity), tone(1, -20)]));
    case 'short':
      return wav(tone(0.01, -Infinity));
    case 'no-data':
      return wav(Buffer.alloc(0));
    default:
      return wav(tone(2, -15));
  }
}

/** Stream mode: device spin-up zeros, room noise, "speech", then room noise until stopped. */
function streamChunk(index: number): Buffer | undefined {
  const seconds = CHUNK_MS / 1000;
  switch (mode) {
    case 'no-data':
      return undefined;
    case 'silence':
      return tone(seconds, -Infinity);
    case 'quiet-start':
      return index < 15 ? tone(seconds, -Infinity) : tone(seconds, -20);
    default:
      if (index < 3) {
        return tone(seconds, -Infinity);
      }
      return index >= 13 && index < 28 ? tone(seconds, -20) : ambient(seconds, -55);
  }
}

function exit(code: number, reason: string): never {
  mark('exit', { code, reason });
  process.exit(code);
}

function main(): void {
  const raw = args.includes('--raw') || args.some((a, i) => a === '-t' && args[i + 1] === 'raw');
  const output = raw ? 'stdout' : args[args.length - 1];
  mark('start', { mode, args, output, ppid: parentPid });
  if (mode === 'exit-immediately') {
    // The wrappers answer this mode in the shell, well inside NativeRecorder's 150 ms startup window
    process.stderr.write('Connection failure: Connection refused\n');
    exit(1, 'exit-immediately');
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      mark('signal', { signal });
      exit(0, signal);
    });
  }
  // ffmpeg is stopped with "q" on stdin
  process.stdin.on('data', (data: Buffer) => {
    if (data.toString().includes('q')) {
      mark('signal', { signal: 'stdin-q' });
      exit(0, 'stdin-q');
    }
  });
  process.stdout.on('error', () => exit(0, 'stdout-closed'));

  const streaming = mode === 'dictation' && !raw && Boolean(output);
  if (!raw && output && !streaming) {
    const content = fileContent();
    fs.writeFileSync(output, content);
    mark('wrote', { bytes: content.length, sha1: sha1(content) });
  }
  const pcm: Buffer[] = [];
  let fd: number | undefined;
  if (streaming) {
    fd = fs.openSync(output, 'w');
    fs.writeSync(fd, wav(Buffer.alloc(0), 0)); // like libsndfile: no data declared until the file is closed
  }
  /** Fill in the sizes, as libsndfile does when parecord is stopped, and log what the file holds. */
  const finalize = () => {
    if (fd === undefined) {
      return;
    }
    const data = Buffer.concat(pcm);
    const header = wav(Buffer.alloc(0), data.length);
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    fd = undefined;
    const content = Buffer.concat([header, data]);
    mark('wrote', { bytes: content.length, sha1: sha1(content), pcmBytes: data.length, pcmSha1: sha1(data), audioMs: Math.round(data.length / 32) });
  };
  process.on('exit', finalize);

  const startedAt = Date.now();
  let chunks = 0;
  setInterval(() => {
    if (raw || streaming) {
      // Write every chunk the clock says is due by now
      const speed = mode === 'dictation' ? DICTATION_SPEED : 1;
      const due = Math.floor(((Date.now() - startedAt) * speed) / CHUNK_MS) + 1;
      while (chunks < due) {
        const chunk = mode === 'dictation' ? dictationChunk(chunks++) : streamChunk(chunks++);
        if (!chunk) {
          continue;
        }
        if (streaming && fd !== undefined) {
          fs.writeSync(fd, chunk);
          pcm.push(chunk);
        } else if (raw) {
          process.stdout.write(chunk);
        }
      }
    }
    if (mode === 'exit-later' && Date.now() - startedAt >= 1000) {
      process.stderr.write('Stream error: Connection terminated\n');
      exit(1, 'exit-later');
    }
    if (currentParentPid() !== parentPid) {
      exit(0, 'orphaned');
    }
    if (Date.now() - startedAt > MAX_LIFETIME_MS) {
      exit(0, 'max-lifetime');
    }
  }, CHUNK_MS / 2);
}

main();
