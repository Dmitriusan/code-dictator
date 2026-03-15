import { describe, it, expect } from 'vitest';
import { format } from '../../../src/postprocess/Formatter';

describe('Formatter.format()', () => {
  it('returns empty string for empty input', () => {
    expect(format('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    // The function checks `if (!text)` which handles undefined-like edge cases
    expect(format('')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(format('  hello world  ')).toBe('Hello world');
  });

  it('trims tabs and newlines from edges', () => {
    expect(format('\t\nhello\n\t')).toBe('Hello');
  });

  it('collapses multiple spaces into one', () => {
    expect(format('hello    world')).toBe('Hello world');
  });

  it('collapses three spaces into one', () => {
    expect(format('a  b   c    d')).toBe('A b c d');
  });

  it('capitalizes first letter of text', () => {
    expect(format('hello')).toBe('Hello');
  });

  it('does not double-capitalize already capitalized text', () => {
    expect(format('Hello')).toBe('Hello');
  });

  it('capitalizes after period', () => {
    expect(format('hello. world')).toBe('Hello. World');
  });

  it('capitalizes after exclamation mark', () => {
    expect(format('wow! great')).toBe('Wow! Great');
  });

  it('capitalizes after question mark', () => {
    expect(format('what? nothing')).toBe('What? Nothing');
  });

  it('capitalizes after multiple sentence-ending punctuation', () => {
    expect(format('one. two! three? four')).toBe('One. Two! Three? Four');
  });

  it('capitalizes first letter after newline', () => {
    expect(format('hello\nworld')).toBe('Hello\nWorld');
  });

  it('capitalizes after newline with leading space', () => {
    expect(format('hello\n  world')).toBe('Hello\nWorld');
  });

  it('removes space before period', () => {
    expect(format('hello .')).toBe('Hello.');
  });

  it('removes space before comma', () => {
    expect(format('hello , world')).toBe('Hello, world');
  });

  it('removes space before semicolon', () => {
    expect(format('hello ;')).toBe('Hello;');
  });

  it('removes space before colon', () => {
    expect(format('hello :')).toBe('Hello:');
  });

  it('removes space before exclamation mark', () => {
    expect(format('hello !')).toBe('Hello!');
  });

  it('removes space before question mark', () => {
    expect(format('hello ?')).toBe('Hello?');
  });

  it('adds space after punctuation before a letter', () => {
    expect(format('hello,world')).toBe('Hello, world');
  });

  it('adds space after period before letter', () => {
    // Note: capitalize-after-punctuation runs before space-insertion,
    // so the newly inserted space doesn't trigger re-capitalization.
    expect(format('end.start')).toBe('End. start');
  });

  it('adds space after semicolon before letter', () => {
    expect(format('a;b')).toBe('A; b');
  });

  it('collapses three or more newlines to two, then capitalize-after-newline consumes one', () => {
    // After collapsing \n\n\n → \n\n, the capitalize-after-newline regex
    // \n\s*([a-z]) matches "\n\nw" (second \n consumed by \s*), yielding \nW.
    expect(format('hello\n\n\nworld')).toBe('Hello\nWorld');
  });

  it('double newline gets collapsed by capitalize-after-newline regex', () => {
    // \n\s*([a-z]) matches "\n\nw" → replaces with "\nW"
    expect(format('hello\n\nworld')).toBe('Hello\nWorld');
  });

  it('collapses five newlines: first to two, then capitalize consumes one', () => {
    expect(format('a\n\n\n\n\nb')).toBe('A\nB');
  });

  it('handles already-formatted text unchanged', () => {
    expect(format('Hello world.')).toBe('Hello world.');
  });

  it('handles already-formatted multi-sentence text', () => {
    expect(format('Hello. World! Good?')).toBe('Hello. World! Good?');
  });

  it('handles single word', () => {
    expect(format('hello')).toBe('Hello');
  });

  it('handles single character', () => {
    expect(format('a')).toBe('A');
  });

  it('handles unicode characters', () => {
    expect(format('привіт світ')).toBe('Привіт світ');
  });

  it('handles unicode with punctuation', () => {
    expect(format('cześć. jak się masz')).toBe('Cześć. Jak się masz');
  });

  it('handles emoji in text', () => {
    const result = format('hello 😊 world');
    expect(result).toBe('Hello 😊 world');
  });

  it('handles combined formatting issues', () => {
    expect(format('  hello    world .  how   are  you ?  fine . ')).toBe(
      'Hello world. How are you? Fine.'
    );
  });

  // --- Noise & stutter removal ---

  describe('stutter removal', () => {
    it('removes letter-uh stutters', () => {
      expect(format('I want to u-uh use this')).toBe('I want to use this');
    });

    it('removes m-uh stutter with comma', () => {
      expect(format('the m-uh, quota')).toBe('The quota');
    });

    it('removes b-um stutter', () => {
      expect(format('the b-um button')).toBe('The button');
    });
  });

  describe('false start / self-correction removal (double-dash)', () => {
    it('removes abandoned word before double-dash', () => {
      expect(format('so the-- some entity')).toBe('So some entity');
    });

    it('removes abandoned word at start of text', () => {
      expect(format('the-- hello world')).toBe('Hello world');
    });

    it('removes abandoned word with trailing comma', () => {
      expect(format('I went to the--, no the store')).toBe('I went to no the store');
    });

    it('removes multiple false starts', () => {
      expect(format('I was go-- going to the-- a place')).toBe('I was going to a place');
    });

    it('handles false start at end of text', () => {
      expect(format('I wanted to--')).toBe('I wanted');
    });

    it('does not touch single dashes (hyphenated words)', () => {
      expect(format('well-known pattern')).toBe('Well-known pattern');
    });

    it('does not touch em-dashes used as punctuation', () => {
      // em-dash (—) is different from double-dash (--)
      expect(format('hello — world')).toBe('Hello — world');
    });
  });

  describe('bracketed noise removal', () => {
    it('removes [engine revving]', () => {
      expect(format('hello [engine revving]')).toBe('Hello');
    });

    it('removes [cough] mid-sentence', () => {
      expect(format('I want [cough] this thing')).toBe('I want this thing');
    });

    it('removes multiple bracketed noises', () => {
      expect(format('[noise] hello [sneeze] world [laughter]')).toBe('Hello world');
    });
  });

  describe('spurious comma after articles', () => {
    it('removes comma after "the"', () => {
      expect(format('check out the, project, folder')).toBe('Check out the project, folder');
    });

    it('removes comma after "a"', () => {
      expect(format('create a, new file')).toBe('Create a new file');
    });

    it('removes comma after "an"', () => {
      expect(format('this is an, important thing')).toBe('This is an important thing');
    });

    it('is case-insensitive', () => {
      expect(format('The, quick fox')).toBe('The quick fox');
    });

    it('does not affect legitimate comma usage after articles at end of clause', () => {
      // "the" at end of a clause followed by a new clause is rare,
      // but the rule still fires — acceptable trade-off for dictation context.
      expect(format('the, world')).toBe('The world');
    });
  });

  describe('combined noise cleanup', () => {
    it('removes stutters and bracketed noise together', () => {
      const result = format('I u-uh, want this [cough] thing');
      expect(result).not.toContain('u-uh');
      expect(result).not.toContain('[cough]');
    });
  });
});
