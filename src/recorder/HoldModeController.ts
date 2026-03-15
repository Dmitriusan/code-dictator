/**
 * Manages hold-to-talk recording mode.
 *
 * VS Code keybindings don't support keyup events, so we detect key release
 * via the OS key-repeat pattern: while a key is held, the OS fires repeated
 * keydown events. When repeats stop arriving, a debounce timer fires and
 * we treat that as "key released".
 *
 * Two-phase debounce:
 * - Initial phase (before first repeat): 800ms — must be longer than the OS
 *   key-repeat delay (typically 500–660ms on Linux, ~500ms on macOS/Windows).
 * - After first repeat detected: 300ms — key repeats arrive every 30–100ms,
 *   so 300ms reliably detects when they stop.
 */
export class HoldModeController {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _isHolding = false;
  private repeatDetected = false;
  private readonly initialDebounceMs: number;
  private readonly repeatDebounceMs: number;

  private onStartCallback: (() => void) | null = null;
  private onReleaseCallback: (() => void) | null = null;

  constructor(initialDebounceMs = 800, repeatDebounceMs = 300) {
    this.initialDebounceMs = initialDebounceMs;
    this.repeatDebounceMs = repeatDebounceMs;
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
      this.repeatDetected = false;
      this.onStartCallback?.();
    } else {
      // Subsequent keydown while holding — OS key-repeat is working
      this.repeatDetected = true;
    }

    // Use a longer timeout before the first repeat arrives (must exceed the
    // OS key-repeat delay), then switch to a shorter one once we know
    // repeats are flowing.
    const timeoutMs = this.repeatDetected ? this.repeatDebounceMs : this.initialDebounceMs;

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this._isHolding) {
        this._isHolding = false;
        this.onReleaseCallback?.();
      }
    }, timeoutMs);
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
    this.repeatDetected = false;
  }

  dispose(): void {
    this.cancel();
    this.onStartCallback = null;
    this.onReleaseCallback = null;
  }
}
