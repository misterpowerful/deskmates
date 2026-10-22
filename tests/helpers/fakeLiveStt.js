// A stand-in for ElevenLabs' realtime Scribe connection (offline rule): starts
// its session on the next tick, and on commit "transcribes" by decoding the
// audio it was sent as UTF-8 text.
export function fakeConnect({ sessionDelayMs = 0, failConnect = false, emitError = false, neverCommit = false, sendThrows = false, commitThrows = false, dropAfterStart = false } = {}) {
  const sent = [];
  const connect = async () => {
    if (failConnect) throw new Error("connect refused");
    const handlers = {};
    const conn = {
      on: (event, fn) => (handlers[event] = fn),
      send: ({ audioBase64 }) => {
        if (sendThrows) throw new Error("socket write failed");
        sent.push(Buffer.from(audioBase64, "base64").toString("utf8"));
      },
      commit: () => {
        if (commitThrows) throw new Error("commit failed");
        if (!neverCommit) setImmediate(() => handlers.committed_transcript?.({ text: sent.join("") }));
      },
      close: () => {
        conn.closed = true;
      },
    };
    setTimeout(() => {
      if (emitError) return handlers.error?.({ error: "quota exceeded" });
      handlers.session_started?.({});
      if (dropAfterStart) handlers.close?.();
    }, sessionDelayMs);
    return conn;
  };
  return { connect, sent };
}
