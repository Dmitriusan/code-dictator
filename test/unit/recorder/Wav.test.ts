import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWav, isPcm16, parseWavLayout, wavDataEnd } from '../../../src/recorder/Wav';
import { GrowingWavFile } from '../../../src/recorder/GrowingWavFile';

const MONO_16K = { channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2 };

/** RIFF chunk with id and body, padded to an even length. */
function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function fmtBody(format = 1, channels = 1, rate = 16000, bits = 16): Buffer {
  const body = Buffer.alloc(16);
  body.writeUInt16LE(format, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(rate, 4);
  body.writeUInt32LE(rate * channels * bits / 8, 8);
  body.writeUInt16LE(channels * bits / 8, 12);
  body.writeUInt16LE(bits, 14);
  return body;
}

/** A WAV as recorders write it while recording: a data chunk declaring `declared` bytes. */
function wavWith(chunks: Buffer[], dataDeclared: number, pcm: Buffer): Buffer {
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(dataDeclared, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(0, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, ...chunks, dataHeader, pcm]);
}

describe('parseWavLayout', () => {
  it('reads the plain 44-byte header buildWav writes', () => {
    const pcm = Buffer.alloc(320);
    const layout = parseWavLayout(buildWav(MONO_16K, pcm));
    expect(layout).toEqual({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2, dataStart: 44, declaredDataSize: 320 });
    expect(isPcm16(layout!)).toBe(true);
  });

  it('finds the data after a LIST chunk, as ffmpeg writes it', () => {
    const list = chunk('LIST', Buffer.from('INFOISFT\u000e\u0000\u0000\u0000Lavf61.7.100\u0000\u0000', 'latin1'));
    const wav = wavWith([chunk('fmt ', fmtBody()), list], 0, Buffer.alloc(64));
    const layout = parseWavLayout(wav)!;
    expect(layout.dataStart).toBe(12 + 24 + list.length + 8);
    expect(wavDataEnd(layout, wav.length)).toBe(wav.length); // 0 declared: up to the end of the file
  });

  it('reads the sub-format of WAVE_FORMAT_EXTENSIBLE', () => {
    const body = Buffer.alloc(40);
    fmtBody(0xFFFE).copy(body);
    body.writeUInt16LE(22, 16); // cbSize
    body.writeUInt16LE(1, 24); // KSDATAFORMAT_SUBTYPE_PCM starts with 0x0001
    const layout = parseWavLayout(wavWith([chunk('fmt ', body)], 0, Buffer.alloc(4)))!;
    expect(layout.format).toBe(1);
    expect(isPcm16(layout)).toBe(true);
  });

  it('is null until the header is complete, and for what is not WAV', () => {
    const wav = buildWav(MONO_16K, Buffer.alloc(100));
    for (const length of [0, 11, 20, 36, 43]) {
      expect(parseWavLayout(wav.subarray(0, length))).toBeNull();
    }
    expect(parseWavLayout(wav.subarray(0, 44))?.dataStart).toBe(44);
    expect(parseWavLayout(Buffer.from('OggS\u0000\u0002 not a wav at all, really'))).toBeNull();
    // data before fmt: nothing says what the samples are
    expect(parseWavLayout(wavWith([], 0, Buffer.alloc(4)))).toBeNull();
  });

  it('trusts a declared size only when the file holds it', () => {
    const wav = wavWith([chunk('fmt ', fmtBody())], 0x7FFFFFDB, Buffer.alloc(100)); // NativeRecorder's placeholder
    const layout = parseWavLayout(wav)!;
    expect(wavDataEnd(layout, wav.length)).toBe(wav.length);
    const finished = Buffer.concat([wavWith([chunk('fmt ', fmtBody())], 40, Buffer.alloc(40)), chunk('LIST', Buffer.alloc(10))]);
    const done = parseWavLayout(finished)!;
    expect(wavDataEnd(done, finished.length)).toBe(done.dataStart + 40); // the trailing LIST is not audio
  });

  it('marks 8-bit, float and stereo-mismatched layouts as not 16-bit PCM', () => {
    expect(isPcm16(parseWavLayout(wavWith([chunk('fmt ', fmtBody(1, 1, 16000, 8))], 0, Buffer.alloc(2)))!)).toBe(false);
    expect(isPcm16(parseWavLayout(wavWith([chunk('fmt ', fmtBody(3, 1, 16000, 32))], 0, Buffer.alloc(4)))!)).toBe(false);
    expect(isPcm16(parseWavLayout(wavWith([chunk('fmt ', fmtBody(1, 2, 16000, 16))], 0, Buffer.alloc(4)))!)).toBe(true);
  });
});

describe('GrowingWavFile', () => {
  let dir: string;
  const open: GrowingWavFile[] = [];

  afterEach(async () => {
    for (const file of open.splice(0)) {
      await file.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function follow(name: string): Promise<{ file: string; reader: GrowingWavFile }> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-wav-test-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, '');
    const reader = await GrowingWavFile.open(file);
    open.push(reader);
    return { file, reader };
  }

  it('waits for the header, then returns what was appended since the last read, in whole frames', async () => {
    const { file, reader } = await follow('rec.wav');
    const header = buildWav(MONO_16K, Buffer.alloc(0));
    header.writeUInt32LE(0, 40); // a recorder declares no data until it stops

    fs.appendFileSync(file, header.subarray(0, 30));
    expect((await reader.read()).length).toBe(0);
    expect(reader.format).toBeUndefined();

    fs.appendFileSync(file, header.subarray(30));
    expect((await reader.read()).length).toBe(0);
    expect(reader.format?.dataStart).toBe(44);

    fs.appendFileSync(file, Buffer.from([1, 2, 3])); // one and a half samples
    expect([...await reader.read()]).toEqual([1, 2]);
    fs.appendFileSync(file, Buffer.from([4, 5, 6, 7]));
    expect([...await reader.read()]).toEqual([3, 4, 5, 6]);
    expect([...await reader.read()]).toEqual([]);
    fs.appendFileSync(file, Buffer.from([8]));
    expect([...await reader.read()]).toEqual([7, 8]);
  });

  it('starts after a LIST chunk and ignores the declared size', async () => {
    const { file, reader } = await follow('ffmpeg.wav');
    const list = chunk('LIST', Buffer.from('INFOISFT', 'latin1'));
    fs.appendFileSync(file, wavWith([chunk('fmt ', fmtBody()), list], 2, Buffer.from([9, 9, 7, 7])));
    expect([...await reader.read()]).toEqual([9, 9, 7, 7]);
  });

  it('refuses a recording that is not 16-bit PCM', async () => {
    const { file, reader } = await follow('float.wav');
    fs.appendFileSync(file, wavWith([chunk('fmt ', fmtBody(3, 1, 16000, 32))], 0, Buffer.alloc(8)));
    await expect(reader.read()).rejects.toThrow(/not 16-bit PCM/);
  });
});
