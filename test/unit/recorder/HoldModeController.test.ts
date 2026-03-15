import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HoldModeController } from '../../../src/recorder/HoldModeController';

describe('HoldModeController', () => {
  let controller: HoldModeController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new HoldModeController(250);
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

  it('fires onRelease when debounce timer expires (key released)', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(250);

    expect(controller.isHolding).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('does not fire onRelease while key repeats keep arriving', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();

    // Simulate key repeats every 50ms for 500ms (well past debounce)
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(50);
      controller.handleKeyDown();
    }

    expect(onRelease).not.toHaveBeenCalled();
    expect(controller.isHolding).toBe(true);

    // Now stop pressing — debounce fires
    vi.advanceTimersByTime(250);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(controller.isHolding).toBe(false);
  });

  it('resets debounce timer on each keydown', () => {
    const onRelease = vi.fn();
    controller.onRelease(onRelease);

    controller.handleKeyDown();

    // Advance 200ms (not enough to trigger)
    vi.advanceTimersByTime(200);
    expect(onRelease).not.toHaveBeenCalled();

    // Another keydown resets the timer
    controller.handleKeyDown();

    // Advance another 200ms — still not enough since timer was reset
    vi.advanceTimersByTime(200);
    expect(onRelease).not.toHaveBeenCalled();

    // 50ms more = 250ms since last keydown
    vi.advanceTimersByTime(50);
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

    // Advance past debounce — should not fire
    vi.advanceTimersByTime(500);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('can start a new hold after cancel', () => {
    const onStart = vi.fn();
    const onRelease = vi.fn();
    controller.onStart(onStart);
    controller.onRelease(onRelease);

    controller.handleKeyDown();
    controller.cancel();

    // New hold
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(250);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('can start a new hold after release', () => {
    const onStart = vi.fn();
    const onRelease = vi.fn();
    controller.onStart(onStart);
    controller.onRelease(onRelease);

    // First hold
    controller.handleKeyDown();
    vi.advanceTimersByTime(250);
    expect(onRelease).toHaveBeenCalledTimes(1);

    // Second hold
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(controller.isHolding).toBe(true);

    vi.advanceTimersByTime(250);
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
    vi.advanceTimersByTime(500);
    expect(onRelease).not.toHaveBeenCalled();

    // New keydowns after dispose should not fire callbacks
    controller.handleKeyDown();
    expect(onStart).toHaveBeenCalledTimes(1); // only the pre-dispose call
  });

  it('uses custom debounce interval', () => {
    const customController = new HoldModeController(100);
    const onRelease = vi.fn();
    customController.onRelease(onRelease);

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

    vi.advanceTimersByTime(250);
    expect(controller.isHolding).toBe(false);
  });
});
