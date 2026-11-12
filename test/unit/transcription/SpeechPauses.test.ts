import { describe, it, expect } from 'vitest';
import { LoudnessTrack, MAX_SEGMENT_S, MIN_SEGMENT_S, findCut } from '../../../src/transcription/SpeechPauses';

const RATE = 16000;
const FRAMES_PER_S = 50;

/** One second of a 440 Hz tone at each RMS level asked for: 440 whole waves, so seconds of it join seamlessly. */
const seconds440 = new Map<number, Buffer>();

/** A 440 Hz tone at the given RMS level, or digital silence for -Infinity. */
function level(seconds: number, dbfs: number): Buffer {
  const samples = Math.round(RATE * seconds);
  const pcm = Buffer.alloc(samples * 2);
  if (dbfs === -Infinity) {
    return pcm;
  }
  let second = seconds440.get(dbfs);
  if (!second) {
    const amplitude = 10 ** (dbfs / 20) * Math.SQRT2 * 32767;
    second = Buffer.alloc(RATE * 2);
    for (let i = 0; i < RATE; i++) {
      second.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
    }
    seconds440.set(dbfs, second);
  }
  for (let at = 0; at < pcm.length; at += second.length) {
    second.copy(pcm, at, 0, Math.min(second.length, pcm.length - at));
  }
  return pcm;
}

/** Track a sequence of [seconds, dBFS] stretches. */
function track(...stretches: [number, number][]): LoudnessTrack {
  const t = new LoudnessTrack(RATE);
  for (const [seconds, db] of stretches) {
    t.add(level(seconds, db));
  }
  return t;
}

/** Words (-20 dBFS) of `word` seconds with `gap`-second room-noise (-55 dBFS) gaps, for `seconds`. */
function words(seconds: number, word = 2.1, gap = 0.15, wordDb = -20, noiseDb = -55): [number, number][] {
  const out: [number, number][] = [];
  let left = seconds;
  while (left > 1e-9) {
    const w = Math.min(word, left);
    out.push([w, wordDb]);
    left -= w;
    if (left > 1e-9) {
      const g = Math.min(gap, left);
      out.push([g, noiseDb]);
      left -= g;
    }
  }
  return out;
}

const cutOf = (t: LoudnessTrack, start = 0) => findCut(t, start, t.frames, t.levels());
const at = (frame: number) => frame / FRAMES_PER_S;
const s = (seconds: number) => Math.round(seconds * FRAMES_PER_S);

describe('LoudnessTrack', () => {
  it('measures 20 ms frames, carrying a partial frame over to the next add', () => {
    const t = new LoudnessTrack(RATE);
    t.add(level(0.03, -20)); // a frame and a half
    expect(t.frames).toBe(1);
    t.add(level(0.01, -20));
    expect(t.frames).toBe(2);
    expect(t.db(0)).toBeCloseTo(-20, 0);
  });

  it('finds the room noise even when pauses are rare', () => {
    const levels = track([1, -Infinity], ...words(30, 2.1, 0.1)).levels(); // gaps are 4.5% of the frames
    expect(levels.floor).toBeGreaterThan(-58);
    expect(levels.floor).toBeLessThan(-52);
    expect(levels.speech).toBeCloseTo(-20, 0);
    expect(levels.calibrated).toBe(true);
    expect(levels.quiet).toBeGreaterThan(-55);
    expect(levels.quiet).toBeLessThan(-30);
  });

  it('counts the dead air of a noise-suppressing microphone as -90 dB, but not the device starting up', () => {
    // Pauses of digital zeros: the floor is dead air, and speech stands far above it
    const suppressed = track([2, -Infinity], ...words(30, 2.1, 0.4, -25, -Infinity)).levels();
    expect(suppressed.floor).toBeCloseTo(-90, 0);
    expect(suppressed.quiet).toBeLessThan(-60);
    // Zeros only before the microphone delivered anything: the room noise is the floor
    expect(track([3, -Infinity], ...words(30)).levels().floor).toBeGreaterThan(-58);
  });

  it('follows the last minute, so it learns a fan that starts mid-dictation', () => {
    const t = track(...words(120, 2.1, 0.4, -20, -60));
    expect(t.levels().floor).toBeLessThan(-57);
    for (const stretch of words(70, 2.1, 0.4, -20, -45)) {
      t.add(level(...stretch));
    }
    const levels = t.levels();
    expect(levels.floor).toBeGreaterThan(-48);
    expect(levels.quiet).toBeGreaterThan(-45); // the fan's pauses are quiet again
  });

  it('counts every frame in and out of the level window at the same level', () => {
    // A first frame that sits a hair below -62.5 dB in 64-bit and at -62.5 dB once stored in 32 bits
    const frame = Buffer.alloc(640);
    for (let i = 0; i < 316; i++) {
      frame.writeInt16LE(i % 2 ? 24 : -24, i * 2);
    }
    [0, 3, 13, 105].forEach((value, k) => frame.writeInt16LE(value, (316 + k) * 2));
    const t = new LoudnessTrack(RATE);
    t.add(frame);
    for (const stretch of words(70)) {
      t.add(level(...stretch));
    }
    const levels = t.levels(); // the first frame has left the 60 s window by now
    expect(levels.calibrated).toBe(true);
    expect(levels.floor).toBeGreaterThan(-58);
    expect(levels.floor).toBeLessThan(-52);
    expect(levels.speech).toBeCloseTo(-20, 0);
  });

  it('is not calibrated when speech does not stand out from the noise', () => {
    expect(track([30, -40]).levels().calibrated).toBe(false);
    expect(track([30, -Infinity]).levels().calibrated).toBe(false);
    expect(track(...words(30, 2.1, 0.5, -50, -55)).levels().calibrated).toBe(false);
  });

  it('tells speech from room noise, keystrokes and a dead microphone', () => {
    const keystrokes: [number, number][] = [];
    for (let i = 0; i < 20; i++) {
      keystrokes.push([0.04, -25], [0.16, -55]); // 40 ms clicks, five a second
    }
    const t = track(...words(22), [5, -55], ...keystrokes, [0.2, -30], [2, -55]);
    const levels = t.levels();
    expect(t.hasVoice(s(0), s(22), levels)).toBe(true);
    expect(t.hasVoice(s(22.1), s(27), levels)).toBe(false); // room noise only
    expect(t.hasVoice(s(27), s(31), levels)).toBe(false); // typing
    expect(t.hasVoice(s(31), s(31.2), levels)).toBe(true); // a short word, 200 ms
    expect(t.hasVoice(s(31), s(31.1), levels, 5)).toBe(true); // the last part's lower bar
    expect(t.isDeadMic(s(22.1), s(27))).toBe(false);
    const dead = track(...words(22), [3, -Infinity]);
    expect(dead.isDeadMic(s(22), s(25))).toBe(true);
    expect(dead.isDeadMic(s(21.9), s(25))).toBe(false);
    const flat = track([30, -40]);
    expect(flat.hasVoice(0, 100, flat.levels())).toBeUndefined(); // cannot tell
  });
});

describe('findCut', () => {
  // Later parts (first = false) may end from 20 s on; the first part of a recording 20 s later
  it('waits for 20 s of audio, or 40 s for the first part', () => {
    expect(cutOf(track([0.3, -Infinity], ...words(15), [2.2, -55], ...words(4)))).toBeUndefined();
    const t = track([0.3, -Infinity], ...words(25), [2.2, -55], ...words(4));
    const cut = cutOf(t)!;
    expect(at(cut.frame)).toBeGreaterThanOrEqual(25.3 + 0.1);
    expect(at(cut.frame)).toBeLessThanOrEqual(25.3 + 0.6);
    expect(findCut(t, 0, t.frames, t.levels(), true)).toBeUndefined();
  });

  it('takes the first pause of two seconds or more at once, at its quietest moment away from its edges', () => {
    const t = track([0.3, -Infinity], ...words(20.7), [1.5, -55], ...words(3), [0.2, -55], [0.2, -70], [1.8, -55], ...words(2));
    const cut = cutOf(t)!;
    const pause = 0.3 + 20.7 + 1.5 + 3;
    expect(at(t.frames)).toBeLessThan(30);
    expect(cut.forced).toBe(false);
    expect(cut.pauseMs).toBeGreaterThanOrEqual(2100);
    expect(at(cut.frame)).toBeGreaterThan(pause + 0.2); // in the -70 dB dip, not 300 ms into the pause
    expect(at(cut.frame)).toBeLessThan(pause + 0.4);
  });

  it('otherwise waits until 30 s and takes the longest pause of at least 450 ms', () => {
    const stretches: [number, number][] = [[0.3, -Infinity], ...words(20.5), [0.5, -55], ...words(2.5), [0.8, -55], ...words(2.5), [0.6, -55], ...words(1.5)];
    const before = track(...stretches);
    expect(at(before.frames)).toBeLessThan(30);
    expect(cutOf(before)).toBeUndefined(); // the stretch to choose in is still open
    const t = track(...stretches, ...words(1.5));
    expect(at(t.frames)).toBeGreaterThanOrEqual(30);
    const pause = 0.3 + 20.5 + 0.5 + 2.5; // the 0.8 s one
    expect(at(cutOf(t)!.frame)).toBeGreaterThanOrEqual(pause + 0.1);
    expect(at(cutOf(t)!.frame)).toBeLessThanOrEqual(pause + 0.7);
  });

  it('is not fooled by a click in a pause', () => {
    const t = track([0.3, -Infinity], ...words(21.7), [1, -55], [0.04, -20], [1.1, -55], ...words(2));
    const cut = cutOf(t)!;
    expect(cut.pauseMs).toBeGreaterThanOrEqual(2100); // one pause, taken at once, not two shorter ones
  });

  it('counts a pause that began just before the eligible point', () => {
    const cut = cutOf(track(...words(19.7), [2.2, -55], ...words(3)))!;
    expect(at(cut.frame)).toBeGreaterThan(19.7);
    expect(at(cut.frame)).toBeLessThan(20.4);
  });

  it('cuts a pause still going on, as soon as it is two seconds long', () => {
    expect(cutOf(track([0.3, -Infinity], ...words(21.7), [2.1, -55]))).toBeDefined();
    expect(cutOf(track([0.3, -Infinity], ...words(21.7), [1.85, -55]))).toBeUndefined();
  });

  it('after 30 s takes the first pause of 450 ms, after 38 s of 350 ms', () => {
    const short: [number, number][] = [[0.3, -Infinity]];
    for (let i = 0; i < 9; i++) {
      short.push(...words(4.6), [0.4, -55]); // 0.4 s pauses: too short before 38 s
    }
    const relaxed = cutOf(track(...short))!;
    expect(at(relaxed.frame)).toBeGreaterThanOrEqual(38);
    expect(relaxed.forced).toBe(false); // the 0.4 s pause after 38 s, not a cut forced at 45 s
    expect(relaxed.pauseMs).toBe(400);
    const tooEarly = track([0.3, -Infinity], ...short.slice(1, 1 + 8 * (words(4.6).length + 1)), ...words(0.5));
    expect(at(tooEarly.frames)).toBeLessThan(MAX_SEGMENT_S);
    expect(at(cutOf(tooEarly)!.frame)).toBeGreaterThanOrEqual(38);
    const later = track([0.3, -Infinity], ...words(31), [0.5, -55], ...words(3));
    expect(at(cutOf(later)!.frame)).toBeGreaterThan(31.3);
    expect(at(cutOf(later)!.frame)).toBeLessThan(31.8);
  });

  it('never takes a quiet stretch shorter than 350 ms', () => {
    const t = track([0.3, -Infinity], ...words(44, 2.1, 0.3), ...words(1.5));
    expect(cutOf(t)?.forced ?? true).toBe(true); // only a forced cut, at 45 s
  });

  it('counts dead air as a pause', () => {
    const cut = cutOf(track(...words(21, 2.1, 0.15, -20, -60), [2.2, -Infinity], ...words(3, 2.1, 0.15, -20, -60)))!;
    expect(at(cut.frame)).toBeGreaterThanOrEqual(21.1);
    expect(at(cut.frame)).toBeLessThan(21.7);
  });

  it('forces a cut at 45 s in the longest fairly quiet stretch, never in the last 300 ms read', () => {
    expect(cutOf(track([0.3, -Infinity], ...words(44)))).toBeUndefined();
    const t = track([0.3, -Infinity], ...words(40, 2.1, 0.15), [0.25, -50], ...words(5.5));
    const cut = cutOf(t)!;
    expect(cut.forced).toBe(true);
    expect(cut.pauseMs).toBeGreaterThanOrEqual(200); // the quiet stretch, not the quietest-250 ms fallback
    expect(at(cut.frame)).toBeGreaterThan(40.3);
    expect(at(cut.frame)).toBeLessThan(40.55);
    expect(at(t.frames)).toBeGreaterThanOrEqual(MAX_SEGMENT_S);
    // A quiet stretch inside the last 300 ms read is not taken: the word there may go on
    const edge = track([0.3, -Infinity], ...words(44.46), [0.24, -50]);
    expect(edge.frames).toBe(2250); // the first poll at 45 s, where the lookahead and not the 45 s bound decides
    const edgeCut = cutOf(edge)!;
    expect(edgeCut.frame).toBeLessThanOrEqual(edge.frames - 15);
  });

  it('forces the cut into the longest fairly quiet stretch, not the first', () => {
    // Two murmured stretches below floor + 0.4·SNR, both too short to be pauses: 0.25 s at 31 s, 0.4 s at 35 s
    const t = track([0.3, -Infinity], ...words(30.7), [0.25, -45], ...words(3.75), [0.4, -45], ...words(10));
    const cut = cutOf(t)!;
    expect(cut.forced).toBe(true);
    expect(at(cut.frame)).toBeGreaterThan(34.75);
    expect(at(cut.frame)).toBeLessThan(35.15);
  });

  it('a long stretch that could not be cut is cut into parts of at most 45 s, quickly, once the levels settle', () => {
    // 20 min of steady room noise (no speech: nothing can be cut), then speech with pauses
    const t = track([1, -55], [1200, -55], ...words(70, 2.1, 0.6));
    let from = 0;
    let parts = 0;
    const startedAt = Date.now();
    for (let cut = findCut(t, from, t.frames, t.levels(), true); cut; cut = findCut(t, from, t.frames, t.levels())) {
      expect(at(cut.frame - from)).toBeLessThanOrEqual(65);
      from = cut.frame;
      parts++;
    }
    expect(parts).toBeGreaterThan(25);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('forces a cut at the quietest 250 ms by power: a word with a dropout in it is not quiet', () => {
    // No gap below floor + 0.5·SNR anywhere: every gap is a -35 dB murmur
    const stretches: [number, number][] = [[0.3, -Infinity]];
    for (let i = 0; i < 20; i++) {
      stretches.push([2.1, -20], [0.15, i === 15 ? -45 : -35]);
    }
    stretches.push([0.06, -20], [0.04, -Infinity], [0.06, -20]); // a 40 ms dropout inside a word
    stretches.push(...words(3, 2.1, 0.15, -20, -35));
    const t = track([2, -60], ...stretches);
    const cut = findCut(t, 0, t.frames, t.levels())!;
    expect(cut.forced).toBe(true);
    const gap15 = 2 + 0.3 + 15 * 2.25 + 2.1; // the quietest gap
    expect(at(cut.frame)).toBeGreaterThan(gap15 - 0.1);
    expect(at(cut.frame)).toBeLessThan(gap15 + 0.25);
  });

  it('never cuts when pauses cannot be told from words', () => {
    expect(cutOf(track([80, -40]))).toBeUndefined();
    expect(cutOf(track([80, -Infinity]))).toBeUndefined();
  });

  it('cuts a later part from its own start', () => {
    const t = track([0.3, -Infinity], ...words(40.7), [2.2, -55], ...words(20.7), [2.2, -55], ...words(2));
    const first = findCut(t, 0, t.frames, t.levels(), true)!;
    expect(at(first.frame)).toBeGreaterThan(41.1);
    expect(at(first.frame)).toBeLessThan(41.7);
    const second = findCut(t, first.frame, t.frames, t.levels())!;
    expect(at(second.frame - first.frame)).toBeGreaterThanOrEqual(MIN_SEGMENT_S);
    const pause = 0.3 + 40.7 + 2.2 + 20.7;
    expect(at(second.frame)).toBeGreaterThan(pause + 0.1);
    expect(at(second.frame)).toBeLessThan(pause + 0.7);
  });
});
