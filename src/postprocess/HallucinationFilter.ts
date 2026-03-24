/**
 * Whisper-family models hallucinate stock phrases on silence or unclear audio.
 * This filter catches the most common ones so they don't get injected as text.
 *
 * Two layers:
 * 1. Exact-match set for known phrases (fast, O(1) lookup)
 * 2. Regex patterns for variations and multilingual hallucinations
 */

// Exact matches (lowercased, trailing punctuation stripped before lookup)
const HALLUCINATIONS = new Set([
  // English YouTube/podcast boilerplate
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'thank you for listening',
  'subscribe to my channel',
  'please subscribe',
  'like and subscribe',
  'see you in the next video',
  'see you next time',
  'bye bye',
  'bye',
  'you',
  'the end',
  'subtitles by the amara.org community',
  'subtitles made by the amara.org community',
  'amara.org',
  'thank you',
  'thanks',
  // Russian/Ukrainian subtitle hallucinations
  'субтитры подготовил dimatorzok',
  'субтитры сделаны dimatorzok',
  'субтитри підготував dimatorzok',
  'субтитры',
  'субтитри',
  'продолжение следует',
  'редактор субтитров а.семкин',
  'редактор субтитрів',
  // German
  'untertitel von',
  'untertitel der amara.org-community',
  'vielen dank fürs zuschauen',
  'danke fürs zuschauen',
  // French
  'merci d\'avoir regardé',
  'sous-titres par',
  'sous-titres réalisés par',
  // Spanish
  'gracias por ver',
  'subtítulos por',
  'subtítulos realizados por',
  // Polish
  'napisy stworzone przez społeczność amara.org',
  'dziękuję za uwagę',
  'dziękuję za oglądanie',
]);

// Regex patterns for common hallucination structures
const HALLUCINATION_PATTERNS: RegExp[] = [
  // "Subtitles by <name>" in multiple languages
  /^sub(?:titles?|títulos?|titres?|титры|титри)\s+(?:by|par|por|von|подготовил|підготував|сделан)/i,
  // Amara.org community variations
  /amara\.org/i,
  // Single repeated word/char (Whisper looping on noise)
  /^(.)\1{4,}$/,
  // Just music/sound markers
  /^\[.*\]$/,
  /^♪+$/,
  // DimaTorzok (specific Whisper hallucination persona)
  /dimatorzok/i,
  // "Editor of subtitles" pattern in Cyrillic
  /^редактор\s+суб/i,
];

export function isHallucination(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,;:…]+$/g, '');
  if (!normalized) return true;

  if (HALLUCINATIONS.has(normalized)) return true;

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  return false;
}

/**
 * Check if transcription length is suspiciously short relative to recording duration.
 * Returns true if the transcription is likely low-quality or a hallucination.
 *
 * Heuristic: spoken language averages ~2-3 words/second. If we get fewer than
 * 0.3 words/second for recordings longer than 5 seconds, something is off.
 */
export function isSuspiciouslyShort(text: string, recordingDurationMs: number): boolean {
  const MIN_DURATION_MS = 5000; // Only check recordings longer than 5s
  if (recordingDurationMs < MIN_DURATION_MS) return false;

  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  const durationSec = recordingDurationMs / 1000;
  const wordsPerSecond = wordCount / durationSec;

  return wordsPerSecond < 0.3;
}
