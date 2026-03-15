import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => import('../__mocks__/vscode').then(m => m.default));

import { RecorderManager } from '../../../src/recorder/RecorderManager';

describe('RecorderManager', () => {
  let manager: RecorderManager;
  const mockExtensionUri = { fsPath: '/mock/extension' };

  beforeEach(() => {
    manager = new RecorderManager(mockExtensionUri as any);
  });

  describe('initial state', () => {
    it('is not recording initially', () => {
      expect(manager.isRecording).toBe(false);
    });

    it('cancelRecording is safe when not recording', () => {
      expect(() => manager.cancelRecording()).not.toThrow();
    });

    it('dispose is safe when not recording', () => {
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  describe('event listeners', () => {
    it('onError returns a disposable', () => {
      const disposable = manager.onError(() => {});
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });

    it('onSilenceDetected returns a disposable', () => {
      const disposable = manager.onSilenceDetected(() => {});
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });

    it('disposing a listener removes it', () => {
      const handler = vi.fn();
      const disposable = manager.onError(handler);
      disposable.dispose();

      // Trigger error internally — handler should NOT be called
      (manager as any).emit('error', 'test');
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
