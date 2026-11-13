import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveTranscription, type Billed, type LiveTranscriptionOptions } from '../../../src/transcription/LiveTranscription';
import { buildWav } from '../../../src/recorder/Wav';
import type { TranscribedWord, TranscriptionResult } from '../../../src/types';

// A recorder is simulated by appending 16 kHz mono 16-bit PCM to a WAV file
// whose header declares no data, as parecord (libsndfile) writes it. The
// session reads it every few milliseconds; the speech-to-text call is a fake.
// The first part of a recording may end from 40 s on, later parts 20 s after
// the cut before them; each request carries 2.5 s of audio past the cuts on
// either side of its part.

const RATE = 16000;
const BYTES_PER_S = RATE * 2;
const FRAME_BYTES = 640; // 20 ms
const MONO_16K = { channels: 1, sampleRate: RATE, bitsPerSample: 16, blockAlign: 2 };
const OVERLAP_S = 2.5;

let toneCount = 0;
/** xorshift32: exact in 32-bit integers, so no stretch of a "recording" repeats and each upload can be found in it. */
let rngState = 0x2545f491;
function random(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0x100000000;
}

/** A "word": a tone at -20 dBFS, each at its own pitch, with a little noise so its waves never repeat exactly. */
function speech(seconds: number): Buffer {
  const samples = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = 10 ** (-20 / 20) * Math.SQRT2 * 32767;
  const hz = 200 + ((toneCount++ * 37) % 900);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE) + (random() * 2 - 1) * 4), i * 2);
  }
  return pcm;
}

/** Room noise at -55 dBFS. */
function noise(seconds: number): Buffer {
  const samples = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = 10 ** (-55 / 20) * Math.sqrt(3) * 32767;
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * (random() * 2 - 1)), i * 2);
  }
  return pcm;
}

const zeros = (seconds: number) => Buffer.alloc(Math.round(RATE * seconds) * 2);

/** Speech in 2.1 s words 0.15 s apart, for `seconds`. */
function talk(seconds: number): Buffer {
  const parts: Buffer[] = [];
  let left = seconds;
  while (left > 1e-9) {
    const word = Math.min(2.1, left);
    parts.push(speech(word));
    left -= word;
    if (left > 1e-9) {
      const gap = Math.min(0.15, left);
      parts.push(noise(gap));
      left -= gap;
    }
  }
  return Buffer.concat(parts);
}

const seconds = (pcm: Buffer) => pcm.length / BYTES_PER_S;
const pcmOf = (wav: Buffer) => wav.subarray(44);
const settle = () => new Promise((r) => setTimeout(r, 60));

/** The header a recorder writes before it has data: sizes 0. */
function openHeader(): Buffer {
  const header = buildWav(MONO_16K, Buffer.alloc(0));
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(0, 40);
  return header;
}

/** 43.2 s of dictation up to the end of a 2.2 s pause, cut at once: the first part. */
const FIRST_PART = () => [zeros(0.3), talk(40.7), noise(2.2)];

/** Stretches of speech in 16 kHz samples, in 20 ms frames: runs of frames louder than -35 dBFS. */
function speechRuns(pcm: Buffer): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  const frames = Math.floor(pcm.length / FRAME_BYTES);
  let start = -1;
  for (let f = 0; f <= frames; f++) {
    let loud = false;
    if (f < frames) {
      let sum = 0;
      for (let i = 0; i < FRAME_BYTES; i += 2) {
        const v = pcm.readInt16LE(f * FRAME_BYTES + i);
        sum += v * v;
      }
      loud = 10 * Math.log10(sum / (FRAME_BYTES / 2) / 32768 ** 2 + 1e-12) > -35;
    }
    if (loud && start < 0) {
      start = f;
    } else if (!loud && start >= 0) {
      runs.push({ start, end: f });
      start = -1;
    }
  }
  return runs;
}

/**
 * A fake speech-to-text that hears what it is sent: each stretch of speech
 * comes back as a word named after the frame of the recording it starts at.
 * Like real speech-to-text it punctuates from what it heard: a word before a
 * pause of 10 s or more ends a sentence, before a pause of 1 s or more it
 * gets a comma, and its last word a full stop; the first word, and each after
 * a full stop, is capitalised. Unless `words` is false, each word comes with
 * its timing from the start of the audio, as ElevenLabs gives it, shifted by
 * `jitter` seconds.
 */
function hearing(recording: Buffer, pcm: Buffer, options: { words?: boolean; jitter?: number } = {}): TranscriptionResult {
  const offset = pcm === recording ? 0 : recording.indexOf(pcm.subarray(0, 6400)) / FRAME_BYTES;
  const runs = speechRuns(pcm);
  const jitter = options.jitter ?? 0;
  const words: TranscribedWord[] = [];
  let capital = true;
  const texts = runs.map((run, i) => {
    const gap = (i + 1 < runs.length ? runs[i + 1].start : Infinity) - run.end;
    let text = `w${offset + run.start}`;
    if (capital) {
      text = text.toUpperCase();
    }
    const ends = i === runs.length - 1 || gap >= 500;
    text += ends ? '.' : gap >= 50 ? ',' : '';
    capital = ends;
    if (i > 0) {
      words.push({ text: ' ', start: runs[i - 1].end * 0.02 + jitter, end: run.start * 0.02 + jitter, type: 'spacing' });
    }
    words.push({ text, start: run.start * 0.02 + jitter, end: run.end * 0.02 + jitter, type: 'word' });
    return text;
  });
  return { text: texts.join(' '), words: options.words === false ? undefined : words, cost: 0.01, language: 'en' };
}

describe('LiveTranscription', () => {
  let dir: string;
  let file: string;
  let sessions: LiveTranscription[];
  let calls: { wav: Buffer; signal: AbortSignal; prompt: string | undefined; settle: (result: TranscriptionResult | Error) => void }[];
  let autoAnswer: ((wav: Buffer, index: number) => TranscriptionResult | Error | undefined) | undefined;
  let logs: string[];
  let discarded: Billed[];
  let transcribed: number[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-dictator-live-test-'));
    file = path.join(dir, 'code-dictator-1.wav');
    fs.writeFileSync(file, openHeader());
    sessions = [];
    calls = [];
    autoAnswer = undefined;
    logs = [];
    discarded = [];
    transcribed = [];
  });

  afterEach(async () => {
    for (const s of sessions) {
      s.cancel();
    }
    // A cancelled session closes its file a moment later, and until then
    // Windows refuses to remove the folder (ENOTEMPTY)
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function start(options: Partial<LiveTranscriptionOptions> = {}): LiveTranscription {
    const session = LiveTranscription.start(file, {
      transcribe: (wav, signal, prompt) => new Promise<TranscriptionResult>((resolve, reject) => {
        const index = calls.length;
        const settleCall = (result: TranscriptionResult | Error) => (result instanceof Error ? reject(result) : resolve(result));
        calls.push({ wav, signal, prompt, settle: settleCall });
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
        const answer = autoAnswer?.(wav, index);
        if (answer) {
          settleCall(answer);
        }
      }),
      holdSpeechSeconds: 0,
      pollMs: 5,
      retryDelayMs: 10,
      log: (m) => logs.push(m),
      onDiscarded: (billed) => discarded.push(billed),
      onTranscribed: (s) => transcribed.push(s),
      ...options,
    });
    sessions.push(session);
    return session;
  }

  /** Everything appended so far, as the WAV the recorder leaves when it is stopped. */
  function finalAudio() {
    const pcm = fs.readFileSync(file).subarray(44);
    return { buffer: buildWav(MONO_16K, pcm), mimeType: 'audio/wav', durationMs: seconds(pcm) * 1000 };
  }
  const recorded = () => fs.readFileSync(file).subarray(44);
  const record = (...pcm: Buffer[]) => fs.appendFileSync(file, Buffer.concat(pcm));
  const signal = () => new AbortController().signal;
  const firstCall = () => vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
  /** Wait until the session has read all that was recorded, so that what it did not do is meaningful. */
  const readAll = (live: LiveTranscription) => vi.waitFor(() => expect(live.secondsRead).toBeCloseTo(seconds(recorded()), 3), { timeout: 3000 });
  /** The fake speech-to-text, answering each request from the audio it was sent. */
  const hear = (options: { words?: boolean; jitter?: (index: number) => number } = {}) => (wav: Buffer, index: number) =>
    hearing(recorded(), pcmOf(wav), { words: options.words, jitter: options.jitter?.(index) });
  /** What the fake gives for the whole recording in one request: what a dictation must come out as. */
  const whole = () => hearing(recorded(), recorded()).text;

  /** Where in the recording each upload's audio lies, in seconds, after checking it is exactly that audio. */
  function spans(indexes = calls.map((_c, i) => i)): Array<{ start: number; end: number }> {
    const recording = recorded();
    return indexes.map((i) => {
      const pcm = pcmOf(calls[i].wav);
      const at = recording.indexOf(pcm.subarray(0, Math.min(pcm.length, 6400)));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(recording.subarray(at, at + pcm.length).equals(pcm)).toBe(true);
      return { start: at / BYTES_PER_S, end: (at + pcm.length) / BYTES_PER_S };
    });
  }

  /** The uploads cover the whole recording, neighbours sharing 5 s: 2.5 s on either side of each cut. */
  function expectOverlappingCover(sent: Array<{ start: number; end: number }>): void {
    expect(sent[0].start).toBe(0);
    expect(sent[sent.length - 1].end).toBeCloseTo(seconds(recorded()), 3);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i - 1].end - sent[i].start).toBeCloseTo(2 * OVERLAP_S, 2);
    }
  }

  it('leaves a dictation shorter than 40 s to the caller', async () => {
    autoAnswer = () => ({ text: 'unused' });
    const live = start();
    record(zeros(0.3), talk(25), noise(2.2), talk(10));
    await readAll(live);
    await settle();
    expect(live.segmentCount).toBe(0);
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(discarded).toHaveLength(0);
  });

  it('sends the first part with 2.5 s past its cut, the rest from 2.5 s before it, and reads as the whole recording would', async () => {
    autoAnswer = hear();
    const live = start();
    record(...FIRST_PART());
    await vi.waitFor(() => expect(live.segmentCount).toBe(1), { timeout: 3000 });
    await settle();
    expect(calls).toHaveLength(0); // the 2.5 s past the cut have not been recorded yet
    record(talk(2));
    await firstCall();
    const [first] = spans([0]);
    expect(first.end).toBeGreaterThanOrEqual(41.1 + OVERLAP_S); // the cut lies in the pause, away from its edges
    expect(first.end).toBeLessThanOrEqual(41.6 + OVERLAP_S);

    record(talk(10));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    expectOverlappingCover(spans());
    expect(result).toMatchObject({ text: whole(), language: 'en' });
    expect(result!.text).toMatch(/^W15 .* w2040, w2160 /); // the pause at 41-43.2 s: a comma, no capital
    expect(result!.cost).toBeCloseTo(0.02);
    expect(result!.duration).toBeCloseTo(seconds(recorded()), 2); // the recording covered; the overlap, billed twice, is in the cost
    expect(transcribed).toHaveLength(2);
    expect(transcribed[0] + transcribed[1]).toBeCloseTo(seconds(recorded()), 2); // what each covered of the recording, overlaps not counted
    expect(discarded).toHaveLength(0);
  });

  it('keeps each word from one part only, by its timestamps, so the sentence across a cut comes out whole', async () => {
    // The cut lies in the pause at 41–43.2 s. Like ElevenLabs, each part says when each word was said,
    // in seconds from the start of the audio it was sent
    const word = (text: string, start: number, end: number): TranscribedWord => ({ text, start, end, type: 'word' });
    const space = (at: number): TranscribedWord => ({ text: ' ', start: at, end: at, type: 'spacing' });
    autoAnswer = (wav, index) => {
      const from = recorded().indexOf(pcmOf(wav).subarray(0, 6400)) / BYTES_PER_S;
      const at = (s: number) => s - from;
      if (index === 0) {
        // Heard up to 2.5 s past the cut: "...function directly, which" (it did not end the sentence there)
        return { text: 'mock the fetch function directly, which', words: [word('mock', at(38), at(38.3)), space(at(38.3)), word('the', at(38.4), at(38.5)),
          space(at(38.5)), word('fetch', at(38.6), at(39)), space(at(39)), word('function', at(39.1), at(39.6)), space(at(39.6)),
          word('directly,', at(39.7), at(40.9)), space(at(40.9)), word('which', at(43.3), at(43.6))] };
      }
      // Heard from 2.5 s before the cut, starting with "Directly", which it capitalised for starting there
      return { text: 'Directly, which makes them brittle.', words: [word('Directly,', at(39.7), at(40.9)), space(at(40.9)), word('which', at(43.3), at(43.6)),
        space(at(43.6)), word('makes', at(43.7), at(44)), space(at(44)), word('them', at(44.1), at(44.3)), space(at(44.3)), word('brittle.', at(44.4), at(45))] };
    };
    const live = start();
    record(...FIRST_PART(), talk(2));
    await firstCall();
    record(talk(5));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    expect(result?.text).toBe('mock the fetch function directly, which makes them brittle.');
    expect(logs).toContain('Join 1: "…the fetch function" + "directly, which makes…"');
  });

  it.each([
    ['a 3.6 s pause', 3.6, 0],
    ['a 5 s pause, the language auto-detected', 5, 6],
  ])('takes the words before %s from the part that heard what follows it, so no full stop lands mid-sentence', async (_label, pause, hold) => {
    autoAnswer = hear();
    const live = start({ holdSpeechSeconds: hold });
    // The first part's audio ends 2.5 s past the cut, inside the pause: it hears the sentence end there
    record(zeros(0.3), talk(40.7), noise(pause), talk(8));
    await firstCall();
    expect(hearing(recorded(), pcmOf(calls[0].wav)).text).toMatch(/ w2040\.$/);
    record(talk(6));
    const result = await live.finish(finalAudio(), signal());
    expect(result?.text).toBe(whole());
    expect(result!.text).toMatch(/ w2040, w\d+ /);
  });

  it('starts the request after a cut deep in a long pause before the pause, so it hears the words the pause interrupted', async () => {
    autoAnswer = hear();
    const live = start();
    // Speech to 35.3 s, then 6.5 s of silence: the first cut comes about 3 s into it, more than the overlap
    record(zeros(0.3), talk(35), noise(6.5), talk(8));
    await firstCall();
    record(talk(6));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    const [first, rest] = spans();
    expect(first.end - OVERLAP_S - 35.3).toBeGreaterThan(OVERLAP_S); // the cut lies deeper in the pause than the overlap reaches
    expect(rest.start).toBeGreaterThan(35.3 - 2); // so the rest starts where 1.5 s of speech before the pause begin
    expect(rest.start).toBeLessThan(35.3 - 1.5);
    expect(result?.text).toBe(whole());
    expect(result!.text).toMatch(/ w1702, w2090 /);
  });

  it('joins by the texts when a part\'s word timings do not hold the very words of its text', async () => {
    const heard = hear();
    autoAnswer = (wav, index) => {
      const answer = heard(wav, index);
      return index === 1 ? { ...answer, words: answer.words!.slice(2) } : answer; // two words lost from the timings
    };
    const live = start();
    record(...FIRST_PART(), talk(2));
    await firstCall();
    record(talk(10));
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
  });

  it('without word timestamps, joins the texts where both heard the same words, as the whole recording reads', async () => {
    autoAnswer = hear({ words: false });
    const live = start();
    record(zeros(0.3), talk(40.7), noise(3.6), talk(8));
    await firstCall();
    record(talk(15.1), noise(2.2), talk(8)); // a second cut, in the pause at 67.7 s
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    record(talk(4));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(3);
    expect(result?.text).toBe(whole());
  });

  it('without word timestamps, leaves out the words said in the overlap once', async () => {
    // As many words as 43 s of speech hold, ending with what was said around the cut
    const before = 'and so on '.repeat(33);
    autoAnswer = (_wav, index) => ({ text: index === 0
      ? `${before}The existing tests mock the fetch function directly, which makes them brit`
      : 'fetch function directly, which makes them brittle, so I would prefer a fake client.' });
    const live = start();
    record(...FIRST_PART(), talk(2));
    await firstCall();
    record(talk(6));
    expect((await live.finish(finalAudio(), signal()))?.text)
      .toBe(`${before}The existing tests mock the fetch function directly, which makes them brittle, so I would prefer a fake client.`);
  });

  it('without word timestamps, transcribes the whole recording when two parts share no words although their overlap held speech', async () => {
    autoAnswer = (_wav, index) => ({ text: index === 0 ? 'The first part.' : 'And the second part', cost: 0.01 });
    const live = start();
    record(...FIRST_PART(), talk(2));
    await firstCall();
    record(talk(6));
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(logs).toContain('Join 1: the two parts share no words although their overlap held speech; the whole recording is transcribed instead');
    expect(discarded).toEqual([{ requests: 2, seconds: expect.any(Number), recordingSeconds: expect.any(Number), cost: 0.02 }]);
  });

  it('sends every part with the same prompt, and drops a part that reads it back or is a stock hallucination', async () => {
    const answers = ['Software development discussion.', 'Subtitles by the Amara.org community', '(keyboard clicking)', 'Thank you.'];
    autoAnswer = (_wav, index) => ({ text: answers[index] });
    const prompt = 'Software development discussion. Technical terms.';
    const live = start({ prompt });
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    for (let n = 2; n <= 3; n++) {
      record(talk(17.6), noise(2.2), talk(2.5));
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n), { timeout: 3000 });
    }
    record(talk(6));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.prompt === prompt)).toBe(true);
    expect(result?.text).toBe('Thank you.'); // a last "Thank you." is what was said
  });

  it('with the language auto-detected, keeps a part until 6 s of speech follow it, and else sends the whole recording', async () => {
    autoAnswer = () => ({ text: 'Everything in one go' });
    const live = start({ holdSpeechSeconds: 6 });
    record(...FIRST_PART(), talk(4));
    await vi.waitFor(() => expect(live.segmentCount).toBe(1), { timeout: 3000 });
    await settle();
    expect(calls).toHaveLength(0); // held: less than 6 s of speech follow the cut

    // Nothing was sent on its own, so the caller sends the whole recording in one request
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('with the language auto-detected, sends a held part once 6 s of speech follow it', async () => {
    autoAnswer = hear();
    const live = start({ holdSpeechSeconds: 6 });
    record(...FIRST_PART(), talk(4));
    await vi.waitFor(() => expect(live.segmentCount).toBe(1), { timeout: 3000 });
    await settle();
    expect(calls).toHaveLength(0);
    record(talk(3));
    await firstCall();
    expect(spans([0])[0].end).toBeLessThanOrEqual(41.6 + OVERLAP_S);
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
  });

  it('with the language auto-detected, a long pause after a cut does not count: the last words go with the part before', async () => {
    autoAnswer = () => ({ text: 'x' });
    const live = start({ holdSpeechSeconds: 6 });
    record(...FIRST_PART(), noise(10.5), talk(2));
    await vi.waitFor(() => expect(live.segmentCount).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    await readAll(live);
    await settle();
    expect(calls).toHaveLength(0);
    expect(await live.finish(finalAudio(), signal())).toBeUndefined(); // one request for all of it, by the caller
  });

  it('with the language auto-detected, a part with only a few words of its own waits for the next one', async () => {
    autoAnswer = hear();
    const live = start({ holdSpeechSeconds: 6 });
    // A word after the first part, a long think (where the second part ends), then more speech,
    // streamed a second at a time as a recorder writes it
    const audio = Buffer.concat([...FIRST_PART(), talk(1), noise(19.5), talk(8)]);
    for (let at = 0; at < audio.length; at += BYTES_PER_S) {
      record(audio.subarray(at, Math.min(audio.length, at + BYTES_PER_S)));
      await new Promise((r) => setTimeout(r, 15));
    }
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 3000 });
    await settle();
    expect(live.segmentCount).toBe(2);
    expect(calls).toHaveLength(1); // the second part, with 1 s of speech, is not sent on its own
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2); // it went with the speech after it
    expect(result?.text).toBe(whole());
    expectOverlappingCover(spans());
  });

  it('a held part goes alone at the stop when nothing was said after it, without the silence', async () => {
    autoAnswer = hear();
    const live = start({ holdSpeechSeconds: 6 });
    record(...FIRST_PART(), talk(20.1), noise(2.2), noise(8));
    await firstCall(); // the first part: 20 s of speech followed it
    await settle();
    expect(calls).toHaveLength(1);
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    const [, second] = spans();
    expect(second.end - second.start).toBeGreaterThan(21 + OVERLAP_S); // the held second part, from the overlap before its cut...
    expect(second.end - second.start).toBeLessThan(23 + OVERLAP_S); // ...without the 10 s pause the recording ended with
    expect(result?.text).toBe(whole());
    // Covered: the recording up to the second cut, not the 10 s pause it ended with
    expect(result!.duration).toBeLessThan(seconds(recorded()) - 8);
  });

  it('does not send a rest without speech', async () => {
    autoAnswer = () => ({ text: 'Only words' });
    const live = start();
    record(...FIRST_PART(), noise(4));
    await firstCall();
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(1);
    expect(result?.text).toBe('Only words');
    expect(logs.some((l) => / s: no speech, not sent$/.test(l))).toBe(true);
  });

  it('sends parts that are ready together as one request', async () => {
    autoAnswer = hear();
    const live = start();
    record(...FIRST_PART(), talk(17.6), noise(2.2), talk(3)); // read at once, as after a stall
    await firstCall();
    await settle();
    expect(calls).toHaveLength(1);
    expect(live.segmentCount).toBe(2);
    expect(spans([0])[0].end).toBeGreaterThan(60.8 + OVERLAP_S); // past the second cut, in the pause at 60.8 s
    record(talk(3));
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
  });

  it('joins three parts and more, each word once, though every request times its words a little differently', async () => {
    autoAnswer = hear({ jitter: (index) => [0.04, -0.04, 0.03, -0.03][index % 4] });
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    for (let n = 2; n <= 3; n++) {
      record(talk(17.6), noise(2.2), talk(2.5));
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n), { timeout: 3000 });
    }
    record(talk(6));
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(4);
    expectOverlappingCover(spans());
    expect(result?.text).toBe(whole());
  });

  it('sends a part again once when it fails', async () => {
    const heard = hear();
    autoAnswer = (wav, index) => (index === 0 ? new Error('ElevenLabs service is temporarily unavailable.') : heard(wav, index));
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    expect(pcmOf(calls[1].wav).equals(pcmOf(calls[0].wav))).toBe(true);
    record(talk(6));
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
  });

  it('after a part fails twice, sends it again with the next part', async () => {
    const heard = hear();
    autoAnswer = (wav, index) => (index < 2 ? new Error('Unable to reach ElevenLabs') : heard(wav, index));
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    await settle();
    expect(calls).toHaveLength(2); // no third try for the same audio
    record(talk(15.1), noise(2.2), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(3), { timeout: 3000 });
    expect(spans([2])[0].end).toBeGreaterThan(60.8 + OVERLAP_S); // both parts in one request
    record(talk(6));
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
    expectOverlappingCover(spans([2, 3]));
  });

  it('after two requests in a row fail, sends nothing more until the stop', async () => {
    autoAnswer = () => new Error('ElevenLabs quota exceeded.');
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    record(talk(15.1), noise(2.2), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(4), { timeout: 3000 });
    await vi.waitFor(() => expect(logs).toContain('Stopped following the recording: 2 requests in a row failed; nothing more is sent until the recording stops'), { timeout: 3000 });
    record(talk(15.1), noise(2.2), talk(2.5), talk(15.1), noise(2.2), talk(2.5));
    await settle();
    await settle();
    expect(calls).toHaveLength(4);
    // Nothing was transcribed while recording: the caller sends the whole recording
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  it('a part that gets no answer in time has failed', async () => {
    autoAnswer = (_wav, index) => (index < 2 ? undefined : { text: 'late but fine' }); // the first two never answer
    const live = start({ requestTimeoutMs: () => 30 });
    record(...FIRST_PART(), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    await vi.waitFor(() => expect(logs.some((l) => l.includes('no answer within 0 s'))).toBe(true), { timeout: 3000 });
    expect(calls[0].signal.aborted).toBe(true);
    record(talk(6));
    // Nothing was transcribed while recording: the caller sends the whole recording
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
  });

  it('at the stop, gives up a part in flight that takes too long, and sends its audio with the rest', async () => {
    const heard = hear();
    autoAnswer = (wav, index) => (index === 1 ? undefined : heard(wav, index)); // the second part never answers
    const live = start({ stopWaitMs: () => 150 });
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(17.6), noise(2.2), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    record(talk(5));
    const startedAt = Date.now();
    const result = await live.finish(finalAudio(), signal());
    expect(Date.now() - startedAt).toBeLessThan(2000); // not its minute-and-more timeout, nor a retry
    expect(calls[1].signal.aborted).toBe(true);
    expect(calls).toHaveLength(3); // the stalled part was not sent again: its audio went with the rest
    expect(spans([2])[0].start).toBeCloseTo(spans([0])[0].end - 2 * OVERLAP_S, 2);
    expect(result?.text).toBe(whole());
    expect(logs.some((l) => l.startsWith('The part in flight has had no answer'))).toBe(true);
  });

  it('at the stop, does not send a part that just failed again: it goes with the rest', async () => {
    const heard = hear();
    autoAnswer = (wav, index) => (index === 1 ? undefined : heard(wav, index)); // the second part fails once the recording has stopped
    const live = start({ retryDelayMs: 5000 });
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(17.6), noise(2.2), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    record(talk(5));
    const finishing = live.finish(finalAudio(), signal());
    await settle();
    calls[1].settle(new Error('Unable to reach ElevenLabs'));
    const result = await finishing;
    expect(calls).toHaveLength(3);
    expect(result?.text).toBe(whole());
    expect(logs).toContain('It goes with the rest');
  });

  it('rejects with the error when the rest fails twice, so the recording is kept for Retry', async () => {
    autoAnswer = (_wav, index) => (index === 0 ? { text: 'fine', cost: 0.01 } : new Error('ElevenLabs quota exceeded.'));
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(6));
    await expect(live.finish(finalAudio(), signal())).rejects.toThrow('ElevenLabs quota exceeded.');
    expect(calls).toHaveLength(3); // the rest, and its second try
    expect(discarded).toHaveLength(1);
    expect(discarded[0].requests).toBe(1);
    expect(discarded[0].cost).toBeCloseTo(0.01);
  });

  it('cancel() aborts the part in flight, sends nothing more and reports what was billed', async () => {
    autoAnswer = (_wav, index) => (index === 0 ? { text: 'billed', cost: 0.02 } : undefined);
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(15.1), noise(2.2), talk(2.5));
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    live.cancel();
    expect(calls[1].signal.aborted).toBe(true);
    record(talk(30), noise(2.2));
    await settle();
    expect(calls).toHaveLength(2);
    expect(discarded).toEqual([{ requests: 1, seconds: expect.any(Number), recordingSeconds: expect.any(Number), cost: 0.02 }]);
    expect(discarded[0].seconds).toBeGreaterThan(41 + OVERLAP_S); // billed: the first part and 2.5 s past its cut
    expect(discarded[0].recordingSeconds).toBeCloseTo(discarded[0].seconds - OVERLAP_S, 2); // the recording it covered
  });

  it('finish() rejects with an AbortError, and aborts the part in flight, when the dictation is cancelled', async () => {
    autoAnswer = (_wav, index) => (index === 0 ? { text: 'first' } : undefined);
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(6));
    const escape = new AbortController();
    const finishing = live.finish(finalAudio(), escape.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
    escape.abort();
    await expect(finishing).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[1].signal.aborted).toBe(true); // the rest, in flight
    expect(discarded).toHaveLength(1);

    const late = start();
    await expect(late.finish(finalAudio(), escape.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('detach(signal) hands the session to the pipeline: its Escape cancels before finish() is called', async () => {
    autoAnswer = (_wav, index) => (index === 0 ? undefined : { text: 'x' });
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    const pipeline = new AbortController();
    live.detach(pipeline.signal);
    pipeline.abort();
    expect(calls[0].signal.aborted).toBe(true);
    await expect(live.finish(finalAudio(), pipeline.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops sending once the settings change, and leaves the recording to the caller', async () => {
    let changed = false;
    autoAnswer = () => ({ text: 'x' });
    const live = start({ invalidated: () => (changed ? 'the language changed' : undefined) });
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    changed = true;
    record(talk(17.6), noise(2.2), talk(5));
    await vi.waitFor(() => expect(logs.some((l) => l.startsWith('Stopped following the recording: the language changed'))).toBe(true), { timeout: 3000 });
    await settle();
    expect(calls).toHaveLength(1);
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(discarded).toHaveLength(1);
  });

  it('leaves the recording to the caller when the final file is not the audio that was read', async () => {
    autoAnswer = () => ({ text: 'x' });
    const live = start();
    record(...FIRST_PART(), talk(2.5));
    await firstCall();
    record(talk(6));
    const audio = finalAudio();
    audio.buffer.writeInt16LE(1234, 44 + 2 * 16000); // one sample at 1 s, long sent
    expect(await live.finish(audio, signal())).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('never cuts a dead microphone', async () => {
    autoAnswer = () => ({ text: 'x' });
    const live = start();
    record(zeros(70));
    await readAll(live);
    await settle();
    expect(live.segmentCount).toBe(0);
    expect(await live.finish(finalAudio(), signal())).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('cuts continuous speech at its quietest moment by 65 s', async () => {
    autoAnswer = () => ({ text: 'x' });
    start();
    record(zeros(0.3), talk(70)); // only 0.15 s gaps: no pause long enough
    await firstCall();
    const cut = spans([0])[0].end - OVERLAP_S;
    expect(cut).toBeGreaterThan(40);
    expect(cut).toBeLessThanOrEqual(65);
    expect(logs.some((l) => l.includes('no pause came: forced'))).toBe(true);
  });

  it('does not send a part without speech, and still sends the speech after it', async () => {
    autoAnswer = hear();
    const live = start();
    record(...FIRST_PART(), noise(1));
    await firstCall();
    record(noise(29), talk(4)); // the second part, cut in this long pause, holds no speech
    await vi.waitFor(() => expect(logs.some((l) => / s: no speech, not sent$/.test(l))).toBe(true), { timeout: 3000 });
    expect((await live.finish(finalAudio(), signal()))?.text).toBe(whole());
    expect(calls).toHaveLength(2);
    // Nothing was said across the cut before the rest, so its request starts at that cut, without an overlap of silence
    const cut = Number(/^Part 2: cut at ([\d.]+) s/.exec(logs.find((l) => l.startsWith('Part 2: cut at'))!)![1]);
    expect(spans([1])[0].start).toBeCloseTo(cut, 1);
  });

  it('starts after a stretch let go as silent early enough to hear a word too short to count as speech', async () => {
    autoAnswer = hear();
    const live = start();
    record(...FIRST_PART(), noise(1));
    await firstCall();
    // A 0.14 s word 15 s into a long think, then silence: the part it lies in is let go
    record(noise(15), speech(0.14), noise(12), talk(4));
    await vi.waitFor(() => expect(logs.some((l) => / s: no speech, not sent$/.test(l))).toBe(true), { timeout: 3000 });
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    expect(result?.text).toBe(whole());
    expect(result!.text).toMatch(/ W2960\. /);
  });

  it('starts the request after a cut deep in a pause where the speaker breathed, from before the words', async () => {
    autoAnswer = hear();
    const live = start();
    // Speech to 35.3 s, 6.5 s of silence with a breath at 37.2 s too faint to be written down, then speech
    const breath = (seconds: number) => {
      const pcm = noise(seconds);
      const amplitude = 10 ** (-38 / 20) * Math.SQRT2 * 32767;
      for (let i = 0; i < pcm.length / 2; i++) {
        pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 300 * i) / RATE)), i * 2);
      }
      return pcm;
    };
    record(zeros(0.3), talk(35), noise(1.9), breath(0.2), noise(4.4), talk(8));
    await firstCall();
    record(talk(6));
    const result = await live.finish(finalAudio(), signal());
    const [, rest] = spans();
    expect(rest.start).toBeLessThan(35.3 - 1.2); // the breath moved the start by its own length only
    expect(result?.text).toBe(whole());
  });

  it('keeps a word heard only in the overlap before a stretch that was let go as silent', async () => {
    autoAnswer = hear();
    const live = start();
    // A 0.14 s word 1.1 s past the first cut, too short to count as speech for the part it lies in,
    // then 25 s of silence: that part is let go, and only the first request heard the word
    record(...FIRST_PART(), noise(0.2), speech(0.14), noise(1));
    await firstCall();
    record(noise(24.5), talk(4));
    await vi.waitFor(() => expect(logs.some((l) => / s: no speech, not sent$/.test(l))).toBe(true), { timeout: 3000 });
    const result = await live.finish(finalAudio(), signal());
    expect(calls).toHaveLength(2);
    expect(result?.text).toBe(whole());
    expect(result!.text).toMatch(/w2170\. W\d+/);
  });
});
