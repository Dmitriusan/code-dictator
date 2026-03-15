/**
 * Auto-format transcribed text with basic cleanup.
 * No API cost — purely local string transformations.
 */
export function format(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  // Trim leading/trailing whitespace
  result = result.trim();

  // --- Noise & stutter removal (before formatting) ---

  // Remove bracketed sound descriptions: [engine revving], [cough], etc.
  result = result.replace(/\[.*?\]/g, '');

  // Remove stutter patterns: "u-uh", "m-uh", "b-um" (letter(s)-filler)
  result = result.replace(/\b\w+-(?:uh|um|ah)\b[,.]?\s*/gi, '');

  // Remove false starts / self-corrections: "the-- some" → "some".
  // STT engines use double-dash when the speaker abandons a word mid-utterance.
  result = result.replace(/\w+--[,.]?\s*/g, '');

  // --- Formatting ---

  // Collapse multiple spaces into one
  result = result.replace(/ {2,}/g, ' ');

  // Collapse multiple newlines into at most two
  result = result.replace(/\n{3,}/g, '\n\n');

  // Re-trim after removals (filler at start/end may leave whitespace)
  result = result.trim();

  // Capitalize first letter of the entire text
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  // Capitalize first letter after sentence-ending punctuation (. ! ?)
  result = result.replace(/([.!?])\s+([a-z])/g, (_match, punct: string, letter: string) => {
    return `${punct} ${letter.toUpperCase()}`;
  });

  // Capitalize first letter after newline
  result = result.replace(/\n\s*([a-z])/g, (_match, letter: string) => {
    return `\n${letter.toUpperCase()}`;
  });

  // Remove spurious commas after English articles — STT engines insert
  // commas at speech pauses, and "the, world" is almost never grammatical.
  result = result.replace(/\b(the|a|an),\s+/gi, '$1 ');

  // Remove space before punctuation
  result = result.replace(/ ([.,;:!?])/g, '$1');

  // Ensure space after punctuation if followed by a letter
  result = result.replace(/([.,;:!?])([A-Za-z])/g, '$1 $2');

  return result;
}
