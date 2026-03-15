/**
 * Manages hold-to-talk recording mode.
 *
 * VS Code keybindings don't support keyup events, so we detect key release
 * via the OS key-repeat pattern: while a key is held, the OS fires repeated
 * keydown events. When repeats stop arriving, a debounce timer fires and
 * we treat that as "key released".
 *
 * Typical OS key-repeat intervals are 30–100ms, so a 250ms debounce window
 * reliably distinguishes "still holding" from "released".
 */
export class HoldModeController {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _isHolding = false;
  private readonly debounceMs: number;

  private onStartCallback: (() => void) | null = null;
  private onReleaseCallback: (() => void) | null = null;

  constructor(debounceMs = 250) {
    this.debounceMs = debounceMs;
  }

  /** Register callback for when hold begins (first keydown). */
  onStart(cb: () => void): void {
    this.onStartCallback = cb;
  }

  /** Register callback for when key is released (debounce timer fires). */
  onRelease(cb: () => void): void {
    this.onReleaseCallback = cb;
  }

  /** Whether a hold is currently active. */
  get isHolding(): boolean {
    return this._isHolding;
  }

  /**
   * Called on every keydown event (Alt+D press / repeat).
   * First call starts the hold; subsequent calls reset the debounce timer.
   */
  handleKeyDown(): void {
    // Clear any pending release timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (!this._isHolding) {
      // First press — start recording
      this._isHolding = true;
      this.onStartCallback?.();
    }

    // (Re)start the debounce timer — if no more keydowns arrive within
    // debounceMs, we treat it as key released.
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this._isHolding) {
        this._isHolding = false;
        this.onReleaseCallback?.();
      }
    }, this.debounceMs);
  }

  /**
   * Force-cancel the hold without triggering the release callback.
   * Used when the user presses Escape during a hold.
   */
  cancel(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this._isHolding = false;
  }

  dispose(): void {
    this.cancel();
    this.onStartCallback = null;
    this.onReleaseCallback = null;
  }
}
