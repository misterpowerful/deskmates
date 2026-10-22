import { Agent, setGlobalDispatcher } from "undici";

// Both the Anthropic and ElevenLabs Node SDKs call the global fetch() under
// the hood. Installing a shared keep-alive dispatcher here makes every
// request from either SDK reuse pooled connections instead of opening a
// fresh TCP+TLS connection per call — this matters for voice-pipeline
// latency, where every request is on the critical path.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 10,
  }),
);
