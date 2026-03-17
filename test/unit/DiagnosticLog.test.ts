import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppendLine = vi.fn();
const mockDispose = vi.fn();

vi.mock('vscode', () => ({
  default: {
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: mockAppendLine,
        append: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: mockDispose,
      })),
    },
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: mockAppendLine,
      append: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: mockDispose,
    })),
  },
}));

import { configureDiagnosticLog, diagLog, disposeDiagnosticLog } from '../../src/DiagnosticLog';

describe('DiagnosticLog', () => {
  beforeEach(() => {
    // Reset to disabled state between tests
    disposeDiagnosticLog();
    mockAppendLine.mockClear();
    mockDispose.mockClear();
  });

  describe('diagLog()', () => {
    it('does nothing when logging is disabled', () => {
      configureDiagnosticLog(false);
      diagLog('Test', 'hello');
      expect(mockAppendLine).not.toHaveBeenCalled();
    });

    it('writes to output channel when enabled', () => {
      configureDiagnosticLog(true);
      // configureDiagnosticLog(true) writes an initial "Diagnostic logging enabled" line
      const callsBefore = mockAppendLine.mock.calls.length;
      diagLog('Test', 'hello world');
      expect(mockAppendLine).toHaveBeenCalledTimes(callsBefore + 1);
      expect(mockAppendLine.mock.calls[callsBefore][0]).toMatch(/\[.*\] \[Test\] hello world/);
    });

    it('includes timestamp in HH:MM:SS.mmm format', () => {
      configureDiagnosticLog(true);
      diagLog('Source', 'msg');
      const lastCall = mockAppendLine.mock.calls.at(-1)![0] as string;
      // Timestamp is ISO slice [11,23] → HH:MM:SS.mmm
      expect(lastCall).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    });

    it('includes source in brackets', () => {
      configureDiagnosticLog(true);
      diagLog('RecorderManager', 'started recording');
      const lastCall = mockAppendLine.mock.calls.at(-1)![0] as string;
      expect(lastCall).toContain('[RecorderManager]');
    });

    it('creates channel lazily on first log when enabled', () => {
      // Enable first, then log
      configureDiagnosticLog(true);
      diagLog('Test', 'first message');
      expect(mockAppendLine).toHaveBeenCalledOnce();
    });
  });

  describe('configureDiagnosticLog()', () => {
    it('enables logging', () => {
      configureDiagnosticLog(true);
      diagLog('Test', 'should appear');
      expect(mockAppendLine).toHaveBeenCalledOnce();
    });

    it('disables logging', () => {
      configureDiagnosticLog(true);
      configureDiagnosticLog(false);
      diagLog('Test', 'should not appear');
      expect(mockAppendLine).not.toHaveBeenCalled();
    });
  });

  describe('disposeDiagnosticLog()', () => {
    it('disposes the output channel', () => {
      configureDiagnosticLog(true);
      diagLog('Test', 'create channel');
      disposeDiagnosticLog();
      expect(mockDispose).toHaveBeenCalledOnce();
    });

    it('is safe to call when no channel exists', () => {
      // Should not throw
      disposeDiagnosticLog();
      disposeDiagnosticLog();
    });
  });
});
