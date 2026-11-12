import type { TranscribedWord } from '../types';

/**
 * Joining the texts of the parts of a dictation that was transcribed while it
 * was recorded. Neighbouring parts overlap: each was sent with a few seconds
 * of the audio on the other side of its cut, so that speech-to-text heard how
 * the sentence goes on there and did not end it at the cut with a full stop
 * and a capital letter. Each word is then taken from one part only.
 */

/**
 * Scripts written without spaces between words: Thai and Lao, Myanmar, Khmer,
 * CJK punctuation and kana, CJK ideographs (extension A, unified and
 * compatibility), full- and half-width forms. Written as escapes, so that no
 * editor or Unicode normalisation can move the ends of a range.
 */
const NO_SPACE_RANGES = '\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3000-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF';
const NO_SPACE_SCRIPT = new RegExp(`[${NO_SPACE_RANGES}]`, 'u');
/**
 * A token: one letter of a script without spaces with the vowel and tone
 * marks that go with it, or a run of other characters up to a space.
 */
const TOKEN = new RegExp(`(?=[${NO_SPACE_RANGES}])\\P{M}\\p{M}*|[^\\s${NO_SPACE_RANGES}]+`, 'gu');

/** Join consecutive texts: one space between them, none between two characters of a script without spaces. */
export function joinTranscripts(texts: string[]): string {
  let joined = '';
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) {
      continue;
    }
    if (joined && !(NO_SPACE_SCRIPT.test(joined[joined.length - 1]) && NO_SPACE_SCRIPT.test(text[0]))) {
      joined += ' ';
    }
    joined += text;
  }
  return joined;
}

/** Letters, marks and digits only, in lower case: words compared whatever their punctuation and case. */
function keyOf(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** A request's words, timed from the start of its audio, which began `audioStart` seconds into the recording. */
export interface TimedWords {
  words: TranscribedWord[];
  audioStart: number;
}

interface Placed {
  text: string;
  key: string;
  type?: string;
  /** Seconds of the recording. */
  start: number;
  end: number;
  middle: number;
}

/** The words (no spacing) of a request, placed in the recording. */
function placed({ words, audioStart }: TimedWords): Placed[] {
  return words
    .filter((word) => word.type !== 'spacing')
    .map((word) => ({
      text: word.text,
      key: keyOf(word.text),
      type: word.type,
      start: audioStart + word.start,
      end: audioStart + word.end,
      middle: audioStart + (word.start + word.end) / 2,
    }));
}

/** The number of words (spacing not counted) in `words`. */
export function wordCount(words: TranscribedWord[]): number {
  return words.filter((word) => word.type !== 'spacing').length;
}

/** The text of words [from, to) of `words`, counting words only (not spacing), with the spacing between them. */
export function textOf(words: TranscribedWord[], from: number, to: number): string {
  let text = '';
  let spacing = '';
  let index = 0;
  for (const word of words) {
    if (word.type === 'spacing') {
      spacing += word.text;
      continue;
    }
    if (index >= from && index < to) {
      text += (index > from ? spacing : '') + word.text;
    }
    spacing = '';
    index++;
  }
  return text.trim();
}

/** Which words two neighbouring parts keep: the left part's words before `leftEnd`, the right part's from `rightStart` (indexes, spacing not counted). */
export interface Split {
  leftEnd: number;
  rightStart: number;
}

/** Two requests may time the same word this far apart and it still counts as the same word. */
const SAME_WORD_S = 0.3;
/** A request's audio may begin inside a word: a word that starts this close to it may have been cut off. */
const AUDIO_EDGE_S = 0.15;

/** A spoken word, not a sound tag such as "(laughs)" or punctuation on its own. */
function spoken(word: Placed): boolean {
  return word.type !== 'audio_event' && word.key !== '';
}

/** The key of the spoken word before `index` in `words`. */
function keyBefore(words: Placed[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (spoken(words[i])) {
      return words[i].key;
    }
  }
  return undefined;
}

/**
 * `right`'s copy of `left[k]`: the same word timed within SAME_WORD_S of it,
 * preferring one whose spoken word before it is the same too (a word said
 * twice in a row, "the the", has two copies close together), then the nearest.
 */
function copyOf(left: Placed[], k: number, right: Placed[]): number {
  const word = left[k];
  const before = keyBefore(left, k);
  let best = -1;
  let bestRank = Infinity;
  for (let j = 0; j < right.length; j++) {
    const distance = Math.abs(right[j].middle - word.middle);
    if (!spoken(right[j]) || right[j].key !== word.key || distance > SAME_WORD_S) {
      continue;
    }
    const rank = (keyBefore(right, j) === before ? 0 : SAME_WORD_S * 2) + distance;
    if (rank < bestRank) {
      best = j;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * How two neighbouring parts' words are split at the cut between them, each
 * request by its own word list, so that the few tens of milliseconds by which
 * two requests time the same word differently can never keep a word twice or
 * lose it.
 *
 * The split goes before the last spoken word before the cut that the part
 * after the cut has too: that word, and all after it, come from that part.
 * It heard both sides of the pause the cut lies in, so the punctuation there
 * and the case of the next word are its decisions, and they agree; the part
 * before the cut may have heard only silence past a long pause, and then
 * speech-to-text ends its sentence there. When the very last word is written
 * differently by the two ("OK", "okay"), the split goes back to the latest
 * word both have, among those the part after the cut heard whole.
 *
 * With no such word, the split goes at the cut, moved off any word of the part
 * before it that the cut runs through; the cut lies in a pause unless no pause
 * came, so timing differences do not matter there.
 */
export function splitWords(left: TimedWords, right: TimedWords, cut: number): Split {
  const a = placed(left);
  const b = placed(right);
  let last = -1;
  while (last + 1 < a.length && a[last + 1].middle < cut) {
    last++;
  }
  for (let k = last; k >= 0 && a[k].start >= right.audioStart + AUDIO_EDGE_S; k--) {
    if (!spoken(a[k])) {
      continue;
    }
    const copy = copyOf(a, k, b);
    if (copy >= 0) {
      return { leftEnd: k, rightStart: copy };
    }
  }
  const boundary = a[last];
  const lo = boundary ? boundary.end : -Infinity;
  const next = a[last + 1];
  const hi = next ? next.start : Infinity;
  const split = lo <= hi ? Math.min(Math.max(cut, lo), hi) : (boundary.middle + next.middle) / 2;
  let rightStart = 0;
  while (rightStart < b.length && b[rightStart].middle < split) {
    rightStart++;
  }
  return { leftEnd: last + 1, rightStart };
}

/** `text` with its first letter in the case of `like`'s first letter, when that one is lower case. */
function withOpeningCaseOf(text: string, like: string): string {
  const at = text.search(/\p{L}/u);
  const model = like.match(/\p{L}/u)?.[0];
  if (at < 0 || !model || model === model.toUpperCase() || text[at] !== text[at].toUpperCase()) {
    return text;
  }
  return text.slice(0, at) + text[at].toLowerCase() + text.slice(at + 1);
}

/**
 * `text`, what `right` keeps from its word `rightStart` on, with the case of
 * its first letter taken from `left`'s copy of that word, when that word is
 * the first `right` heard at all: speech-to-text capitalises the start of
 * every request, so a capital there says nothing.
 */
export function matchOpeningCase(text: string, right: TimedWords, left: TimedWords, rightStart: number): string {
  if (rightStart !== 0) {
    return text;
  }
  const first = placed(right)[0];
  if (!first || !spoken(first)) {
    return text;
  }
  const same = placed(left).find((word) => word.key === first.key && Math.abs(word.middle - first.middle) <= SAME_WORD_S);
  return same ? withOpeningCaseOf(text, same.text) : text;
}

interface Token {
  /** Letters, marks and digits in lower case, for comparing; empty for punctuation. */
  key: string;
  text: string;
  start: number;
  end: number;
}

/** The tokens of a text: words, and each letter of a script without spaces with its marks. */
function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    found.push({ key: keyOf(match[0]), text: match[0], start, end: start + match[0].length });
  }
  return found;
}

/** Most tokens of either text searched for the overlap: 5 s of fast speech in a script without spaces. */
const OVERLAP_WINDOW = 150;

/**
 * How many of a text's `count` tokens the shared audio can hold: twice its
 * share of the text's audio (speech comes faster in some seconds than in
 * others), and a few more.
 */
function windowOf(count: number, share: number | undefined): number {
  return share === undefined ? OVERLAP_WINDOW : Math.min(OVERLAP_WINDOW, Math.ceil(2 * count * Math.min(1, share)) + 3);
}

export interface StitchOptions {
  /** The share of the left text's audio that the right text heard too: the overlap's seconds over the part's. */
  leftShare?: number;
  /** The share of the right text's audio that the left text heard too. */
  rightShare?: number;
}

/**
 * Join two texts whose ends overlap: the end of `left` and the start of
 * `right` were transcribed from the same few seconds of audio, so right's
 * first tokens line up with left's last ones. Tries each way of lining them up
 * (within what that audio can hold): one counts for the words it pairs that
 * are the same, less half of those that are not, so that one long match or
 * several pieces of one (around words the two requests wrote differently)
 * beat a word that just happens to come up in both. Left's last token and
 * right's first are not held against a line-up: there the audio was cut off,
 * mid-word as often as not. Joins in the middle of the longest run of matching
 * tokens in the winning line-up, so that neither text's edge, where
 * speech-to-text guessed without context, is kept. Undefined unless some
 * line-up pairs more words that are the same than words that are not.
 */
export function stitchTexts(left: string, right: string, options: StitchOptions = {}): { left: string; right: string } | undefined {
  const a = tokens(left);
  const b = tokens(right);
  const most = Math.min(windowOf(a.length, options.leftShare), windowOf(b.length, options.rightShare), a.length, b.length);
  // When the shared audio should hold a few words, one word in common may be chance: ask for two
  const keyed = (list: Token[]) => list.filter((token) => token.key !== '').length;
  const expected = options.leftShare === undefined || options.rightShare === undefined
    ? 0 : Math.min(keyed(a) * Math.min(1, options.leftShare), keyed(b) * Math.min(1, options.rightShare));
  const fewest = expected >= 4 ? 2 : 1;
  // Paired tokens match when they are the same word, or the same punctuation at the same place
  const same = (i: number, j: number) => (a[i].key !== '' ? a[i].key === b[j].key : b[j].key === '' && a[i].text === b[j].text);
  let best: { shared: number; score: number; run: { at: number; length: number } } | undefined;
  for (let shared = 1; shared <= most; shared++) {
    // Right's token p is left's token a.length - shared + p
    const offset = a.length - shared;
    let matched = 0;
    let differ = 0;
    let run = { at: 0, length: 0 };
    let current = 0;
    for (let p = 0; p < shared; p++) {
      const matches = same(offset + p, p);
      if (matches && a[offset + p].key !== '') {
        matched++;
      } else if (!matches && (a[offset + p].key !== '' || b[p].key !== '') && p > 0 && p < shared - 1) {
        differ++;
      }
      current = matches ? current + 1 : 0;
      if (current > run.length) {
        run = { at: p - current + 1, length: current };
      }
    }
    const score = matched - differ / 2;
    if (matched >= fewest && matched > differ && (!best || score > best.score)) {
      best = { shared, score, run };
    }
  }
  if (!best) {
    return undefined;
  }
  // The first half of the run from left, the rest from right; right's first kept token is `join`, left
  // keeps up to the same place. Where it can, the join goes where both wrote the token before it alike,
  // punctuation and case included, so the punctuation there and the case after it are one text's decisions
  const offset = a.length - best.shared;
  const { at, length } = best.run;
  const middle = at + length / 2;
  let join = at + Math.floor(length / 2);
  for (let k = at + 1, nearest = Infinity; k < at + length; k++) {
    if (a[offset + k - 1].text === b[k - 1].text && Math.abs(k - middle) < nearest) {
      join = k;
      nearest = Math.abs(k - middle);
    }
  }
  const leftEnd = offset + join > 0 ? a[offset + join - 1].end : 0;
  let rest = right.slice(b[join].start).trim();
  if (join === 0) {
    // Right's first word is kept: take its case from left's copy, as right capitalised it for starting there
    rest = withOpeningCaseOf(rest, a[offset].text);
  }
  return { left: left.slice(0, leftEnd).trim(), right: rest };
}
