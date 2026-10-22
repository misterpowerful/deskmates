// Streamed speech upload: the bot sends its audio while the person is still
// talking (speech_stream_start, binary chunks, speech_stream_end) instead of
// one speech_request + single binary frame after they stop. By the time the
// end arrives the audio is already here, so the turn starts with no upload
// wait. One open stream per connection; state lives on the ws object, like
// ws.pendingAudioRequest for the one-shot path.

// The bot caps a capture at 8 s of 16 kHz mono 16-bit (256 KB); allow some
// slack, but never let a stream that's never ended grow without bound.
export const MAX_STREAM_BYTES = 1024 * 1024;

// Opens a stream for id. Returns the id of a stream it replaced (still open,
// never ended or cancelled), or null.
export function startStream(ws, { id, mode, raw = false }) {
  const replaced = ws.audioStream ? ws.audioStream.id : null;
  ws.audioStream = { id, mode, raw: Boolean(raw), chunks: [], bytes: 0, overflow: false };
  return replaced;
}

// Takes a binary frame if a stream is open. Returns true if the frame
// belonged to the stream (consumed, even if dropped for size), false if no
// stream is open and the caller should handle it as before.
export function appendStreamChunk(ws, data) {
  const stream = ws.audioStream;
  if (!stream) return false;
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (stream.overflow || stream.bytes + chunk.length > MAX_STREAM_BYTES) {
    stream.overflow = true;
    return true;
  }
  stream.chunks.push(chunk);
  stream.bytes += chunk.length;
  return true;
}

// Closes the stream for id. Returns { ok: true, id, mode, raw, audio } with
// the whole utterance as one Buffer, or { ok: false, reason }.
export function endStream(ws, id) {
  const stream = ws.audioStream;
  if (!stream || stream.id !== id) {
    return { ok: false, reason: "no open speech stream with that id" };
  }
  ws.audioStream = null;
  if (stream.overflow) {
    return { ok: false, reason: `speech stream exceeded ${MAX_STREAM_BYTES} bytes` };
  }
  if (stream.bytes === 0) {
    return { ok: false, reason: "speech stream ended with no audio" };
  }
  return { ok: true, id: stream.id, mode: stream.mode, raw: stream.raw, audio: Buffer.concat(stream.chunks, stream.bytes) };
}

// Drops the open stream (if id is given, only when it matches). Returns true
// if one was dropped.
export function cancelStream(ws, id) {
  const stream = ws.audioStream;
  if (!stream || (id !== undefined && stream.id !== id)) return false;
  ws.audioStream = null;
  return true;
}
