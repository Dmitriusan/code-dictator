import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
const mockEditBuilder = {
  insert: vi.fn(),
  replace: vi.fn(),
};
const mockEdit = vi.fn(async (cb: (builder: typeof mockEditBuilder) => void) => {
  cb(mockEditBuilder);
  return true;
});

vi.mock('vscode', () => ({
  default: {
    window: {
      activeTextEditor: undefined as unknown,
    },
    env: {
      clipboard: {
        writeText: (...args: unknown[]) => mockClipboardWrite(...args),
      },
    },
  },
  window: {
    get activeTextEditor() {
      // Dynamically return the current mock value
      return (vi.mocked as any).__activeTextEditor;
    },
  },
  env: {
    clipboard: {
      writeText: (...args: unknown[]) => mockClipboardWrite(...args),
    },
  },
}));

import { TextInjector } from '../../../src/injection/TextInjector';
import * as vscode from 'vscode';

describe('TextInjector', () => {
  let injector: TextInjector;

  beforeEach(() => {
    injector = new TextInjector();
    mockClipboardWrite.mockClear();
    mockEditBuilder.insert.mockClear();
    mockEditBuilder.replace.mockClear();
    mockEdit.mockClear();
    (vi.mocked as any).__activeTextEditor = undefined;
  });

  describe('empty text handling', () => {
    it('returns message for empty text', async () => {
      const result = await injector.inject('', 'editor', false);
      expect(result).toBe('Empty transcription — nothing to inject');
    });

    it('returns message for whitespace-only text', async () => {
      const result = await injector.inject('   \n\t  ', 'editor', false);
      expect(result).toBe('Empty transcription — nothing to inject');
    });
  });

  describe('clipboard target', () => {
    it('copies text to clipboard', async () => {
      const result = await injector.inject('hello world', 'clipboard', false);
      expect(mockClipboardWrite).toHaveBeenCalledWith('hello world');
      expect(result).toBe('clipboard');
    });
  });

  describe('editor target', () => {
    it('falls back to clipboard when no active editor', async () => {
      (vi.mocked as any).__activeTextEditor = undefined;
      const result = await injector.inject('hello', 'editor', false);
      expect(mockClipboardWrite).toHaveBeenCalledWith('hello');
      expect(result).toBe('clipboard');
    });

    it('inserts at cursor when selection is empty', async () => {
      const mockEditor = {
        selection: {
          isEmpty: true,
          active: { line: 0, character: 5 },
        },
        edit: mockEdit,
      };
      (vi.mocked as any).__activeTextEditor = mockEditor;

      const result = await injector.inject('text', 'editor', false);
      expect(mockEdit).toHaveBeenCalledOnce();
      expect(mockEditBuilder.insert).toHaveBeenCalledWith(
        mockEditor.selection.active,
        'text',
      );
      expect(result).toBe('editor');
    });

    it('replaces selection when selection is not empty', async () => {
      const selection = {
        isEmpty: false,
        active: { line: 0, character: 5 },
      };
      const mockEditor = {
        selection,
        edit: mockEdit,
      };
      (vi.mocked as any).__activeTextEditor = mockEditor;

      const result = await injector.inject('replacement', 'editor', false);
      expect(mockEditBuilder.replace).toHaveBeenCalledWith(selection, 'replacement');
      expect(result).toBe('editor');
    });
  });

  describe('auto-copy to clipboard', () => {
    it('copies to clipboard when autoCopy is true and target is editor', async () => {
      const mockEditor = {
        selection: { isEmpty: true, active: { line: 0, character: 0 } },
        edit: mockEdit,
      };
      (vi.mocked as any).__activeTextEditor = mockEditor;

      await injector.inject('hello', 'editor', true);
      // Should copy to clipboard in addition to editor insert
      expect(mockClipboardWrite).toHaveBeenCalledWith('hello');
    });

    it('does not double-copy when target is already clipboard', async () => {
      await injector.inject('hello', 'clipboard', true);
      // Only one clipboard write (the primary one)
      expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
    });

    it('does not copy when autoCopy is false', async () => {
      const mockEditor = {
        selection: { isEmpty: true, active: { line: 0, character: 0 } },
        edit: mockEdit,
      };
      (vi.mocked as any).__activeTextEditor = mockEditor;

      await injector.inject('hello', 'editor', false);
      expect(mockClipboardWrite).not.toHaveBeenCalled();
    });
  });

  describe('default target fallback', () => {
    it('uses clipboard as default fallback', async () => {
      const result = await injector.inject('hello', 'clipboard', false);
      expect(result).toBe('clipboard');
    });
  });
});
