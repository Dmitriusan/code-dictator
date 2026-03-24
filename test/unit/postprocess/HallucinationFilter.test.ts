import { describe, it, expect } from 'vitest';
import { isHallucination, isSuspiciouslyShort } from '../../../src/postprocess/HallucinationFilter';

describe('HallucinationFilter', () => {
  describe('isHallucination()', () => {
    it('detects English YouTube boilerplate', () => {
      expect(isHallucination('Thanks for watching!')).toBe(true);
      expect(isHallucination('thank you for watching.')).toBe(true);
      expect(isHallucination('Subscribe to my channel')).toBe(true);
      expect(isHallucination('Like and subscribe')).toBe(true);
      expect(isHallucination('See you in the next video')).toBe(true);
      expect(isHallucination('Bye')).toBe(true);
      expect(isHallucination('You')).toBe(true);
      expect(isHallucination('The end.')).toBe(true);
    });

    it('detects Russian/Ukrainian subtitle hallucinations', () => {
      expect(isHallucination('Субтитры подготовил DimaTorzok')).toBe(true);
      expect(isHallucination('Субтитри підготував DimaTorzok')).toBe(true);
      expect(isHallucination('Субтитры')).toBe(true);
      expect(isHallucination('Субтитри')).toBe(true);
      expect(isHallucination('Редактор субтитров А.Семкин')).toBe(true);
      expect(isHallucination('Продолжение следует...')).toBe(true);
    });

    it('detects German hallucinations', () => {
      expect(isHallucination('Untertitel der Amara.org-Community')).toBe(true);
      expect(isHallucination('Vielen Dank fürs Zuschauen!')).toBe(true);
    });

    it('detects French hallucinations', () => {
      expect(isHallucination("Merci d'avoir regardé.")).toBe(true);
      expect(isHallucination('Sous-titres par...')).toBe(true);
    });

    it('detects Amara.org variations', () => {
      expect(isHallucination('Subtitles by the Amara.org community')).toBe(true);
      expect(isHallucination('subtitles made by the amara.org community')).toBe(true);
    });

    it('detects DimaTorzok pattern via regex', () => {
      expect(isHallucination('Субтитры сделал DimaTorzok')).toBe(true);
      expect(isHallucination('something DimaTorzok something')).toBe(true);
    });

    it('detects repeated characters (noise loops)', () => {
      expect(isHallucination('ааааа')).toBe(true);
      expect(isHallucination('......')).toBe(true);
    });

    it('detects music/sound markers', () => {
      expect(isHallucination('[Music]')).toBe(true);
      expect(isHallucination('[Applause]')).toBe(true);
      expect(isHallucination('♪♪♪')).toBe(true);
    });

    it('allows legitimate transcriptions', () => {
      expect(isHallucination('Fix the bug in the authentication module')).toBe(false);
      expect(isHallucination('Додай новий метод для обробки помилок')).toBe(false);
      expect(isHallucination('Edit everything related to how corporation works')).toBe(false);
      expect(isHallucination('Hello world program in Python')).toBe(false);
    });

    it('treats empty/whitespace as hallucination', () => {
      expect(isHallucination('')).toBe(true);
      expect(isHallucination('   ')).toBe(true);
    });

    it('strips trailing punctuation before matching', () => {
      expect(isHallucination('bye!!!')).toBe(true);
      expect(isHallucination('thanks for watching...')).toBe(true);
      expect(isHallucination('the end;')).toBe(true);
    });
  });

  describe('isSuspiciouslyShort()', () => {
    it('flags very short transcription for long recording', () => {
      // 3 words for 13 seconds = 0.23 words/sec < 0.3
      expect(isSuspiciouslyShort('Субтитры подготовил DimaTorzok', 13000)).toBe(true);
    });

    it('does not flag short recordings (under 5s)', () => {
      expect(isSuspiciouslyShort('Hi', 3000)).toBe(false);
      expect(isSuspiciouslyShort('Hi', 4999)).toBe(false);
    });

    it('does not flag normal transcription length', () => {
      // 10 words for 5 seconds = 2 words/sec
      expect(isSuspiciouslyShort('one two three four five six seven eight nine ten', 5000)).toBe(false);
    });

    it('flags 1 word for 10 seconds', () => {
      expect(isSuspiciouslyShort('Hello', 10000)).toBe(true);
    });

    it('does not flag borderline case', () => {
      // 3 words for 5 seconds = 0.6 words/sec > 0.3
      expect(isSuspiciouslyShort('Hello there friend', 5000)).toBe(false);
    });
  });
});
