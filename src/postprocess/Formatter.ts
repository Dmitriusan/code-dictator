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

  // Collapse multiple spaces into one
  result = result.replace(/ {2,}/g, ' ');

  // Collapse multiple newlines into at most two
  result = result.replace(/\n{3,}/g, '\n\n');

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

  // Remove space before punctuation
  result = result.replace(/ ([.,;:!?])/g, '$1');

  // Ensure space after punctuation if followed by a letter
  result = result.replace(/([.,;:!?])([A-Za-z])/g, '$1 $2');

  return result;
}
