import { describe, it, expect } from 'vitest';
import { joinTranscripts, matchOpeningCase, splitWords, stitchTexts, textOf, wordCount, type TimedWords } from '../../../src/transcription/Stitch';
import type { TranscribedWord } from '../../../src/types';

/** ElevenLabs-style words, timed in seconds of the recording: each word with its time, spacing between them. */
function timed(...entries: Array<[string, number, number, string?]>): TranscribedWord[] {
  const words: TranscribedWord[] = [];
  entries.forEach(([text, start, end, type], i) => {
    if (i > 0) {
      words.push({ text: ' ', start: entries[i - 1][2], end: start, type: 'spacing' });
    }
    words.push({ text, start, end, type: type ?? 'word' });
  });
  return words;
}

/** A request's words as it gives them: timed from the start of its audio. */
function request(audioStart: number, words: TranscribedWord[], shift = 0): TimedWords {
  return { audioStart, words: words.map((w) => ({ ...w, start: w.start - audioStart + shift, end: w.end - audioStart + shift })) };
}

/** What two neighbouring parts give together, split at `cut`. */
function join(left: TimedWords, right: TimedWords, cut: number): string {
  const split = splitWords(left, right, cut);
  return joinTranscripts([
    textOf(left.words, 0, split.leftEnd),
    matchOpeningCase(textOf(right.words, split.rightStart, wordCount(right.words)), right, left, split.rightStart),
  ]);
}

describe('textOf', () => {
  it('gives words by their place, with their punctuation and the spacing between them, and sound tags like words', () => {
    const words = timed(['The', 7.0, 7.2], ['fetch', 7.3, 7.6], ['(laughs)', 7.7, 8.2, 'audio_event'], ['function.', 8.3, 9.0]);
    expect(wordCount(words)).toBe(4);
    expect(textOf(words, 0, 4)).toBe('The fetch (laughs) function.');
    expect(textOf(words, 1, 3)).toBe('fetch (laughs)');
    expect(textOf(words, 4, 4)).toBe('');
  });
});

describe('splitWords', () => {
  it('takes the last word before a cut in a long pause from the part after it, which heard how the sentence goes on', () => {
    // Speech up to 41.0 s, a 3.6 s pause, the cut at 41.2 s. The first part's audio ended at 43.7 s, in the
    // pause, so it ended the sentence; the second, sent from 38.7 s, heard both sides
    const left = request(0, timed(['mock', 39.0, 39.3], ['the', 39.35, 39.45], ['fetch', 39.5, 39.8], ['function', 39.85, 40.3], ['directly.', 40.35, 41.0]));
    const right = request(38.7, timed(['The', 39.35, 39.45], ['fetch', 39.5, 39.8], ['function', 39.85, 40.3], ['directly,', 40.35, 41.0], ['which', 44.6, 44.9], ['makes', 44.95, 45.3], ['them', 45.35, 45.5], ['brittle.', 45.55, 46.1]));
    expect(join(left, right, 41.2)).toBe('mock the fetch function directly, which makes them brittle.');
  });

  it('takes the word before the cut and the one after it from the same part, so its punctuation and the capital agree', () => {
    // Both heard the pause and what follows; they disagree on the punctuation there
    const left = request(0, timed(['so', 39.0, 39.2], ['ready,', 39.25, 39.7], ['next', 40.8, 41.1]));
    const right = request(37.9, timed(['So', 39.0, 39.2], ['ready.', 39.25, 39.7], ['Next', 40.8, 41.1], ['one.', 41.15, 41.5]));
    expect(join(left, right, 40.3)).toBe('so ready. Next one.');
  });

  it.each([-0.08, -0.05, 0.05, 0.08])('never keeps a short word twice, or loses it, when the part after the cut times it %f s off', (shift) => {
    // "then I" in connected speech, an 80 ms "I", then a 3 s pause holding the cut
    const words = timed(['so', 37.6, 37.9], ['and', 37.95, 38.2], ['then', 38.25, 38.6], ['I', 38.6, 38.68]);
    const left = request(0, words);
    const right = request(36.7, [...words, { text: ' ', start: 38.68, end: 41.7, type: 'spacing' }, { text: 'decided', start: 41.7, end: 42.2, type: 'word' }], shift);
    expect(join(left, right, 39.2)).toBe('so and then I decided');
  });

  it('never keeps a word twice, or loses it, when a forced cut runs through it and the two parts time it differently', () => {
    const words = timed(['the', 51.2, 51.4], ['parser', 51.7, 52.28], ['is', 52.35, 52.45], ['slow.', 52.5, 53]);
    for (const shift of [-0.06, 0.06]) {
      expect(join(request(0, words), request(49.5, words, shift), 52.0)).toBe('the parser is slow.');
    }
  });

  it('goes back to the latest word both parts have when the part after the cut wrote the last one differently', () => {
    const left = request(0, timed(['переписати', 38.6, 39.3], ['login', 39.35, 39.7], ['handler.', 39.75, 40.2]));
    const right = request(38.0, timed(['переписати', 38.6, 39.3], ['логін-хендлер,', 39.35, 40.2], ['щоб', 41.5, 41.7], ['він', 41.75, 41.9], ['працював.', 41.95, 42.6]));
    expect(join(left, right, 40.8)).toBe('переписати логін-хендлер, щоб він працював.');
    const ok = request(0, timed(['that', 35.0, 35.2], ['is', 35.25, 35.4], ['OK.', 35.45, 35.8]));
    const okay = request(33.8, timed(['that', 35.0, 35.2], ['is', 35.25, 35.4], ['okay,', 35.45, 35.8], ['so', 41.8, 42.0], ['we', 42.05, 42.2], ['merge.', 42.25, 42.7]));
    expect(join(ok, okay, 38.4)).toBe('that is okay, so we merge.');
  });

  it('splits at the cut, moved off the words, when the part after it has none of the words before it', () => {
    const left = request(0, timed(['so', 40.0, 40.2], ['ready.', 40.25, 40.7], ['Next', 43.5, 43.8]));
    const right = request(40.15, timed(['Eady.', 40.2, 40.7], ['Next', 43.5, 43.8], ['one.', 43.85, 44.2]));
    expect(join(left, right, 41.0)).toBe('so ready. Next one.');
  });

  it('splits before a spoken word, not a sound tag, so the punctuation before a tagged pause comes from the part that heard both sides', () => {
    const left = request(0, timed(['makes', 34.8, 35.1], ['them', 35.15, 35.3], ['brittle.', 35.35, 35.9], ['(keyboard clicking)', 36.0, 37.8, 'audio_event']));
    const right = request(33.8, timed(['makes', 34.8, 35.1], ['them', 35.15, 35.3], ['brittle,', 35.35, 35.9], ['(keyboard clicking)', 36.0, 37.9, 'audio_event'], ['which', 41.8, 42.1], ['is', 42.15, 42.3], ['bad.', 42.35, 42.8]));
    expect(join(left, right, 38.4)).toBe('makes them brittle, (keyboard clicking) which is bad.');
  });

  it('finds the right copy of a word said twice in a row, however the two parts time it', () => {
    const words = timed(['fix', 37.5, 37.8], ['the', 37.85, 38.0], ['the', 38.02, 38.17]);
    for (const shift of [-0.12, 0.12]) {
      const right = request(36.6, [...words, { text: ' ', start: 38.17, end: 41.0, type: 'spacing' }, { text: 'parser', start: 41.0, end: 41.5, type: 'word' }], shift);
      expect(join(request(0, words), right, 38.8)).toBe('fix the the parser');
    }
  });

  it('takes the case of the part before the cut when the word kept from the part after it is the first that part heard', () => {
    const left = request(0, timed(['the', 39.5, 39.7], ['parser.', 39.8, 40.3]));
    const right = request(39.6, timed(['Parser,', 39.8, 40.3], ['works.', 43.0, 43.4]));
    expect(join(left, right, 40.6)).toBe('the parser, works.');
  });
});

describe('stitchTexts', () => {
  it('joins in the middle of the words both texts have, so neither edge is kept', () => {
    // The left part ended mid-word past the cut; the right part began mid-word before it
    const left = 'The existing tests mock the fetch function directly, which makes them brit';
    const right = 'fetch function directly, which makes them brittle, so I would prefer a fake client.';
    const joined = stitchTexts(left, right)!;
    expect(joinTranscripts([joined.left, joined.right])).toBe('The existing tests mock the fetch function directly, which makes them brittle, so I would prefer a fake client.');
  });

  it('takes the punctuation and capitals of the text that heard both sides of the cut', () => {
    // Left heard past the cut ("directly, which"); right began at "Function" with a capital
    const joined = stitchTexts('mock the fetch function directly, which makes', 'Function directly, which makes them brittle.')!;
    expect(`${joined.left} ${joined.right}`).toBe('mock the fetch function directly, which makes them brittle.');
  });

  it('ignores case and punctuation when matching', () => {
    const joined = stitchTexts('Зараз тести мокають функцію fetch напряму, через що.', 'Fetch напряму, через що вони крихкі.')!;
    expect(`${joined.left} ${joined.right}`).toBe('Зараз тести мокають функцію fetch напряму, через що вони крихкі.');
  });

  it('joins at a single shared word at the edges, also next to a word cut off there', () => {
    expect(stitchTexts('we should refactor', 'refactor the parser')).toEqual({ left: 'we should', right: 'refactor the parser' });
    expect(stitchTexts('and then we can merge it. So.', 'So, the next step is the docs.')).toEqual({ left: 'and then we can merge it.', right: 'So, the next step is the docs.' });
    expect(stitchTexts('and that is how the parser works. So.', 'Rks. So, the next step is the lexer.')).toEqual({ left: 'and that is how the parser works.', right: 'So, the next step is the lexer.' });
  });

  it("keeps left's case for right's first word, which right capitalised only for starting there", () => {
    const joined = stitchTexts('we should refactor', 'Refactor the parser')!;
    expect(`${joined.left} ${joined.right}`).toBe('we should refactor the parser');
  });

  it('does not join at a word that comes up in both away from the overlap', () => {
    expect(stitchTexts('the parser we wrote is slow and we know', 'parser time to move on', { leftShare: 0.2, rightShare: 0.4 })).toBeUndefined();
    expect(stitchTexts('we will fix it later today', 'it never works here')).toBeUndefined();
    // "the tests" comes up in both texts, but the overlap itself is "Okay.": what was said between stays
    const left = 'We moved the config into a separate file, so the tests fail on CI because the key is missing. Okay.';
    const right = 'Okay. Then I add the secret, and the tests pass on CI.';
    const joined = stitchTexts(left, right, { leftShare: 5 / 30, rightShare: 5 / 20 })!;
    expect(`${joined.left} ${joined.right}`).toBe('We moved the config into a separate file, so the tests fail on CI because the key is missing. Okay. Then I add the secret, and the tests pass on CI.');
  });

  it('lines the overlap up as a whole, so words the two texts wrote differently do not let a stray match decide', () => {
    const left = 'So we look for the same thing at the end of one text and at the start of the next,';
    const right = 'the same X at the end of one X and at the X of the next, and join them there.';
    const joined = stitchTexts(left, right)!;
    expect(`${joined.left} ${joined.right}`).toMatch(/^So we look for the same thing at the end of one (text|X) and at the (start|X) of the next, and join them there\.$/);

    const zh = stitchTexts('他说很简单，我们在某个时间点切开就行。对于其他服务我们只有文本，所以我们在', '说很简单，我们在某个时间点切开就行。对于其他服务我们只有文本，所以我们在一段文本里找相同的字。')!;
    expect(joinTranscripts([zh.left, zh.right])).toBe('他说很简单，我们在某个时间点切开就行。对于其他服务我们只有文本，所以我们在一段文本里找相同的字。');
  });

  it('does not join on one word in common where the shared audio should hold several: the whole recording is better', () => {
    // 45 s of words before the overlap, 20 s after it; the number is written out in one text only
    const before = Array.from({ length: 100 }, (_v, i) => `word${i}`).join(' ');
    const after = Array.from({ length: 40 }, (_v, i) => `more${i}`).join(' ');
    const shares = { leftShare: 5 / 45, rightShare: 5 / 20 };
    expect(stitchTexts(`${before} so the retry waits five hundred milliseconds and then the`, `The retry waits 500 ms and then the request goes out again, ${after}`, shares)).toBeUndefined();
    const alike = stitchTexts(`${before} so the retry waits five hundred milliseconds and then the`, `The retry waits five hundred milliseconds and then the request goes out again, ${after}`, shares)!;
    expect(`${alike.left} ${alike.right}`).toBe(`${before} so the retry waits five hundred milliseconds and then the request goes out again, ${after}`);
  });

  it('joins where both texts wrote the word before the join alike, so the punctuation and the next capital agree', () => {
    const left = 'and we load the config once at startup. Then the handler reads it';
    const joined = stitchTexts(left, 'Config once at startup, then the handler reads it from memory.')!;
    expect(`${joined.left} ${joined.right}`).toBe('and we load the config once at startup, then the handler reads it from memory.');
    const mirror = stitchTexts('and we load the config once at startup, then the handler reads it', 'Config once at startup. Then the handler reads it from memory.')!;
    expect(`${mirror.left} ${mirror.right}`).toBe('and we load the config once at startup. Then the handler reads it from memory.');
  });

  it('gives undefined when nothing was said twice', () => {
    expect(stitchTexts('The first part.', 'And the second part')).toBeUndefined();
    expect(stitchTexts('', 'anything')).toBeUndefined();
  });

  it('matches letters in scripts written without spaces, marks and all, also next to a word in another script', () => {
    const joined = stitchTexts('今日は天気がいいので散歩', '気がいいので散歩に行こう。')!;
    expect(joinTranscripts([joined.left, joined.right])).toBe('今日は天気がいいので散歩に行こう。');

    const mixed = stitchTexts('我们需要把这个 parser 改成异步的，然后再跑一遍测试', '然后再跑一遍测试，看看结果怎么样')!;
    expect(joinTranscripts([mixed.left, mixed.right])).toBe('我们需要把这个 parser 改成异步的，然后再跑一遍测试，看看结果怎么样');

    const thai = stitchTexts('ฟังก์ชันนี้ต้องคืนค่าข้อผิดพลาดแทนที่จะคืนค่าว่าง แล้วการทดสอบก็จะผ่าน', 'ค่าข้อผิดพลาดแทนที่จะคืนค่าว่าง แล้วการทดสอบก็จะผ่านทั้งหมด')!;
    expect(joinTranscripts([thai.left, thai.right])).toBe('ฟังก์ชันนี้ต้องคืนค่าข้อผิดพลาดแทนที่จะคืนค่าว่าง แล้วการทดสอบก็จะผ่านทั้งหมด');
  });
});

describe('joinTranscripts', () => {
  it('puts one space between parts and skips empty ones', () => {
    expect(joinTranscripts([' Hello there. ', '', 'General Kenobi '])).toBe('Hello there. General Kenobi');
  });

  it('puts no space between two parts in a script written without spaces, and one in Korean, which has spaces', () => {
    expect(joinTranscripts(['今日は天気がいい。', '散歩に行こう。'])).toBe('今日は天気がいい。散歩に行こう。');
    expect(joinTranscripts(['그래서 이 함수를', '수정해야 합니다.'])).toBe('그래서 이 함수를 수정해야 합니다.');
    expect(joinTranscripts(['Push the PR', '然后合并'])).toBe('Push the PR 然后合并');
  });
});
