// The Autopilot's heartbeat. One pass at a time, and the next one is always
// booked: a pass that throws must not end the loop, because Autopilot would stop
// moving while still reading ON, with no Resume to press.

/**
 * @param {{run: () => unknown, intervalMs: number, onError?: Function,
 *   setTimer?: Function, clearTimer?: Function}} options
 * @returns {{start: Function, schedule: Function, stop: Function}}
 */
export function createTickLoop({
  run,
  intervalMs,
  onError,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let running = false;
  let stopped = false;

  const idle = () => !stopped && !running && timer === null;

  async function pass() {
    timer = null;
    if (stopped || running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
      if (!stopped) timer = setTimer(pass, intervalMs);
    }
  }

  return {
    /** Runs a pass now, unless one is running or already booked. */
    start() {
      if (idle()) pass();
    },
    /** Books the next pass, unless one is running or already booked. */
    schedule() {
      if (idle()) timer = setTimer(pass, intervalMs);
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      timer = null;
    },
  };
}
