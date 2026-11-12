import * as crypto from 'crypto';
import type { AudioDataPayload, TranscriptionResult } from '../types';
import { GrowingWavFile } from '../recorder/GrowingWavFile';
import { buildWav, isPcm16, parseWavLayout, wavDataEnd, type WavLayout } from '../recorder/Wav';
import { isUnambiguousHallucination } from '../postprocess/HallucinationFilter';
import { FRAME_MS, LoudnessTrack, findCut } from './SpeechPauses';
import { joinTranscripts, matchOpeningCase, splitWords, stitchTexts, textOf, wordCount, type Split, type TimedWords } from './Stitch';

export { joinTranscripts } from './Stitch';

/**
 * Transcribes a long dictation while it is still being recorded: the
 * recording is cut at the speaker's pauses (see SpeechPauses) and each part is
 * sent to speech-to-text while the user goes on speaking, so that when they
 * stop only the last part is left to transcribe.
 *
 * Reads the recorder's temporary WAV file as it grows. Each request carries
 * OVERLAP seconds of audio past the cuts on either side of its part, so that
 * speech-to-text hears how a sentence goes on across a cut and does not end it
 * there; each word is then kept from one part only (see Stitch). One request
 * is in flight at a time, and each covers everything not transcribed yet, so a
 * part that failed goes again with the next one; after two failed requests in
 * a row nothing more is sent while recording.
 *
 * finish() is the hand-over at the stop. Its contract:
 * - resolves the dictation's result when every part sent was transcribed;
 * - resolves undefined when the caller should transcribe the whole recording
 *   as before: it was never cut (short dictations), no part was transcribed,
 *   the settings changed, the final file is not the audio that was cut, two
 *   parts' texts could not be joined without saying words twice, or anything
 *   here went wrong;
 * - rejects with the provider's error when the rest of the recording could not
 *   be transcribed: the caller reports it and keeps the recording for Retry;
 * - rejects with an AbortError when, and only when, the pipeline's signal aborts.
 */

export interface LiveTranscriptionOptions {
  /** Transcribe one part, a WAV file, with `prompt`. */
  transcribe(wav: Buffer, signal: AbortSignal, prompt: string | undefined): Promise<TranscriptionResult>;
  /**
   * The prompt sent with every part (the vocabulary hint), or none. Nobody
   * dictates it, so a part whose text is this read back (speech-to-text does
   * that on noise) is dropped.
   */
  prompt?: string;
  /**
   * Keep a cut part until this much speech follows it (pauses do not count),
   * and until the request holds that much speech itself. When the recording
   * stops sooner, the part and the rest go as one request, so a short part is
   * never recognised on its own (0: send parts once their overlap is recorded).
   */
  holdSpeechSeconds: number;
  /** Audio each request carries past the cuts on either side of its part. */
  overlapSeconds?: number;
  /** A reason to stop, when the settings the parts are sent with have changed. */
  invalidated?(): string | undefined;
  /**
   * A request was transcribed: it covered `seconds` of the recording (its own
   * stretch; it was billed for more, the overlaps), at the cost in `result`.
   */
  onTranscribed?(seconds: number, result: TranscriptionResult): void;
  /** The live transcription ended without its result being used: what it had transcribed, and so was billed for. */
  onDiscarded?(billed: Billed): void;
  log?(message: string): void;
  /** How often the file is read. */
  pollMs?: number;
  /** Pause before a failed request is sent again. */
  retryDelayMs?: number;
  /** How long a part sent while recording may take; the default gives a minute plus 3 s per second of audio. */
  requestTimeoutMs?(audioSeconds: number): number;
  /**
   * Once the recording has stopped, how long after it was sent a part still in
   * flight is waited for before it is given up and its audio goes with the
   * rest; the default gives 10 s plus 0.36 s per second of audio, its upload
   * included.
   */
  stopWaitMs?(audioSeconds: number): number;
}

/** Audio transcribed (overlaps counted twice, as they are billed), and its estimated cost. */
export interface Billed {
  requests: number;
  /** Seconds of audio sent, overlaps counted twice. */
  seconds: number;
  /** Seconds of the recording those requests covered. */
  recordingSeconds: number;
  cost: number;
}

/** 2.5 s on either side of each cut: neighbouring requests share 5 s of audio. */
export const DEFAULT_OVERLAP_SECONDS = 2.5;
/**
 * How long the recorder may take to write the WAV header before live
 * transcription gives up: pw-record and ffmpeg create the file only once the
 * sound server or device answers, and macOS may be asking for the microphone.
 */
const HEADER_TIMEOUT_MS = 15_000;
/** The rest of a recording is sent when it holds this many frames of speech (100 ms): losing a last word is worse than one more request. */
const REST_VOICE_FRAMES = 5;
/** A part's text counts as the prompt read back only from this many letters on. */
const MIN_ECHO_LETTERS = 20;

/** A part sent while recording that gets no answer by then has failed (the rest, after the stop, waits as long as it takes). */
function requestTimeoutMs(audioSeconds: number): number {
  return 60_000 + audioSeconds * 3000;
}

/**
 * After the stop, a part in flight is given up this long after it was sent:
 * three times what ElevenLabs takes for that much audio at the 90th
 * percentile (1.2 s for 10 s, 3.2 s for a minute), and more, plus its upload
 * at 1 Mbit/s (16 kHz 16-bit audio: 0.26 s per second of it).
 */
function stopWaitMs(audioSeconds: number): number {
  return 10_000 + audioSeconds * 360;
}

/** How far back from a cut the request after it may start, to hear the speech a long pause interrupted. */
const MAX_LEAD_IN_S = 10;
/** How much of that speech it hears: frames at the voice level, so a breath or a click in the pause hardly counts. */
const LEAD_IN_SPEECH_S = 1.5;

/** Requests in a row that may fail while recording before nothing more is sent until the stop. */
const MAX_FAILED_ROUNDS = 2;

interface Transcribed {
  /** The part's own stretch of the recording, in frames: its words are kept from this request. */
  ownStart: number;
  ownEnd: number;
  /** Where the request's audio started (before ownStart by the overlap). */
  audioStart: number;
  /** Bytes of audio sent. */
  bytes: number;
  result: TranscriptionResult;
}

type SendOutcome = { kind: 'sent' } | { kind: 'skipped' } | { kind: 'cancelled' } | { kind: 'failed'; error: unknown };

function abortError(): Error {
  const error = new Error('Transcription cancelled');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lower-case letters and digits only, to compare texts whatever their punctuation and spacing. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export class LiveTranscription {
  private readonly abort = new AbortController();
  private readonly pollMs: number;
  private readonly retryDelayMs: number;
  private readonly overlapSeconds: number;
  private readonly openedAt = Date.now();
  private file: GrowingWavFile | undefined;
  private layout: WavLayout | undefined;
  private track: LoudnessTrack | undefined;
  /** The audio read, from frame `pcmFrom` on: the overlap before `unsent` is kept for the next request. */
  private pcm: Buffer[] = [];
  private pcmFrom = 0;
  /** Frame where the audio not transcribed yet (nor let go as silent) starts. */
  private unsent = 0;
  /** Frame where the next request's audio starts: decided once the part before it is done with (see leadIn). */
  private leadFrom = 0;
  /** Every byte of audio read, hashed, to prove that the final recording holds the same audio. */
  private readonly readHash = crypto.createHash('sha1');
  private readBytes = 0;
  /** Where parts end, in frames, after `unsent`. */
  private cuts: number[] = [];
  private cutCount = 0;
  /** The cut the last failed request went up to: the next try waits for a later one. */
  private failedAt: number | undefined;
  private readonly transcribed: Transcribed[] = [];
  private sending: Promise<SendOutcome> | undefined;
  /** The request in flight: when it was sent, how much audio it holds, and how to give it up. */
  private inFlight: { sentAt: number; seconds: number; controller: AbortController } | undefined;
  /** Requests that failed in a row while recording; at MAX_FAILED_ROUNDS nothing more is sent until the stop. */
  private failedRounds = 0;
  private gaveUp = false;
  /** Aborted at the stop: a pause before sending a failed part again ends there, and the part goes with the rest. */
  private readonly hurry = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detached = false;
  /** No more reading or cutting: why. What was cut is still sent. */
  private stopped: string | undefined;
  /** The settings the parts were sent with changed: why. Nothing more is sent, and finish() leaves the recording to the caller. */
  private invalid: string | undefined;
  private closed = false;
  /** finish() has the recording: nothing new is sent but its rest. */
  private finishing = false;
  private pipelineSignal: AbortSignal | undefined;
  private readonly onPipelineAbort = () => this.cancel();

  private constructor(private readonly path: string, private readonly options: LiveTranscriptionOptions) {
    this.pollMs = options.pollMs ?? 500;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
    this.overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  }

  /** Start following the recording that is being written to `file`. */
  static start(file: string, options: LiveTranscriptionOptions): LiveTranscription {
    const live = new LiveTranscription(file, options);
    live.schedule();
    return live;
  }

  /** Parts cut so far. */
  get segmentCount(): number {
    return this.cutCount;
  }

  /** Seconds of the recording read so far. */
  get secondsRead(): number {
    return this.seconds(this.readBytes);
  }

  /** What was transcribed so far, and so billed. */
  billed(): Billed {
    const frameBytes = this.track?.frameBytes ?? 0;
    return {
      requests: this.transcribed.length,
      seconds: this.transcribed.reduce((sum, t) => sum + this.seconds(t.bytes), 0),
      recordingSeconds: this.transcribed.reduce((sum, t) => sum + this.seconds((t.ownEnd - t.ownStart) * frameBytes), 0),
      cost: this.transcribed.reduce((sum, t) => sum + (t.result.cost ?? 0), 0),
    };
  }

  /**
   * The recording is stopping: stop reading the file, which the recorder is
   * about to delete, and from now on cancel when `signal` (the pipeline's)
   * aborts. Parts already cut are still sent.
   */
  detach(signal?: AbortSignal): void {
    if (!this.detached) {
      this.detached = true;
      clearTimeout(this.timer);
      this.timer = undefined;
      const file = this.file;
      this.file = undefined;
      void file?.close(); // after a read in flight, which then finds the session detached
    }
    if (signal && signal !== this.pipelineSignal && !this.closed) {
      if (signal.aborted) {
        this.cancel();
        return;
      }
      this.pipelineSignal?.removeEventListener('abort', this.onPipelineAbort);
      this.pipelineSignal = signal;
      signal.addEventListener('abort', this.onPipelineAbort, { once: true });
    }
  }

  /** The dictation was cancelled or the recording lost: stop everything, send nothing more. */
  cancel(): void {
    this.close(false);
  }

  /** The recording has stopped and `audio` is all of it. See the contract at the top. */
  async finish(audio: AudioDataPayload, signal: AbortSignal): Promise<TranscriptionResult | undefined> {
    if (signal.aborted) {
      this.cancel();
      throw abortError();
    }
    this.detach(signal);
    this.finishing = true;
    this.hurry.abort();
    let used = false;
    let restFailure: { error: unknown } | undefined;
    try {
      if (this.closed || this.cutCount === 0) {
        return undefined;
      }
      if (this.isInvalid()) {
        this.log(`Not used: ${this.invalid}. The whole recording is transcribed instead.`);
        return undefined;
      }
      await this.settleInFlight(); // parts cut but not sent go with the rest
      if (signal.aborted) {
        throw abortError();
      }
      if (this.transcribed.length === 0) {
        this.log('No part was transcribed while recording; the whole recording is transcribed instead');
        return undefined;
      }
      const rest = this.takeRest(audio.buffer);
      if (rest === undefined) {
        return undefined;
      }
      const startedAt = Date.now();
      const outcome = await this.send(rest.ownEnd, false, rest.audio);
      if (signal.aborted) {
        throw abortError();
      }
      if (outcome.kind === 'cancelled') {
        return undefined;
      }
      if (outcome.kind === 'failed') {
        restFailure = { error: outcome.error };
        throw outcome.error;
      }
      const result = this.combine();
      if (!result) {
        return undefined;
      }
      this.log(`Done ${((Date.now() - startedAt) / 1000).toFixed(1)} s after the stop: ${this.transcribed.length} part(s), ${result.text.length} chars`);
      used = true;
      return result;
    } catch (error) {
      if (signal.aborted) {
        throw abortError();
      }
      if (restFailure) {
        throw restFailure.error; // the caller reports it and keeps the recording
      }
      this.log(`Failed (${errorMessage(error)}); the whole recording is transcribed instead`);
      return undefined;
    } finally {
      this.close(used);
    }
  }

  /**
   * At the stop: wait for the part in flight, but no longer than stopWaitMs
   * after it was sent. Then it is given up (it is not sent again) and, as it
   * did not move `unsent`, its audio goes with the rest.
   */
  private async settleInFlight(): Promise<void> {
    const sending = this.sending;
    const inFlight = this.inFlight;
    if (!sending) {
      return;
    }
    if (inFlight) {
      const limit = inFlight.sentAt + (this.options.stopWaitMs ?? stopWaitMs)(inFlight.seconds) - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        sending.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), Math.max(0, limit)); }),
      ]);
      clearTimeout(timer);
      if (late) {
        this.log(`The part in flight has had no answer ${((Date.now() - inFlight.sentAt) / 1000).toFixed(1)} s after it was sent; it goes again with the rest`);
        inFlight.controller.abort();
      }
    }
    await sending;
  }

  private schedule(): void {
    if (this.detached || this.stopped || this.closed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, this.pollMs);
  }

  /** Read what the recorder wrote since the last poll; cut and send what is ready. */
  private async poll(): Promise<void> {
    try {
      if (!this.file) {
        let file: GrowingWavFile;
        try {
          file = await GrowingWavFile.open(this.path);
        } catch (error) {
          this.giveUpUnlessHeaderComes(`the recording could not be opened (${errorMessage(error)})`);
          return;
        }
        if (this.detached) {
          await file.close();
          return;
        }
        this.file = file;
      }
      const pcm = await this.file.read();
      if (this.detached) {
        return;
      }
      if (!this.layout) {
        if (!this.file.format) {
          this.giveUpUnlessHeaderComes('the recorder wrote no WAV header');
          return;
        }
        this.layout = this.file.format;
        this.track = new LoudnessTrack(this.layout.sampleRate * this.layout.channels);
        this.log(`Following ${this.layout.sampleRate} Hz, ${this.layout.channels} channel(s) from byte ${this.layout.dataStart}`);
      }
      if (pcm.length > 0) {
        this.pcm.push(pcm);
        this.readHash.update(pcm);
        this.readBytes += pcm.length;
        this.track!.add(pcm);
        this.cutWhatIsReady();
      }
      this.pump();
    } catch (error) {
      if (!this.detached) {
        this.stop(`reading the recording failed (${errorMessage(error)})`);
      }
    }
  }

  private giveUpUnlessHeaderComes(reason: string): void {
    if (Date.now() - this.openedAt > HEADER_TIMEOUT_MS) {
      this.stop(reason);
    }
  }

  /** Stop reading and cutting; what was cut is still sent, and the rest goes at the stop. */
  private stop(reason: string): void {
    if (this.stopped || this.closed) {
      return;
    }
    this.stopped = reason;
    this.log(`Stopped following the recording: ${reason}`);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cutWhatIsReady(): void {
    const track = this.track!;
    for (;;) {
      const from = this.cuts.length > 0 ? this.cuts[this.cuts.length - 1] : this.unsent;
      const levels = track.levels();
      const cut = findCut(track, from, track.frames, levels, this.cutCount === 0);
      if (!cut) {
        return;
      }
      this.cuts.push(cut.frame);
      this.cutCount++;
      const at = (cut.frame * FRAME_MS) / 1000;
      const length = ((cut.frame - from) * FRAME_MS) / 1000;
      const how = cut.forced ? `no pause came: forced, in a ${cut.pauseMs} ms quiet stretch` : `in a ${cut.pauseMs} ms pause`;
      this.log(`Part ${this.cutCount}: cut at ${at.toFixed(1)} s (${length.toFixed(1)} s long), ${how}; `
        + `floor ${levels.floor.toFixed(0)} dB, speech ${levels.speech.toFixed(0)} dB, quiet below ${levels.quiet.toFixed(0)} dB`);
    }
  }

  /**
   * Send everything up to the latest cut that is ready, when nothing is in
   * flight. A cut is ready once the overlap past it is recorded and, with a
   * hold (language auto-detected), once enough speech follows it and the
   * request would hold that much speech itself, so neither a part nor the rest
   * after it is recognised from a few words. Leading parts without any speech
   * are let go first, unsent.
   */
  private pump(): void {
    if (this.sending || this.closed || this.finishing || this.gaveUp || !this.track || this.isInvalid()) {
      return;
    }
    const track = this.track;
    const levels = track.levels();
    while (this.cuts.length > 0 && (track.isDeadMic(this.unsent, this.cuts[0]) || track.hasVoice(this.unsent, this.cuts[0], levels) === false)) {
      const cut = this.cuts[0];
      this.log(`${this.range(this.unsent, cut)}: no speech, not sent`);
      // A word too short to count as speech may be in it: the next request starts early enough to hear it
      this.advance(cut, track.hasVoice(this.unsent, cut, levels, 3) === true);
    }
    const hold = this.options.holdSpeechSeconds;
    const overlap = this.overlapFrames();
    const spoken = (from: number, to: number) => (track.voicedFrames(from, to, levels) * FRAME_MS) / 1000;
    const ready = this.cuts.filter((cut) => (this.failedAt === undefined || cut > this.failedAt)
      && track.frames >= cut + overlap
      && (hold <= 0 || (spoken(cut, track.frames) >= hold && spoken(this.unsent, cut) >= hold)));
    if (ready.length === 0) {
      return;
    }
    const sending = this.send(ready[ready.length - 1], true);
    this.sending = sending;
    void sending.finally(() => {
      if (this.sending === sending) {
        this.sending = undefined;
      }
      this.pump();
    });
  }

  /**
   * Transcribe the part from `unsent` to `ownEnd`, with the overlap on either
   * side, once more after a failure; let it go when it holds no speech. The
   * rest of the recording comes as `audio` (from the overlap before `unsent`
   * to the end). Never rejects.
   */
  private async send(ownEnd: number, whileRecording: boolean, audio?: Buffer): Promise<SendOutcome> {
    try {
      return await this.trySend(ownEnd, whileRecording, audio);
    } catch (error) {
      this.log(`Sending failed: ${errorMessage(error)}`);
      return { kind: 'failed', error };
    }
  }

  private async trySend(ownEnd: number, whileRecording: boolean, rest?: Buffer): Promise<SendOutcome> {
    const track = this.track!;
    const ownStart = this.unsent;
    const audioStart = this.audioStart();
    const pcm = rest ?? this.slice(audioStart, Math.min(ownEnd + this.overlapFrames(), track.frames));
    const seconds = this.seconds(pcm.length);
    const range = this.range(ownStart, ownEnd);
    const voice = track.hasVoice(ownStart, ownEnd, track.levels(), whileRecording ? undefined : REST_VOICE_FRAMES);
    if (track.isDeadMic(ownStart, ownEnd) || voice === false) {
      this.log(`${range}: no speech, not sent`);
      this.advance(ownEnd, track.hasVoice(ownStart, ownEnd, track.levels(), 3) === true);
      return { kind: 'skipped' };
    }

    const wav = buildWav(this.layout!, pcm);
    const prompt = this.options.prompt;
    let error: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (this.closed) {
        return { kind: 'cancelled' };
      }
      const sentAt = Date.now();
      try {
        const timeout = whileRecording ? (this.options.requestTimeoutMs ?? requestTimeoutMs)(seconds) : undefined;
        const result = this.clean(await this.request(wav, prompt, timeout, seconds));
        this.transcribed.push({ ownStart, ownEnd, audioStart, bytes: pcm.length, result });
        this.advance(ownEnd);
        this.failedAt = undefined;
        this.failedRounds = 0;
        this.log(`${range} (sent ${this.range(audioStart, audioStart + Math.floor(pcm.length / track.frameBytes))}, ${Math.round(wav.length / 1024)} KB) `
          + `transcribed in ${((Date.now() - sentAt) / 1000).toFixed(1)} s: ${result.text.length} chars, language=${result.language ?? 'n/a'}`
          + `${result.confidence !== undefined ? ` (${result.confidence.toFixed(2)})` : ''}${result.words ? `, ${result.words.length} timed words` : ''}`);
        this.options.onTranscribed?.(this.seconds((ownEnd - ownStart) * track.frameBytes), result);
        return { kind: 'sent' };
      } catch (failure) {
        if (this.closed) {
          return { kind: 'cancelled' };
        }
        error = failure;
        // Once the recording has stopped, a part sent while recording goes with the rest instead of again
        const again = attempt === 1 && !(whileRecording && this.finishing);
        this.log(`${range} failed${again ? `, sending it again in ${this.retryDelayMs / 1000} s` : ''}: ${errorMessage(failure)}`);
        if (!again) {
          break;
        }
        await this.pause(this.retryDelayMs);
        if (whileRecording && this.finishing) {
          break;
        }
      }
    }
    this.failedAt = ownEnd;
    if (whileRecording) {
      this.failedRounds++;
      if (this.finishing) {
        this.log('It goes with the rest');
      } else if (this.failedRounds >= MAX_FAILED_ROUNDS) {
        this.gaveUp = true;
        this.stop(`${this.failedRounds} requests in a row failed; nothing more is sent until the recording stops`);
      } else {
        this.log('It goes again with the next part, or with the rest at the stop');
      }
    }
    return { kind: 'failed', error };
  }

  /**
   * One request, aborted with the session, and timed out when `timeoutMs` is
   * set (a timeout is a failure, not a cancel). A part sent while recording
   * can also be given up at the stop (settleInFlight).
   */
  private async request(wav: Buffer, prompt: string | undefined, timeoutMs: number | undefined, seconds: number): Promise<TranscriptionResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.abort.signal.addEventListener('abort', onAbort, { once: true });
    const inFlight = timeoutMs === undefined ? undefined : { sentAt: Date.now(), seconds, controller };
    this.inFlight = inFlight;
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await this.options.transcribe(wav, controller.signal, prompt);
    } catch (error) {
      if (timedOut) {
        throw new Error(`no answer within ${Math.round(timeoutMs! / 1000)} s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onAbort);
      if (this.inFlight === inFlight) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * A request's text, without what speech-to-text makes up for audio without
   * words: the prompt read back, or a phrase that is never dictated (subtitle
   * credits, a lone sound tag). "Thank you." stays: as the last part of a
   * dictation it is what was said.
   */
  private clean(result: TranscriptionResult): TranscriptionResult {
    const text = result.text.trim();
    const said = letters(text);
    const prompt = this.options.prompt === undefined ? '' : letters(this.options.prompt);
    // A few words of the prompt can be dictated; a read-back prompt is longer than that
    const echo = prompt !== '' && said.length >= MIN_ECHO_LETTERS && (prompt.includes(said) || said.includes(prompt));
    if (said && (echo || isUnambiguousHallucination(text))) {
      this.log(`Dropped a part's text that was not dictated: "${text}"`);
      return { ...result, text: '', words: result.words ? [] : undefined };
    }
    return result;
  }

  /**
   * The rest of the recording, from the final file: its own end and its
   * audio (from the overlap before `unsent`), after checking that the file
   * holds exactly the audio that was read. When nothing is said after the last
   * part cut, the rest ends at that cut: the pause the recording ended with is
   * not billed.
   */
  private takeRest(buffer: Buffer): { ownEnd: number; audio: Buffer } | undefined {
    const layout = parseWavLayout(buffer);
    const live = this.layout!;
    const track = this.track!;
    if (!layout || !isPcm16(layout) || layout.sampleRate !== live.sampleRate || layout.channels !== live.channels || layout.dataStart !== live.dataStart) {
      this.log('The final recording is not laid out as the one that was followed; the whole recording is transcribed instead');
      return undefined;
    }
    const pcm = buffer.subarray(layout.dataStart, wavDataEnd(layout, buffer.length));
    if (pcm.length < this.readBytes
      || crypto.createHash('sha1').update(pcm.subarray(0, this.readBytes)).digest('hex') !== this.readHash.copy().digest('hex')) {
      this.log('The final recording differs from the audio that was followed; the whole recording is transcribed instead');
      return undefined;
    }
    // What arrived after the last read is measured too, so the rest can be judged
    track.add(pcm.subarray(this.readBytes));
    const end = Math.floor(pcm.length / track.frameBytes);
    const lastCut = this.cuts[this.cuts.length - 1];
    const quietEnd = lastCut !== undefined && track.hasVoice(lastCut, end, track.levels(), REST_VOICE_FRAMES) === false;
    const ownEnd = quietEnd ? lastCut : end;
    const audio = Buffer.from(pcm.subarray(this.audioStart() * track.frameBytes, quietEnd ? lastCut * track.frameBytes : pcm.length));
    const held = this.cuts.length;
    this.log(`At the stop: ${this.seconds((ownEnd - this.unsent) * track.frameBytes).toFixed(1)} s left to transcribe`
      + `${held > 0 ? `, with ${held} part(s) not sent yet` : ''}`
      + `${quietEnd ? `, and ${this.seconds(pcm.length - lastCut * track.frameBytes).toFixed(1)} s of silence after them, not sent` : ''}`);
    return { ownEnd, audio };
  }

  /**
   * The dictation's result from its parts' results, each word taken from one
   * part; undefined when two parts' texts could not be joined without saying
   * the words they share twice.
   */
  private combine(): TranscriptionResult | undefined {
    const parts = this.transcribed;
    // Word timings are used when every part has them and they hold the very words of its text
    const timed = parts.every((t) => t.result.words !== undefined
      && letters(textOf(t.result.words, 0, wordCount(t.result.words))) === letters(t.result.text));
    const texts = timed ? this.byTimestamps() : this.stitched();
    if (!texts) {
      return undefined;
    }
    for (let i = 1; i < texts.length; i++) {
      const before = texts[i - 1].trim().split(/\s+/).slice(-3).join(' ');
      const after = texts[i].trim().split(/\s+/).slice(0, 3).join(' ');
      if (before && after) {
        this.log(`Join ${i}: "…${before}" + "${after}…"`);
      }
    }
    const byLanguage = new Map<string, number>();
    for (const t of parts) {
      if (t.result.language) {
        byLanguage.set(t.result.language, (byLanguage.get(t.result.language) ?? 0) + t.bytes);
      }
    }
    const language = [...byLanguage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // The recording the parts covered (the overlaps, billed twice, are in the cost)
    const { recordingSeconds, cost } = this.billed();
    return { text: joinTranscripts(texts), language, duration: recordingSeconds, cost };
  }

  /** Seconds of the recording at `frame`. */
  private at(frame: number): number {
    return this.seconds(frame * this.track!.frameBytes);
  }

  /**
   * The parts' texts from their word timings (ElevenLabs): neighbours split
   * where Stitch.splitWords says. A part next to a stretch that was let go as
   * silent keeps every word it heard on that side: no other request heard them.
   */
  private byTimestamps(): string[] {
    const parts = this.transcribed;
    const timed: TimedWords[] = parts.map((t) => ({ words: t.result.words!, audioStart: this.at(t.audioStart) }));
    const splits: Array<Split | undefined> = parts.slice(0, -1)
      .map((t, i) => (parts[i + 1].ownStart === t.ownEnd ? splitWords(timed[i], timed[i + 1], this.at(t.ownEnd)) : undefined));
    return parts.map((t, i) => {
      const from = i > 0 ? splits[i - 1]?.rightStart : undefined;
      const to = i < splits.length ? splits[i]?.leftEnd : undefined;
      const count = wordCount(timed[i].words);
      const text = textOf(timed[i].words, from ?? 0, Math.max(from ?? 0, to ?? count));
      return from === undefined ? text : matchOpeningCase(text, timed[i], timed[i - 1], from);
    });
  }

  /**
   * The parts' texts with the words said twice (in the overlap of two
   * neighbouring requests) left out once, for providers that give no word
   * timings. Undefined when two neighbours' texts share no words although
   * their overlap held speech: joined as they are, they would say it twice.
   */
  private stitched(): string[] | undefined {
    const parts = this.transcribed;
    const track = this.track!;
    const texts: string[] = [];
    let current = parts[0]?.result.text ?? '';
    for (let i = 1; i < parts.length; i++) {
      const next = parts[i].result.text;
      // The audio both requests heard: from the second's start to the end of the first's
      const sharedFrom = parts[i].audioStart;
      const sharedTo = parts[i - 1].audioStart + Math.floor(parts[i - 1].bytes / track.frameBytes);
      const neighbours = parts[i].ownStart === parts[i - 1].ownEnd && sharedTo > sharedFrom;
      if (!neighbours || !current.trim() || !next.trim() || track.hasVoice(sharedFrom, sharedTo, track.levels()) === false) {
        // A stretch let go as silent lies between them, one heard nothing, or they shared only silence: nothing was said twice
        texts.push(current);
        current = next;
        continue;
      }
      // How much of each text the shared audio can hold: its share of the speech each request heard
      const levels = track.levels();
      const speech = (from: number, to: number) => Math.max(1, track.voicedFrames(from, to, levels));
      const shared = speech(sharedFrom, sharedTo);
      const joined = stitchTexts(current, next, {
        leftShare: shared / speech(parts[i - 1].audioStart, sharedTo),
        rightShare: shared / speech(sharedFrom, parts[i].audioStart + Math.floor(parts[i].bytes / track.frameBytes)),
      });
      if (!joined) {
        this.log(`Join ${i}: the two parts share no words although their overlap held speech; the whole recording is transcribed instead`);
        return undefined;
      }
      texts.push(joined.left);
      current = joined.right;
    }
    texts.push(current);
    return texts;
  }

  /** Where the request for the audio not transcribed yet starts: see leadIn; not before the audio kept. */
  private audioStart(): number {
    return Math.max(this.pcmFrom, this.leadFrom, 0);
  }

  /**
   * Where the audio of the request after `cut` starts: the overlap before the
   * cut, or, when that holds less than LEAD_IN_SPEECH_S of speech (the cut
   * lies deep in a long pause), from where that much speech is reached going
   * back, at most MAX_LEAD_IN_S. So the request hears the words the pause
   * interrupted, and how the sentence goes on after it. Speech is counted in
   * frames at the voice level, so a breath or a click in the pause moves the
   * start by its own length only; a stretch of less speech than that starts
   * just before it.
   */
  private leadIn(cut: number): number {
    const normal = cut - this.overlapFrames();
    const track = this.track;
    if (!track) {
      return normal;
    }
    const frames = (s: number) => Math.round((s * 1000) / FRAME_MS);
    const levels = track.levels();
    const limit = Math.max(0, cut - frames(MAX_LEAD_IN_S));
    let voiced = 0;
    let earliest: number | undefined;
    for (let f = Math.min(cut, track.frames) - 1; f >= limit; f--) {
      if (track.db(f) >= levels.voice) {
        voiced++;
        earliest = f;
        if (voiced >= frames(LEAD_IN_SPEECH_S)) {
          return Math.min(normal, f);
        }
      }
    }
    return earliest === undefined ? normal : Math.min(normal, Math.max(limit, earliest - frames(0.25)));
  }

  private overlapFrames(): number {
    return Math.round((this.overlapSeconds * 1000) / FRAME_MS);
  }

  /** The audio of frames [from, to), from what is kept. */
  private slice(from: number, to: number): Buffer {
    const frameBytes = this.track!.frameBytes;
    if (this.pcm.length > 1) {
      this.pcm = [Buffer.concat(this.pcm)];
    }
    const all = this.pcm[0] ?? Buffer.alloc(0);
    return Buffer.from(all.subarray((from - this.pcmFrom) * frameBytes, (to - this.pcmFrom) * frameBytes));
  }

  /**
   * Everything before `ownEnd` is done with (transcribed, or let go as
   * silent). Only the audio the next request starts with stays (see leadIn);
   * none after a part without a sound at the voice level, since nothing said
   * goes on across its end.
   */
  private advance(ownEnd: number, keepOverlap = true): void {
    const frameBytes = this.track!.frameBytes;
    const keepFrom = Math.max(this.pcmFrom, keepOverlap ? this.leadIn(ownEnd) : ownEnd);
    this.leadFrom = keepFrom;
    const all = this.pcm.length > 1 ? Buffer.concat(this.pcm) : (this.pcm[0] ?? Buffer.alloc(0));
    const left = all.subarray(Math.min(all.length, (keepFrom - this.pcmFrom) * frameBytes));
    this.pcm = left.length > 0 ? [Buffer.from(left)] : [];
    this.pcmFrom = keepFrom;
    this.unsent = ownEnd;
    this.cuts = this.cuts.filter((cut) => cut > ownEnd);
  }

  private isInvalid(): boolean {
    if (!this.invalid) {
      const reason = this.options.invalidated?.();
      if (reason) {
        this.invalid = reason;
        this.stop(reason);
      }
    }
    return this.invalid !== undefined;
  }

  /** Resolve after `ms`, or as soon as the session is closed or the recording stops. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.hurry.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
      this.hurry.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** End the session: nothing more is read or sent. Reports what was billed when its result is not used. */
  private close(used: boolean): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detach();
    this.pipelineSignal?.removeEventListener('abort', this.onPipelineAbort);
    this.pipelineSignal = undefined;
    this.abort.abort();
    const billed = this.billed();
    if (!used && billed.requests > 0) {
      this.log(`Discarded ${billed.requests} transcribed part(s), ${billed.seconds.toFixed(1)} s`);
      this.options.onDiscarded?.(billed);
    }
  }

  /** "12.3–45.6 s": frames as a stretch of the recording. */
  private range(from: number, to: number): string {
    return `${((from * FRAME_MS) / 1000).toFixed(1)}–${((to * FRAME_MS) / 1000).toFixed(1)} s`;
  }

  private seconds(bytes: number): number {
    const layout = this.layout;
    return layout ? bytes / (layout.sampleRate * layout.blockAlign) : 0;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}
