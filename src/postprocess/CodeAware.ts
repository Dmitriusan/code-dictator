/**
 * Code-aware term replacement: converts spoken programming terms to their
 * symbol equivalents. Case-insensitive, word-boundary aware.
 */

const CODE_TERMS: ReadonlyArray<[string, string]> = [
  // Grouping symbols
  ['open paren', '('],
  ['close paren', ')'],
  ['open parenthesis', '('],
  ['close parenthesis', ')'],
  ['open bracket', '['],
  ['close bracket', ']'],
  ['open brace', '{'],
  ['close brace', '}'],
  ['open curly', '{'],
  ['close curly', '}'],
  ['open angle', '<'],
  ['close angle', '>'],

  // Compound operators (must come before single-char versions)
  ['arrow function', '=>'],
  ['fat arrow', '=>'],
  ['not equals', '!=='],
  ['not equal', '!=='],
  ['double equals', '=='],
  ['triple equals', '==='],
  ['less than or equal', '<='],
  ['greater than or equal', '>='],
  ['plus equals', '+='],
  ['minus equals', '-='],
  ['and and', '&&'],
  ['or or', '||'],

  // Whitespace
  ['new line', '\n'],
  ['newline', '\n'],
  ['tab', '\t'],

  // Punctuation & single operators
  ['semicolon', ';'],
  ['colon', ':'],
  ['equals', '='],
  ['period', '.'],
  ['dot', '.'],
  ['comma', ','],
  ['less than', '<'],
  ['greater than', '>'],
  ['plus', '+'],
  ['minus', '-'],
  ['asterisk', '*'],
  ['star', '*'],
  ['slash', '/'],
  ['forward slash', '/'],
  ['backslash', '\\'],
  ['back slash', '\\'],
  ['pipe', '|'],
  ['ampersand', '&'],
  ['hash', '#'],
  ['at sign', '@'],
  ['dollar sign', '$'],
  ['percent', '%'],
  ['caret', '^'],
  ['tilde', '~'],
  ['exclamation', '!'],
  ['exclamation mark', '!'],
  ['bang', '!'],
  ['question mark', '?'],
  ['underscore', '_'],
  ['backtick', '`'],
  ['single quote', "'"],
  ['double quote', '"'],
];

/**
 * Apply code-aware term replacements to transcribed text.
 * Matches are case-insensitive and respect word boundaries.
 */
export function applyCodeAware(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  for (const [spoken, symbol] of CODE_TERMS) {
    // Build a regex with word boundaries and case-insensitive flag.
    // Escape any special regex characters in the spoken term.
    const escaped = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, symbol);
  }

  return result;
}
