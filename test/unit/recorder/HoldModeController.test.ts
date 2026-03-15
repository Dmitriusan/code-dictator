import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HoldModeController } from '../../../src/recorder/HoldModeController';

describe('HoldModeController', () => {
  let controller: HoldModeController;

  // Use distinct values so we can verify which phase is active
  const INITIAL_MS = 500;
  const REPEAT_MS = 200;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new HoldModeController(INITIAL_MS, REPEAT_MS);
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  it('is not holding initially', () => {
    expect(controller.isHolding).toBe(false);
  });

  it('starts holding on first keydown', () => {
    const onStart = vi.fn();
    controller.onStart(onStart);

    controller.handleKeyDown();

    expect(controller.isHolding).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('fires onStart only once for repeated keydowns', () => {
    const onStart = vi.fn();
    controller.onStart(onStart);

    controller.handleKeyDown();
    controller.handleKeyDown();
    controller.handleKeyDown();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(controller.isHolding).toBe(true);
  });

  it('uses initial debounce for single keydown (no repeats)', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    expect(controller.isHolding).toBe(true);

    // Should NOT fire at repeat debounce time
    vi.advanceTimersByTime(REPEAT_MS);
    expect(onRelease).not.toHaveBeenCalled();
    expect(controller.isHolding).toBe(true);

    // Should fire at initial debounce time
    vi.advanceTimersByTime(INITIAL_MS - REPEAT_MS);
    expect(controller.isHolding).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('does not fire onRelease while key repeats keep arriving', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();

    // Simulate key repeats every 50ms for 600ms (well past initial debounce)
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(50);
      controller.handleKeyDown();
    }

    expect(onRelease).not.toHaveBeenCalled();
    expect(controller.isHolding).toBe(true);

    // Now stop pressing — repeat debounce fires (shorter timeout)
    vi.advanceTimersByTime(REPEAT_MS);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(controller.isHolding).toBe(false);
  });

  it('switches to repeat debounce after first repeat detected', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown(); // initial — uses INITIAL_MS
    vi.advanceTimersByTime(50);
    controller.handleKeyDown(); // first repeat — switches to REPEAT_MS

    // Should NOT fire before repeat debounce expires
    vi.advanceTimersByTime(REPEAT_MS - 1);
    expect(onRelease).not.toHaveBeenCalled();

    // Should fire right at repeat debounce
    vi.advanceTimersByTime(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('resets debounce timer on each keydown', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();

    // Advance partway through initial debounce
    vi.advanceTimersByTime(400);
    expect(onRelease).not.toHaveBeenCalled();

    // Another keydown resets the timer and switches to repeat debounce
    controller.handleKeyDown();

    // Advance partway through repeat debounce — not enough
    vi.advanceTimersByTime(REPEAT_MS - 10);
    expect(onRelease).not.toHaveBeenCalled();

    // Complete the repeat debounce
    vi.advanceTimersByTime(10);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('cancel() stops the hold without firing onRelease', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    expect(controller.isHolding).toBe(true);

    controller.cancel();

    expect(controller.isHolding).toBe(false);
    expect(onRelease).not.toHaveBeenCalled();

    // Advance past all debounce — should not fire
    vi.advanceTimersByTime(INITIAL_MS + REPEAT_MS);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('can start a new hold after cancel', () => {
    const onStart = vi.fn();
    const onRelease = vi.fn();
    controller.onStart(onStart);
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    controller.cancel();

    // New hold — should use initial debounce again (repeat state reset)
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(INITIAL_MS);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('can start a new hold after release', () => {
    const onStart = vi.fn();
    const onRelease = vi.fn();
    controller.onStart(onStart);
    controller.onRelease(onRelease);

    // First hold — no repeats, uses initial debounce
    controller.handleKeyDown();
    vi.advanceTimersByTime(INITIAL_MS);
    expect(onRelease).toHaveBeenCalledTimes(1);

    // Second hold — also starts fresh with initial debounce
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(INITIAL_MS);
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it('dispose() clears timers and callbacks', () => {
    const onStart = vi.fn();
    const onRelease = vi.fn();
    controller.onStart(onStart);
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    controller.dispose();

    // Should not fire after dispose
    vi.advanceTimersByTime(INITIAL_MS + REPEAT_MS);
    expect(onRelease).not.toHaveBeenCalled();

    // New keydowns after dispose should not fire callbacks
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(1); // only the pre-dispose call
  });

  it('uses custom debounce intervals', () => {
    const customController = new HoldModeController(100, 50);
    const onRelease = vi.fn();
    customController.onRelease(onRelease);

    // Single keydown — uses initial (100ms)
    customController.handleKeyDown();
    vi.advanceTimersByTime(99);
    expect(onRelease).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRelease).toHaveBeenCalledTimes(1);

    customController.dispose();
  });

  it('works without callbacks registered', () => {
    // Should not throw
    controller.handleKeyDown();
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(INITIAL_MS);
    expect(controller.isHolding).toBe(false);
  });
});
