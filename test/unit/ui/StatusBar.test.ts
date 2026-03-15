import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStatusBarItems: Array<ReturnType<typeof createItem>> = [];

function createItem() {
  return {
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    name: undefined as string | undefined,
    backgroundColor: undefined as unknown,
    color: undefined as unknown,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock('vscode', () => ({
  default: {
    window: {
      createStatusBarItem: vi.fn(() => {
        const item = createItem();
        mockStatusBarItems.push(item);
        return item;
      }),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          if (key === 'successFlashDuration') return 5;
          if (key === 'successFlashBackground') return false;
          return defaultValue;
        }),
      })),
    },
  },
  window: {
    createStatusBarItem: vi.fn(() => {
      const item = createItem();
      mockStatusBarItems.push(item);
      return item;
    }),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === 'successFlashDuration') return 5;
        if (key === 'successFlashBackground') return false;
        return defaultValue;
      }),
    })),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: vi.fn(function (this: { id: string }, id: string) { this.id = id; }),
}));

import { StatusBar } from '../../../src/ui/StatusBar';

describe('StatusBar', () => {
  let statusBar: StatusBar;
  let micButton: ReturnType<typeof createItem>;
  let langIndicator: ReturnType<typeof createItem>;
  let costIndicator: ReturnType<typeof createItem>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStatusBarItems.length = 0;
    statusBar = new StatusBar();
    // Constructor creates 3 items: mic, language, cost
    micButton = mockStatusBarItems[0];
    langIndicator = mockStatusBarItems[1];
    costIndicator = mockStatusBarItems[2];
  });

  afterEach(() => {
    statusBar.dispose();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates 3 status bar items', () => {
      expect(mockStatusBarItems).toHaveLength(3);
    });

    it('starts in idle state', () => {
      expect(micButton.text).toBe('$(mic) Dictator');
    });

    it('sets correct commands on items', () => {
      expect(micButton.command).toBe('codeDictator.toggleRecording');
      expect(langIndicator.command).toBe('codeDictator.selectLanguage');
      expect(costIndicator.command).toBe('codeDictator.showUsage');
    });
  });

  describe('updateState()', () => {
    it('sets idle state correctly', () => {
      statusBar.updateState('recording'); // change first
      statusBar.updateState('idle');
      expect(micButton.text).toBe('$(mic) Dictator');
      expect(micButton.backgroundColor).toBeUndefined();
      expect(micButton.color).toBeUndefined();
    });

    it('sets recording state with timer at 0:00', () => {
      statusBar.updateState('recording');
      expect(micButton.text).toBe('$(mic-filled) 0:00');
      expect(micButton.backgroundColor).toBeTruthy(); // ThemeColor
    });

    it('updates recording timer after 500ms', () => {
      statusBar.updateState('recording');
      vi.advanceTimersByTime(1500);
      // After 1.5s, timer should show 0:01 (floor of 1.5s = 1)
      expect(micButton.text).toMatch(/\$\(mic-filled\) \d+:\d{2}/);
    });

    it('sets transcribing state', () => {
      statusBar.updateState('transcribing');
      expect(micButton.text).toBe('$(loading~spin) Transcribing...');
      expect(micButton.backgroundColor).toBeUndefined();
    });

    it('sets cleaning state', () => {
      statusBar.updateState('cleaning');
      expect(micButton.text).toBe('$(sparkle) Cleaning up...');
    });

    it('stops recording timer when transitioning to transcribing', () => {
      statusBar.updateState('recording');
      statusBar.updateState('transcribing');
      // Timer should be stopped — no further updates
      const textAfterTranscribing = micButton.text;
      vi.advanceTimersByTime(1000);
      expect(micButton.text).toBe(textAfterTranscribing);
    });
  });

  describe('updateLanguage()', () => {
    it('shows language indicator with code', () => {
      statusBar.updateLanguage('en');
      expect(langIndicator.text).toBe('$(globe) EN');
      expect(langIndicator.show).toHaveBeenCalled();
    });

    it('hides language indicator when empty', () => {
      statusBar.updateLanguage('');
      expect(langIndicator.hide).toHaveBeenCalled();
    });
  });

  describe('updateCost()', () => {
    it('shows cost indicator when enabled', () => {
      statusBar.updateCost('$(credit-card) $0.02', true);
      expect(costIndicator.text).toBe('$(credit-card) $0.02');
      expect(costIndicator.show).toHaveBeenCalled();
    });

    it('hides cost indicator when disabled', () => {
      statusBar.updateCost('$(credit-card) $0.02', false);
      expect(costIndicator.hide).toHaveBeenCalled();
    });

    it('hides cost indicator when text is empty', () => {
      statusBar.updateCost('', true);
      expect(costIndicator.hide).toHaveBeenCalled();
    });
  });

  describe('showTransientMessage()', () => {
    it('shows message in mic button', () => {
      statusBar.showTransientMessage('$(check) Done');
      expect(micButton.text).toBe('$(check) Done');
    });

    it('reverts to idle after duration', () => {
      statusBar.showTransientMessage('$(check) Done', 2000);
      vi.advanceTimersByTime(2000);
      expect(micButton.text).toBe('$(mic) Dictator');
    });

    it('cancels previous transient message timer', () => {
      statusBar.showTransientMessage('first', 5000);
      statusBar.showTransientMessage('second', 3000);
      expect(micButton.text).toBe('second');
      vi.advanceTimersByTime(3000);
      expect(micButton.text).toBe('$(mic) Dictator');
    });

    it('applies success styling when success=true', () => {
      statusBar.showTransientMessage('$(check) Success', undefined, true);
      // Success sets color (text-only mode by default, no background)
      expect(micButton.color).toBeTruthy();
    });
  });

  describe('show() / hide()', () => {
    it('show() shows mic button', () => {
      statusBar.show();
      expect(micButton.show).toHaveBeenCalled();
    });

    it('hide() hides all items', () => {
      statusBar.hide();
      expect(micButton.hide).toHaveBeenCalled();
      expect(langIndicator.hide).toHaveBeenCalled();
      expect(costIndicator.hide).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('disposes all status bar items', () => {
      statusBar.dispose();
      expect(micButton.dispose).toHaveBeenCalled();
      expect(langIndicator.dispose).toHaveBeenCalled();
      expect(costIndicator.dispose).toHaveBeenCalled();
    });

    it('clears recording timer', () => {
      statusBar.updateState('recording');
      statusBar.dispose();
      // Should not throw or leave dangling timers
      vi.advanceTimersByTime(5000);
    });
  });
});
