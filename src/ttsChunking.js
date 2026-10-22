// ElevenLabs rejects a text-to-speech request whose text exceeds a
// per-model character cap. deep_thoughtful has no brevity ceiling (up to
// 4096 output tokens, ~16k chars), so a long reply can exceed the cap for
// some voices' models (eleven_v3: 5000, eleven_multilingual_v2: 10000).
// Rather than fail or drop to text, the reply is split at sentence
// boundaries into requests that each fit, and the PCM results concatenated.

const MODEL_CHAR_LIMITS = {
  eleven_flash_v2_5: 40000,
  eleven_turbo_v2_5: 40000,
  eleven_multilingual_v2: 10000,
  eleven_v3: 5000,
};
// Unknown models get the strictest known cap.
const DEFAULT_CHAR_LIMIT = 5000;
// Headroom under the documented cap so we never sit exactly on the edge.
const SAFETY_MARGIN = 0.9;

export function ttsCharLimit(modelId) {
  const cap = MODEL_CHAR_LIMITS[modelId] ?? DEFAULT_CHAR_LIMIT;
  return Math.floor(cap * SAFETY_MARGIN);
}

// Hard-splits a single over-long piece (no usable sentence/word break).
function hardSplit(piece, limit) {
  const out = [];
  for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit));
  return out;
}

// Splits text into chunks of at most `limit` chars, preferring sentence
// boundaries, then whitespace, then a hard cut. Non-string / blank input
// yields []. Chunks are trimmed and never empty.
export function splitForTts(text, limit) {
  if (typeof text !== "string" || !Number.isInteger(limit) || limit < 1) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const sentences = trimmed.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g) ?? [trimmed];
  const chunks = [];
  let current = "";
  const flush = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      // Over-long sentence: pack by words, hard-splitting any giant token.
      for (const word of sentence.split(/(\s+)/)) {
        if (word.length > limit) {
          flush();
          for (const part of hardSplit(word, limit)) chunks.push(part);
        } else if (current.length + word.length > limit) {
          flush();
          current = word;
        } else {
          current += word;
        }
      }
      flush();
    } else if (current.length + sentence.length > limit) {
      flush();
      current = sentence;
    } else {
      current += sentence;
    }
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

// Wraps `ttsClient.convert(voiceId, request)` in place so a request whose
// text exceeds the model's cap is sent as several requests in parallel and
// resolved as ONE Blob of the concatenated PCM, in original chunk order —
// callers keep making a single convert() call and reading a single stream.
// Throws on nothing to say; provider errors propagate untouched.
export function chunkTextToSpeech(ttsClient) {
  const convert = ttsClient.convert.bind(ttsClient);
  ttsClient.convert = async (voiceId, request) => {
    const chunks = splitForTts(request?.text, ttsCharLimit(request?.modelId));
    if (chunks.length === 0) throw new Error("tts: no text to synthesize");
    const buffers = await Promise.all(
      chunks.map(async (text) => {
        const stream = await convert(voiceId, { ...request, text });
        return Buffer.from(await new Response(stream).arrayBuffer());
      }),
    );
    return new Blob(buffers);
  };
  return ttsClient;
}
