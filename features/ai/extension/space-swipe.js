// Turns wheel events into two-finger space swipes. Trackpads keep sending
// momentum for a second or more after the fingers lift, so silence alone cannot
// mark the start of the next swipe and the direction cannot lock for good.

export const SWIPE_IDLE_MS = 160; // a pause this long always ends a gesture
const LOCK = 5;                   // movement that decides the direction
const SWITCH = 38;                // horizontal movement that switches spaces
const TURN = 18;                  // steady movement that changes a decided direction,
const TURN_EVENTS = 3;            // over at least this many events in a row
const REARM_MS = 160;             // a new swipe never starts sooner after a switch

export function createSpaceSwipe() {
  let at = -Infinity, axis, dx, dy, turn, turns, switched, switchedAt, peak, trough;

  const start = () => {
    axis = null;
    dx = dy = turn = turns = 0;
    switched = 0; // the direction that switched, or 0
    switchedAt = -Infinity;
    peak = 0;
    trough = Infinity;
  };
  start();

  // Momentum only slows down. After it has clearly slowed, speeding up again or
  // reversing means the fingers are back.
  const isNewSwipe = (x, y, now) => {
    const speed = Math.abs(x);
    if (speed <= Math.abs(y) || now - switchedAt < REARM_MS) return false;
    if (Math.sign(x) !== switched) return speed >= 3;
    peak = Math.max(peak, speed);
    if (speed < peak * 0.5) trough = Math.min(trough, speed);
    return speed > trough * 1.8 + 4;
  };

  return {
    // Returns whether the event belongs to a horizontal swipe, the space step it
    // completes (-1, 0 or 1) and how far the list should follow the fingers.
    feed(x, y, now) {
      if (now - at > SWIPE_IDLE_MS) start();
      at = now;
      const across = Math.abs(x), along = Math.abs(y);

      if (!axis) {
        dx += x;
        dy += y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK) return { horizontal: across > along, step: 0, offset: 0 };
        axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      } else {
        // Steady movement along the other axis takes over, even during momentum.
        const crossing = axis === 'x' ? along > across * 2 : across > along * 2;
        turn = crossing ? turn + (axis === 'x' ? along : x) : 0;
        turns = crossing ? turns + 1 : 0;
        if (turns >= TURN_EVENTS && Math.abs(turn) >= TURN) {
          const next = axis === 'x' ? 'y' : 'x';
          start();
          axis = next;
        } else if (axis === 'x' && switched) {
          if (isNewSwipe(x, y, now)) {
            switched = 0;
            peak = 0;
            trough = Infinity;
            dx = x;
          }
        } else if (axis === 'x') dx += x;
      }

      if (axis === 'y') return { horizontal: false, step: 0, offset: 0 };
      if (switched) {
        peak = Math.max(peak, across);
        return { horizontal: true, step: 0, offset: 0 };
      }
      if (Math.abs(dx) < SWITCH) return { horizontal: true, step: 0, offset: Math.round(-dx * 0.3) };
      switched = Math.sign(dx);
      switchedAt = now;
      peak = across;
      trough = Infinity;
      return { horizontal: true, step: switched, offset: 0 };
    },
  };
}
