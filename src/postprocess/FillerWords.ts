/**
 * Language-aware filler word and hesitation marker removal.
 * Always-on, no API required. Uses the detected language from the STT
 * provider (ElevenLabs returns it in every response; OpenAI Whisper with
 * verbose_json also returns it). Falls back to the user-configured language,
 * then to English.
 *
 * Covers all languages supported by ElevenLabs Scribe v2 (90+) and
 * OpenAI Whisper (57). Conservative selection — only words that are
 * unambiguously hesitation markers, not common vocabulary. LLM cleanup
 * (codeDictator.aiTextCleanup) handles subtler cases.
 */

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiOnly(s: string): boolean {
  return /^[\x00-\x7F]+$/.test(s);
}

/**
 * Filler words / hesitation markers by ISO 639-1 language code.
 * Each entry is conservative — prefers false negatives over false positives.
 */
const FILLER_WORDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  af: ['uh', 'um', 'ag'],                                                // Afrikaans
  am: ['uh', 'um'],                                                       // Amharic
  ar: ['يعني', 'إيه', 'ايه', 'آه'],                                      // Arabic
  az: ['uh', 'um', 'yəni'],                                              // Azerbaijani
  be: ['ну', 'значыць'],                                                  // Belarusian
  bg: ['ъ', 'значи', 'нали'],                                            // Bulgarian
  bn: ['uh', 'um'],                                                       // Bengali
  bs: ['uh', 'znači', 'pa'],                                             // Bosnian
  ca: ['eh', 'doncs'],                                                    // Catalan
  cs: ['yyy', 'vlastně', 'prostě'],                                      // Czech
  cy: ['uh', 'um', 'felly'],                                             // Welsh
  da: ['øh', 'øhm', 'ligesom', 'altså'],                                // Danish
  de: ['äh', 'ähm'],                                                     // German
  el: ['εε', 'δηλαδή'],                                                  // Greek
  en: ['uh', 'um', 'ah', 'er', 'eh', 'erm', 'hmm', 'hm', 'mm'],        // English
  es: ['eh', 'este'],                                                     // Spanish
  et: ['uh', 'um', 'nii'],                                               // Estonian
  eu: ['uh', 'um'],                                                       // Basque
  fa: ['یعنی', 'خب'],                                                    // Persian/Farsi
  fi: ['öö', 'tota', 'niinku', 'siis'],                                 // Finnish
  fil: ['uh', 'um', 'eh', 'kasi', 'parang'],                            // Filipino
  fr: ['euh', 'heu', 'bah', 'hein'],                                     // French
  ga: ['uh', 'um', 'bhuel'],                                             // Irish
  gl: ['eh', 'pois'],                                                    // Galician
  gu: ['uh', 'um'],                                                       // Gujarati
  he: ['אמ', 'כאילו', 'יעני'],                                           // Hebrew
  hi: ['uh', 'um', 'matlab', 'woh', 'yaar'],                            // Hindi
  hr: ['znači', 'dakle'],                                                 // Croatian
  hu: ['öö', 'hát', 'szóval', 'ugye', 'izé'],                          // Hungarian
  hy: ['uh', 'um'],                                                       // Armenian
  id: ['uh', 'em', 'eh', 'gitu', 'tuh'],                                // Indonesian
  is: ['uh', 'um'],                                                       // Icelandic
  it: ['ehm', 'cioè', 'beh'],                                           // Italian
  ja: ['えーと', 'ええと', 'えっと', 'あの', 'その', 'まあ', 'なんか'],    // Japanese
  ka: ['uh', 'um', 'ანუ'],                                               // Georgian
  kk: ['uh', 'um'],                                                       // Kazakh
  km: ['uh', 'um'],                                                       // Khmer
  kn: ['uh', 'um'],                                                       // Kannada
  ko: ['어', '음', '뭐', '그'],                                            // Korean
  lo: ['uh', 'um'],                                                       // Lao
  lt: ['uh', 'um', 'tai'],                                               // Lithuanian
  lv: ['uh', 'um'],                                                       // Latvian
  mi: ['uh', 'um'],                                                       // Maori
  mk: ['значи', 'ами'],                                                   // Macedonian
  ml: ['uh', 'um'],                                                       // Malayalam
  mn: ['uh', 'um'],                                                       // Mongolian
  mr: ['uh', 'um'],                                                       // Marathi
  ms: ['uh', 'em', 'eh', 'gitu'],                                        // Malay
  mt: ['uh', 'um'],                                                       // Maltese
  my: ['uh', 'um'],                                                       // Burmese/Myanmar
  ne: ['uh', 'um'],                                                       // Nepali
  nl: ['uh', 'eh', 'eigenlijk', 'gewoon'],                               // Dutch
  no: ['eh', 'eeh', 'liksom', 'altså'],                                  // Norwegian
  pa: ['uh', 'um'],                                                       // Punjabi
  pl: ['yyy', 'tego', 'znaczy', 'jakby'],                               // Polish
  ps: ['uh', 'um'],                                                       // Pashto
  pt: ['tipo', 'né', 'ué'],                                              // Portuguese
  ro: ['ăă', 'adică', 'păi', 'deci'],                                   // Romanian
  ru: ['э', 'ну', 'значит', 'вот', 'типа', 'короче'],                   // Russian
  si: ['uh', 'um'],                                                       // Sinhala
  sk: ['yyy', 'vlastne', 'proste'],                                      // Slovak
  sl: ['em', 'pač', 'torej'],                                            // Slovenian
  so: ['uh', 'um'],                                                       // Somali
  sq: ['uh', 'um'],                                                       // Albanian
  sr: ['значи', 'dakle'],                                                 // Serbian
  sv: ['öh', 'liksom', 'alltså', 'asså'],                               // Swedish
  sw: ['uh', 'um', 'yaani'],                                             // Swahili
  ta: ['uh', 'um'],                                                       // Tamil
  te: ['uh', 'um'],                                                       // Telugu
  th: ['อ่า', 'เอ่อ'],                                                    // Thai
  tl: ['uh', 'um', 'eh', 'kasi', 'parang'],                             // Tagalog
  tr: ['ıı', 'şey', 'yani', 'işte'],                                    // Turkish
  uk: ['е', 'ну', 'значить', 'от', 'типу'],                             // Ukrainian
  ur: ['uh', 'um', 'matlab', 'yaar'],                                    // Urdu
  uz: ['uh', 'um'],                                                       // Uzbek
  vi: ['ừ', 'uh'],                                                        // Vietnamese
  yo: ['uh', 'um'],                                                       // Yoruba
  zh: ['嗯'],                                                              // Chinese
  zu: ['uh', 'um'],                                                       // Zulu
};

function applyFillerRemoval(text: string, filler: string): string {
  const f = esc(filler);
  let result = text;

  // Pattern 1: ", filler," → " " — both ASCII and CJK fullwidth commas
  result = result.replace(new RegExp(`[,，、]\\s*${f}\\s*[,，、]`, 'gi'), ' ');

  if (isAsciiOnly(filler)) {
    // ASCII filler: \b word boundaries prevent matching inside words (e.g. "er" in "user")
    result = result.replace(new RegExp(`\\b${f}\\b[,.]?\\s*`, 'gi'), ' ');
  } else {
    // Non-ASCII (Cyrillic, CJK, Arabic, etc.): two patterns to cover all positions.
    const punct = `[\\s，。！？、…；：（），.!?:;]`;

    // Start-of-text: consume filler + any trailing comma/punct/space.
    // No lookahead needed — nothing precedes the filler.
    result = result.replace(new RegExp(`^${f}[,.，、。]?\\s*`, 'gi'), '');

    // Mid-sentence: filler is preceded AND followed by punct or end-of-string.
    result = result.replace(
      new RegExp(`(?<=${punct})${f}[,.，、。]?(?=${punct}|$)`, 'gi'),
      ' ',
    );
  }

  return result;
}

/**
 * Remove filler words from transcribed text using the given language code.
 *
 * Priority for language selection (in extension.ts):
 *   result.language (provider-detected) → settings.language → 'en' fallback
 *
 * @param text          Post-formatted transcription text
 * @param languageCode  ISO 639-1 code (e.g. 'en', 'de', 'ru'). Also accepts
 *                      BCP-47 tags like 'en-US' — the base code is extracted.
 */
export function removeFillerWords(text: string, languageCode: string): string {
  if (!text) {
    return text;
  }

  // Normalize: 'en-US' → 'en', '' → 'en'
  const lang = (languageCode || '').toLowerCase().split(/[-_]/)[0] || 'en';
  const fillers = FILLER_WORDS[lang] ?? FILLER_WORDS['en'];

  let result = text;

  for (const filler of fillers) {
    result = applyFillerRemoval(result, filler);
  }

  // Clean up double commas (ASCII and CJK fullwidth) left by removals
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/，\s*，/g, '，');
  result = result.replace(/、\s*、/g, '、');
  result = result.replace(/ {2,}/g, ' ').trim();

  // Re-capitalize if filler removal exposed a lowercase start
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  return result;
}
