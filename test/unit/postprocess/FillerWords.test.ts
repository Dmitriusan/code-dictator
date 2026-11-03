import { describe, it, expect } from 'vitest';
import { removeFillerWords } from '../../../src/postprocess/FillerWords';

describe('removeFillerWords()', () => {
  describe('English (en)', () => {
    it('removes "uh" between commas', () => {
      expect(removeFillerWords('I have my, uh, thing', 'en')).toBe('I have my thing');
    });

    it('removes "um" between commas', () => {
      expect(removeFillerWords('so, um, yeah', 'en')).toBe('So yeah');
    });

    it('removes standalone "uh" at start', () => {
      expect(removeFillerWords('Uh hello', 'en')).toBe('Hello');
    });

    it('removes standalone "um" with trailing comma', () => {
      expect(removeFillerWords('Well um, I think so', 'en')).toBe('Well I think so');
    });

    it('removes multiple fillers', () => {
      expect(removeFillerWords('I, uh, want to, um, do this', 'en')).toBe('I want to do this');
    });

    it('removes "er" as standalone filler', () => {
      expect(removeFillerWords('I think, er, maybe', 'en')).toBe('I think maybe');
    });

    it('does not remove "er" inside words', () => {
      expect(removeFillerWords('The user and the newer version', 'en')).toBe(
        'The user and the newer version',
      );
    });

    it('removes "hmm" filler', () => {
      expect(removeFillerWords('Hmm, let me think', 'en')).toBe('Let me think');
    });

    it('removes "erm" filler', () => {
      expect(removeFillerWords('Erm I was thinking', 'en')).toBe('I was thinking');
    });

    it('re-capitalizes after start filler removal', () => {
      expect(removeFillerWords('Uh, hello', 'en')).toBe('Hello');
    });

    it('handles empty string', () => {
      expect(removeFillerWords('', 'en')).toBe('');
    });

    it('returns unchanged text with no fillers', () => {
      expect(removeFillerWords('Hello world.', 'en')).toBe('Hello world.');
    });
  });

  describe('German (de)', () => {
    it('removes "äh" filler', () => {
      expect(removeFillerWords('Ich möchte, äh, das machen', 'de')).toBe(
        'Ich möchte das machen',
      );
    });

    it('removes "ähm" filler', () => {
      expect(removeFillerWords('Das ist, ähm, interessant', 'de')).toBe('Das ist interessant');
    });
  });

  describe('French (fr)', () => {
    it('removes "euh" filler', () => {
      expect(removeFillerWords("Je veux, euh, faire ça", 'fr')).toBe('Je veux faire ça');
    });

    it('removes "bah" filler', () => {
      expect(removeFillerWords('Bah, je sais pas', 'fr')).toBe('Je sais pas');
    });
  });

  describe('Russian (ru)', () => {
    it('removes "ну" filler', () => {
      expect(removeFillerWords('Я, ну, хочу это сделать', 'ru')).toBe('Я хочу это сделать');
    });

    it('removes "значит" filler', () => {
      expect(removeFillerWords('Значит, надо идти', 'ru')).toBe('Надо идти');
    });
  });

  describe('Ukrainian (uk)', () => {
    it('removes "е" at the start, with or without a comma', () => {
      expect(removeFillerWords('Е, перевірю зараз', 'uk')).toBe('Перевірю зараз');
      expect(removeFillerWords('Е перевірю зараз', 'uk')).toBe('Перевірю зараз');
    });

    it('removes "е" between commas', () => {
      expect(removeFillerWords('Подивись, е, цю сесію', 'uk')).toBe('Подивись цю сесію');
    });

    it('removes "значить" when it opens the dictation before a comma', () => {
      expect(removeFillerWords('Значить, нагадаєш мені', 'uk')).toBe('Нагадаєш мені');
    });
  });

  describe('real words', () => {
    it.each([
      ['uk', 'Екран не вмикається'],
      ['uk', 'Отримав помилку'],
      ['uk', 'Нуль байтів'],
      ['ru', 'Это работает'],
      ['ru', 'Нужно сделать'],
      ['de', 'Ähnlich wie vorher'],
      ['ko', '어디 가'],
      ['th', 'อ่านหนังสือ'],
    ])('keeps a first word that begins with a filler (%s: %s)', (lang, text) => {
      expect(removeFillerWords(text, lang)).toBe(text);
    });

    it('keeps a drawn-out "Е-е-е" whole instead of cutting its first letter', () => {
      expect(removeFillerWords('Е-е-е, додай це', 'uk')).toBe('Е-е-е, додай це');
    });

    it.each([
      ['uk', 'То це значить, що треба'],
      ['uk', 'Змінна типу string'],
      ['uk', 'От чому не працює'],
      ['ru', 'Вот почему это не работает'],
      ['ru', 'Переменная типа int'],
      ['ru', 'Сделай текст короче'],
      ['es', 'Quiero este archivo'],
      ['pt', 'O tipo de dados'],
      ['pl', 'Do tego pliku'],
      ['tr', 'Bir şey yap'],
      ['ja', 'その関数は'],
      ['ko', '그 함수를 고쳐'],
    ])('keeps a filler that is also an ordinary word inside a sentence (%s: %s)', (lang, text) => {
      expect(removeFillerWords(text, lang)).toBe(text);
    });

    it.each([
      ['uk', 'е'], ['uk', 'ну'], ['ru', 'э'], ['bg', 'ъ'], ['de', 'ähm'], ['el', 'εε'], ['ro', 'ăă'],
      ['tr', 'ıı'], ['da', 'øh'], ['sv', 'öh'], ['fi', 'öö'], ['he', 'אמ'], ['th', 'เอ่อ'], ['ko', '음'],
    ])('still removes the %s hesitation sound "%s" inside a sentence', (lang, sound) => {
      expect(removeFillerWords(`Alpha ${sound} beta`, lang)).toBe('Alpha beta');
    });
  });

  describe('Polish (pl)', () => {
    it('removes "yyy" filler', () => {
      expect(removeFillerWords('Chcę, yyy, to zrobić', 'pl')).toBe('Chcę to zrobić');
    });
  });

  describe('Finnish (fi)', () => {
    it('removes "öö" filler', () => {
      expect(removeFillerWords('Öö, haluaisin tehdä tämän', 'fi')).toBe('Haluaisin tehdä tämän');
    });

    it('removes "niinku" filler', () => {
      expect(removeFillerWords('Se on, niinku, hyvä idea', 'fi')).toBe('Se on hyvä idea');
    });
  });

  describe('Swedish (sv)', () => {
    it('removes "liksom" filler', () => {
      expect(removeFillerWords('Det är, liksom, intressant', 'sv')).toBe('Det är intressant');
    });
  });

  describe('Chinese (zh) — fullwidth comma ，', () => {
    it('removes "嗯" with fullwidth commas on both sides', () => {
      // Pattern 1 with fullwidth commas: ，嗯， → space
      const result = removeFillerWords('我，嗯，喜欢这个', 'zh');
      expect(result).not.toContain('嗯');
      expect(result).not.toContain('，，');
    });

    it('removes "嗯" at start of sentence followed by fullwidth comma', () => {
      expect(removeFillerWords('嗯，这很好', 'zh')).toBe('这很好');
    });

    it('removes "嗯" at start with no following comma', () => {
      expect(removeFillerWords('嗯这很好', 'zh')).toBe('这很好');
    });
  });

  describe('Japanese (ja) — ideographic comma 、', () => {
    it('removes "えーと" at start followed by 、', () => {
      expect(removeFillerWords('えーと、次に', 'ja')).toBe('次に');
    });

    it('removes "あの" with 、 on both sides', () => {
      const result = removeFillerWords('この、あの、内容', 'ja');
      expect(result).not.toContain('あの');
      expect(result).not.toContain('、、');
    });
  });

  describe('Korean (ko)', () => {
    it('removes "어" at start with ASCII comma', () => {
      expect(removeFillerWords('어, 다음은', 'ko')).toBe('다음은');
    });

    it('removes "음" with ASCII commas on both sides', () => {
      expect(removeFillerWords('내용, 음, 다른', 'ko')).toBe('내용 다른');
    });
  });

  describe('language code normalization', () => {
    it('handles BCP-47 tag (en-US → en)', () => {
      expect(removeFillerWords('Uh hello', 'en-US')).toBe('Hello');
    });

    it('handles uppercase language code', () => {
      expect(removeFillerWords('Uh hello', 'EN')).toBe('Hello');
    });

    it('falls back to English for unknown language', () => {
      expect(removeFillerWords('Uh hello', 'xx')).toBe('Hello');
    });

    it('falls back to English for empty language code', () => {
      expect(removeFillerWords('Um, hello', '')).toBe('Hello');
    });
  });

  describe('full dictation example', () => {
    it('cleans up real-world filler-heavy English dictation', () => {
      const input =
        'I have my, uh, account for, uh, my business user. ' +
        'So suggest how do I use, uh, two accounts logged in, uh, this system.';
      const result = removeFillerWords(input, 'en');
      expect(result).not.toContain(' uh');
      expect(result).not.toContain('uh ');
      expect(result).toContain('account for');
      expect(result).toContain('two accounts');
    });
  });
});
