/**
 * Where a dictation can be cut without splitting a word: the loudness of the
 * recording in 20 ms frames, the levels of its room noise and its speech, and
 * the pauses between them.
 *
 * Everything here works on audio time (frame numbers), never on the clock, so
 * a recorder that delivers its audio in bursts is cut in the same places.
 */

/** Length of one loudness frame. */
export const FRAME_MS = 20;
const PER_SECOND = 1000 / FRAME_MS;

/** Quieter than any live microphone: dead air, counted at this level (as in the native recorder's VAD). */
export const DEAD_AIR_DBFS = -90;
/** Every frame of a dead microphone is quieter than this (the whole-recording silence check uses the same level). */
export const DEAD_MIC_DBFS = -80;
/** Speech must stand this far above the room noise before pauses are told from words. */
export const MIN_SNR_DB = 8;
/** A frame is part of a pause below this point between the noise floor and the speech level. */
const QUIET_POSITION = 0.3;
/** Speech is at least floor + max(VOICE_MIN_DB, VOICE_POSITION × SNR)... */
const VOICE_MIN_DB = 8;
const VOICE_POSITION = 0.35;
/** ...for at least this long at a stretch: a keystroke or a click is shorter. */
const VOICE_RUN_FRAMES = 3;
/** The levels follow the last minute, so a fan that starts mid-dictation is learned. */
const LEVEL_WINDOW_FRAMES = 60 * PER_SECOND;

const LOWEST_DB = -120;

/** The loudness of `samples` interleaved 16-bit samples at `offset`, in dBFS. */
function frameDb(pcm: Buffer, offset: number, samples: number): number {
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(offset + i * 2);
    sumSquares += sample * sample;
  }
  if (sumSquares === 0) {
    return LOWEST_DB;
  }
  return Math.max(LOWEST_DB, 10 * Math.log10(sumSquares / samples / (32768 * 32768)));
}

/** Room noise and speech levels of a recording, and the thresholds that follow from them. */
export interface Levels {
  /** The room noise (dBFS): the quietest level many recent frames share; dead air counts as -90. */
  floor: number;
  /** The speech: 95th percentile of the recent frames (dBFS). */
  speech: number;
  /** Speech stands far enough above the noise to tell pauses from words. */
  calibrated: boolean;
  /** Frames below this are part of a pause. */
  quiet: number;
  /** Frames above this, for a while, are speech. */
  voice: number;
}

/**
 * The loudness of a recording, frame by frame, fed with its 16-bit PCM as it
 * arrives. A 1 dB histogram of the last minute of frames gives the noise and
 * speech levels.
 */
export class LoudnessTrack {
  /** Interleaved samples in one frame. */
  readonly frameSamples: number;
  /** Bytes of PCM in one frame. */
  readonly frameBytes: number;
  private dbs = new Float32Array(4096);
  private count = 0;
  /** Bin = dB - DEAD_AIR_DBFS: the frames of the level window at each level. */
  private readonly histogram = new Uint32Array(-DEAD_AIR_DBFS + 1);
  private counted = 0;
  /** The first frame the levels count: dead air before the microphone delivered anything is left out. */
  private firstLive = -1;
  /** PCM of a frame that is not complete yet. */
  private partial = Buffer.alloc(0);

  /** sampleRate × channels: interleaved samples per second. */
  constructor(readonly samplesPerSecond: number) {
    this.frameSamples = Math.max(1, Math.round((samplesPerSecond * FRAME_MS) / 1000));
    this.frameBytes = this.frameSamples * 2;
  }

  /** Frames measured so far. */
  get frames(): number {
    return this.count;
  }

  /** The level of a frame, in dBFS. */
  db(frame: number): number {
    return this.dbs[frame];
  }

  /** The median level of the 5 frames around `frame` (fewer at the edges): a 1–2 frame click does not end a pause. */
  smoothed(frame: number): number {
    const from = Math.max(0, frame - 2);
    const to = Math.min(this.count, frame + 3);
    const values: number[] = [];
    for (let f = from; f < to; f++) {
      values.push(Math.max(DEAD_AIR_DBFS, this.dbs[f]));
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  /** Mean power of the frames [from, to); of their smoothed levels with `smooth`, so that a 1–2 frame dropout inside a word does not look quiet. */
  power(from: number, to: number, smooth = false): number {
    let sum = 0;
    for (let f = from; f < to; f++) {
      sum += 10 ** ((smooth ? this.smoothed(f) : this.dbs[f]) / 10);
    }
    return sum / Math.max(1, to - from);
  }

  /** Measure the PCM that follows what was added before. */
  add(pcm: Buffer): void {
    const data = this.partial.length > 0 ? Buffer.concat([this.partial, pcm]) : pcm;
    let offset = 0;
    for (; offset + this.frameBytes <= data.length; offset += this.frameBytes) {
      this.push(frameDb(data, offset, this.frameSamples));
    }
    this.partial = Buffer.from(data.subarray(offset));
  }

  /** Noise and speech levels of the last minute. */
  levels(): Levels {
    const floor = this.noiseFloor();
    const speech = this.percentile(0.95);
    const snr = speech - floor;
    return {
      floor,
      speech,
      calibrated: this.counted > 0 && snr >= MIN_SNR_DB,
      quiet: floor + QUIET_POSITION * snr,
      voice: floor + Math.max(VOICE_MIN_DB, VOICE_POSITION * snr),
    };
  }

  /**
   * Whether frames [from, to) hold speech: at least `minFrames` frames above
   * the voice level, in stretches of 60 ms or more. Undefined when that
   * cannot be told.
   */
  hasVoice(from: number, to: number, levels: Levels, minFrames = 8): boolean | undefined {
    if (!levels.calibrated) {
      return undefined;
    }
    let voiced = 0;
    let run = 0;
    for (let f = from; f <= to; f++) {
      if (f < to && this.dbs[f] >= levels.voice) {
        run++;
        continue;
      }
      if (run >= VOICE_RUN_FRAMES) {
        voiced += run;
        if (voiced >= minFrames) {
          return true;
        }
      }
      run = 0;
    }
    return false;
  }

  /** Frames of [from, to) at the voice level or above. */
  voicedFrames(from: number, to: number, levels: Levels): number {
    let voiced = 0;
    for (let f = from; f < to; f++) {
      if (this.dbs[f] >= levels.voice) {
        voiced++;
      }
    }
    return voiced;
  }

  /** Whether every frame of [from, to) is as quiet as a dead microphone. */
  isDeadMic(from: number, to: number): boolean {
    for (let f = from; f < to; f++) {
      if (this.dbs[f] >= DEAD_MIC_DBFS) {
        return false;
      }
    }
    return to > from;
  }

  private push(db: number): void {
    if (this.count === this.dbs.length) {
      const grown = new Float32Array(this.dbs.length * 2);
      grown.set(this.dbs);
      this.dbs = grown;
    }
    const frame = this.count++;
    this.dbs[frame] = db;
    if (this.firstLive < 0) {
      if (db <= DEAD_AIR_DBFS) {
        return; // the device is still starting up
      }
      this.firstLive = frame;
    }
    // Binned from the stored (32-bit) value, as when it leaves the window, so add and remove hit the same bin
    this.histogram[this.bin(this.dbs[frame])]++;
    this.counted++;
    const leaving = frame - LEVEL_WINDOW_FRAMES;
    if (leaving >= this.firstLive) {
      this.histogram[this.bin(this.dbs[leaving])]--;
      this.counted--;
    }
  }

  private bin(db: number): number {
    return Math.min(this.histogram.length - 1, Math.max(0, Math.round(db - DEAD_AIR_DBFS)));
  }

  /**
   * The room noise: the quietest level that at least 1% of the frames share,
   * within 5 dB. A percentile would not do: a fluent speaker can leave pauses
   * in fewer than one frame in ten, and the 10th percentile is then speech.
   */
  private noiseFloor(): number {
    const width = 5;
    const needed = Math.max(5, Math.ceil(this.counted * 0.01));
    for (let bin = 0; bin + width <= this.histogram.length; bin++) {
      let count = 0;
      let weighted = 0;
      for (let k = 0; k < width; k++) {
        count += this.histogram[bin + k];
        weighted += this.histogram[bin + k] * (bin + k);
      }
      if (count >= needed) {
        return weighted / count + DEAD_AIR_DBFS;
      }
    }
    return this.percentile(0.1);
  }

  /** The level below which the given share of the counted frames lie. */
  private percentile(share: number): number {
    if (this.counted === 0) {
      return DEAD_AIR_DBFS;
    }
    const rank = share * this.counted;
    let seen = 0;
    for (let bin = 0; bin < this.histogram.length; bin++) {
      seen += this.histogram[bin];
      if (seen >= rank && seen > 0) {
        return bin + DEAD_AIR_DBFS;
      }
    }
    return 0;
  }
}

/**
 * When a part may be cut, in seconds from its start. The first part of a
 * recording waits FIRST_PART_EXTRA_S longer: dictations shorter than that are
 * sent whole, as before, since they come back quickly anyway.
 */
export const MIN_SEGMENT_S = 20;
export const FIRST_PART_EXTRA_S = 20;
/**
 * Until then the longest pause is chosen, likelier the end of a sentence than
 * the first one long enough (or the first of PROMPT_PAUSE_MS, a finished thought).
 */
const CHOOSE_UNTIL_S = 30;
/** Then the first pause of PAUSE_MS... */
const RELAX_UNTIL_S = 38;
/** ...then of SHORT_PAUSE_MS, until the part is cut at its quietest moment. */
export const MAX_SEGMENT_S = 45;

/** A pause this long is taken at once. */
const PROMPT_PAUSE_MS = 2000;
/** The shortest pause chosen until RELAX_UNTIL_S. */
const PAUSE_MS = 450;
/** The shortest pause chosen after that: shorter quiet stretches can be inside a word. */
const SHORT_PAUSE_MS = 350;
/** A cut stays this far from the edges of its pause, where a word can trail off... */
const PAUSE_EDGE_MS = 100;
/** ...and within this much of the pause's start, leaving the rest of a long pause to the next part. */
const PAUSE_DEPTH_MS = 600;
/** A forced cut never falls in this last stretch read: the word there may go on. */
const LOOKAHEAD_MS = 300;

export interface Cut {
  /** The first frame of the next part. */
  frame: number;
  /** Length of the pause cut in, as far as it was heard; for a forced cut, of the quiet stretch it chose (0: none). */
  pauseMs: number;
  /** No pause came in time: cut at the quietest moment instead. */
  forced: boolean;
}

interface Run {
  start: number;
  length: number;
}

const ms = (count: number) => count * FRAME_MS;
const framesOf = (milliseconds: number) => Math.ceil(milliseconds / FRAME_MS);

/** Stretches of frames whose smoothed level is below `threshold`, in [from, to). */
function quietRuns(track: LoudnessTrack, from: number, to: number, threshold: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let f = from; f <= to; f++) {
    if (f < to && track.smoothed(f) < threshold) {
      if (start < 0) {
        start = f;
      }
      continue;
    }
    if (start >= 0) {
      runs.push({ start, length: f - start });
      start = -1;
    }
  }
  return runs;
}

/**
 * The frame to cut a quiet stretch at: its quietest 60 ms, at least 100 ms
 * from either edge and within 600 ms of its start; the middle of a stretch
 * too short for that.
 */
function placeIn(track: LoudnessTrack, run: Run): number {
  const from = run.start + framesOf(PAUSE_EDGE_MS);
  const to = Math.min(run.start + run.length - framesOf(PAUSE_EDGE_MS), run.start + framesOf(PAUSE_DEPTH_MS));
  if (to <= from) {
    return run.start + Math.floor(run.length / 2);
  }
  let best = from;
  let bestPower = Infinity;
  for (let f = from; f <= to; f++) {
    const power = track.power(f - 1, f + 2);
    if (power < bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

/**
 * Where to cut the part that starts at frame `start`, with frames up to (not
 * including) `end` measured; undefined while it should grow:
 * - from MIN_SEGMENT_S to CHOOSE_UNTIL_S, the first pause of two seconds or
 *   more, or else the longest one of at least 450 ms once that stretch has passed;
 * - then the first pause of 450 ms, from RELAX_UNTIL_S of 350 ms;
 * - at MAX_SEGMENT_S, the quietest moment: the longest fairly quiet stretch,
 *   or else the quietest 250 ms.
 * A first part (`first`) has every limit FIRST_PART_EXTRA_S later. Nothing is
 * ever cut while pauses cannot be told from words.
 */
export function findCut(track: LoudnessTrack, start: number, end: number, levels: Levels, first = false): Cut | undefined {
  const extra = first ? FIRST_PART_EXTRA_S : 0;
  const frameAt = (seconds: number) => start + Math.round((seconds + extra) * PER_SECOND);
  const eligible = frameAt(MIN_SEGMENT_S);
  const chooseUntil = frameAt(CHOOSE_UNTIL_S);
  const relaxUntil = frameAt(RELAX_UNTIL_S);
  const hard = frameAt(MAX_SEGMENT_S);
  if (end <= eligible || !levels.calibrated) {
    return undefined;
  }
  const cutIn = (run: Run): Cut => ({ frame: placeIn(track, run), pauseMs: ms(run.length), forced: false });

  // A pause that began shortly before the eligible point counts in full. Nothing
  // past the forced cut can be chosen, so a long backlog (a stretch that could
  // not be cut until the levels settled) is not scanned again for every cut.
  const runs = quietRuns(track, Math.max(start + 1, eligible - framesOf(PROMPT_PAUSE_MS)), Math.min(end, hard + framesOf(PROMPT_PAUSE_MS)), levels.quiet)
    .filter((run) => run.start + run.length > eligible);
  let longest: Run | undefined;
  for (const run of runs) {
    if (run.start >= chooseUntil) {
      break;
    }
    if (ms(run.length) >= PROMPT_PAUSE_MS) {
      return cutIn(run);
    }
    if (ms(run.length) >= PAUSE_MS && (!longest || run.length > longest.length)) {
      longest = run;
    }
  }
  if (end < chooseUntil) {
    return undefined;
  }
  if (longest) {
    return cutIn(longest);
  }
  const later = runs.find((run) => run.start >= chooseUntil && ms(run.length) >= (run.start < relaxUntil ? PAUSE_MS : SHORT_PAUSE_MS));
  if (later) {
    return cutIn(later);
  }
  if (end < hard) {
    return undefined;
  }
  return forcedCut(track, eligible, Math.min(end - framesOf(LOOKAHEAD_MS), hard), levels);
}

/** No pause came: the longest fairly quiet stretch of 200 ms or more, or else the quietest 250 ms. */
function forcedCut(track: LoudnessTrack, from: number, to: number, levels: Levels): Cut | undefined {
  const snr = levels.speech - levels.floor;
  for (const position of [0.4, 0.5]) {
    const runs = quietRuns(track, from, to, levels.floor + position * snr).filter((run) => ms(run.length) >= 200);
    if (runs.length > 0) {
      const run = runs.reduce((a, b) => (b.length >= a.length ? b : a));
      return { frame: placeIn(track, run), pauseMs: ms(run.length), forced: true };
    }
  }
  // Smoothed, so that a dropout inside a word never looks like the quietest moment
  const window = framesOf(250);
  let best = -1;
  let bestPower = Infinity;
  for (let w = from; w + window <= to; w++) {
    const power = track.power(w, w + window, true);
    if (power < bestPower) {
      bestPower = power;
      best = w;
    }
  }
  if (best < 0) {
    return undefined;
  }
  // Its quietest 40 ms
  let cut = best + 1;
  let cutPower = Infinity;
  for (let f = best; f + 2 <= best + window; f++) {
    const power = track.power(f, f + 2, true);
    if (power < cutPower) {
      cutPower = power;
      cut = f + 1;
    }
  }
  return { frame: cut, pauseMs: 0, forced: true };
}
