// Per-connection turn serialization. Turns on one ws share session memory,
// sticky mode state and the pending GitHub write, so they must run one at a
// time in arrival order. State lives on the ws object (garbage-collected
// with it).

export const MAX_WAITING_TURNS = 3;

export class TurnQueueFullError extends Error {
  constructor() {
    super("busy, try again");
    this.name = "TurnQueueFullError";
  }
}

// Runs fn after all earlier turns on ws settle. Resolves/rejects with fn's
// outcome; a rejected turn never blocks later ones. If more than maxWaiting
// turns are already waiting (not counting the running one), rejects
// immediately with TurnQueueFullError without queueing fn.
export function enqueueTurn(ws, fn, maxWaiting = MAX_WAITING_TURNS) {
  const q = (ws.turnQueue ??= { tail: Promise.resolve(), pending: 0 });
  // pending counts the running turn plus the waiting ones.
  if (q.pending > maxWaiting) {
    return Promise.reject(new TurnQueueFullError());
  }
  q.pending++;
  const result = q.tail.then(fn);
  q.tail = result.then(
    () => {},
    () => {},
  );
  q.tail.then(() => {
    q.pending--;
  });
  return result;
}
