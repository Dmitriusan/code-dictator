import { describe, it, expect } from 'vitest';
import { applyCodeAware } from '../../../src/postprocess/CodeAware';

describe('CodeAware.applyCodeAware()', () => {
  it('returns empty string for empty input', () => {
    expect(applyCodeAware('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    expect(applyCodeAware('')).toBe('');
  });

  // Grouping symbols
  it('converts "open paren" to "("', () => {
    expect(applyCodeAware('open paren')).toBe('(');
  });

  it('converts "close paren" to ")"', () => {
    expect(applyCodeAware('close paren')).toBe(')');
  });

  it('converts "open bracket" to "["', () => {
    expect(applyCodeAware('open bracket')).toBe('[');
  });

  it('converts "close bracket" to "]"', () => {
    expect(applyCodeAware('close bracket')).toBe(']');
  });

  it('converts "open brace" to "{"', () => {
    expect(applyCodeAware('open brace')).toBe('{');
  });

  it('converts "close brace" to "}"', () => {
    expect(applyCodeAware('close brace')).toBe('}');
  });

  it('converts "open angle" to "<"', () => {
    expect(applyCodeAware('open angle')).toBe('<');
  });

  it('converts "close angle" to ">"', () => {
    expect(applyCodeAware('close angle')).toBe('>');
  });

  it('converts "open parenthesis" to "("', () => {
    expect(applyCodeAware('open parenthesis')).toBe('(');
  });

  it('converts "close parenthesis" to ")"', () => {
    expect(applyCodeAware('close parenthesis')).toBe(')');
  });

  it('converts "open curly" to "{"', () => {
    expect(applyCodeAware('open curly')).toBe('{');
  });

  it('converts "close curly" to "}"', () => {
    expect(applyCodeAware('close curly')).toBe('}');
  });

  // Punctuation
  it('converts "semicolon" to ";"', () => {
    expect(applyCodeAware('semicolon')).toBe(';');
  });

  it('converts "colon" to ":"', () => {
    expect(applyCodeAware('colon')).toBe(':');
  });

  // Compound operators
  it('converts "arrow function" to "=>"', () => {
    expect(applyCodeAware('arrow function')).toBe('=>');
  });

  it('converts "fat arrow" to "=>"', () => {
    expect(applyCodeAware('fat arrow')).toBe('=>');
  });

  it('converts "not equals" to "!=="', () => {
    expect(applyCodeAware('not equals')).toBe('!==');
  });

  it('converts "double equals" to "==="', () => {
    expect(applyCodeAware('double equals')).toBe('===');
  });

  it('converts "triple equals" to "==="', () => {
    expect(applyCodeAware('triple equals')).toBe('===');
  });

  it('converts "less than or equal" to "<="', () => {
    expect(applyCodeAware('less than or equal')).toBe('<=');
  });

  it('converts "greater than or equal" to ">="', () => {
    expect(applyCodeAware('greater than or equal')).toBe('>=');
  });

  it('converts "plus equals" to "+="', () => {
    expect(applyCodeAware('plus equals')).toBe('+=');
  });

  it('converts "minus equals" to "-="', () => {
    expect(applyCodeAware('minus equals')).toBe('-=');
  });

  it('converts "and and" to "&&"', () => {
    expect(applyCodeAware('and and')).toBe('&&');
  });

  it('converts "or or" to "||"', () => {
    expect(applyCodeAware('or or')).toBe('||');
  });

  // Whitespace
  it('converts "new line" to "\\n"', () => {
    expect(applyCodeAware('new line')).toBe('\n');
  });

  it('converts "newline" to "\\n"', () => {
    expect(applyCodeAware('newline')).toBe('\n');
  });

  it('converts "tab" to "\\t"', () => {
    expect(applyCodeAware('tab')).toBe('\t');
  });

  // Case insensitive
  it('is case insensitive: "Open Paren" to "("', () => {
    expect(applyCodeAware('Open Paren')).toBe('(');
  });

  it('is case insensitive: "SEMICOLON" to ";"', () => {
    expect(applyCodeAware('SEMICOLON')).toBe(';');
  });

  it('is case insensitive: "Arrow Function" to "=>"', () => {
    expect(applyCodeAware('Arrow Function')).toBe('=>');
  });

  // Multiple replacements
  it('handles multiple replacements in one string', () => {
    expect(applyCodeAware('open paren close paren')).toBe('( )');
  });

  it('handles multiple different replacements', () => {
    expect(applyCodeAware('x equals 5 semicolon')).toBe('x = 5 ;');
  });

  // Word boundary — partial words should NOT be replaced
  it('does not replace partial words: "semicolons" stays as is', () => {
    expect(applyCodeAware('semicolons')).toBe('semicolons');
  });

  it('does not replace "colons" (partial match for "colon")', () => {
    expect(applyCodeAware('colons')).toBe('colons');
  });

  it('does not replace "equals" inside "unequals"', () => {
    // "equals" as whole word should be replaced, but "unequals" should not match
    // "unequals" doesn't have a word boundary before "equals" (it has "un" prefix)
    // Actually: \bequals\b won't match inside "unequals" because there's no word boundary between 'n' and 'e'
    // Wait — 'unequals' has no word boundary before 'equals'. Correct: no replacement.
    expect(applyCodeAware('unequals')).toBe('unequals');
  });

  // Mixed text and code terms
  it('handles mixed text and code terms', () => {
    expect(applyCodeAware('let x equals 10 semicolon')).toBe('let x = 10 ;');
  });

  it('handles code terms surrounded by regular text', () => {
    expect(applyCodeAware('type the open paren symbol')).toBe('type the ( symbol');
  });

  // Real-world example
  it('handles a real-world function definition', () => {
    const input =
      'function hello open paren close paren open brace new line return true semicolon new line close brace';
    const result = applyCodeAware(input);
    expect(result).toBe('function hello ( ) { \n return true ; \n }');
  });

  // Additional single operators
  it('converts "period" to "."', () => {
    expect(applyCodeAware('period')).toBe('.');
  });

  it('converts "dot" to "."', () => {
    expect(applyCodeAware('dot')).toBe('.');
  });

  it('converts "comma" to ","', () => {
    expect(applyCodeAware('comma')).toBe(',');
  });

  it('converts "hash" to "#"', () => {
    expect(applyCodeAware('hash')).toBe('#');
  });

  it('converts "underscore" to "_"', () => {
    expect(applyCodeAware('underscore')).toBe('_');
  });

  it('converts "backtick" to "`"', () => {
    expect(applyCodeAware('backtick')).toBe('`');
  });

  it('preserves text without code terms', () => {
    expect(applyCodeAware('hello world this is a test')).toBe(
      'hello world this is a test'
    );
  });
});
