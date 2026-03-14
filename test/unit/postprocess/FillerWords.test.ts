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
