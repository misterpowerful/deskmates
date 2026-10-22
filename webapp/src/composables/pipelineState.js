import { reactive } from "vue";

// The exact, minimal reactive contract handed to visualization components —
// nothing else is exposed to them. `mode` is intentionally just `string`,
// not a union type: it holds whatever mode value requests are currently
// being sent with (see session.js DEFAULT_MODE), so a visualization never
// needs to know the live set of mode values to stay correct.
export const pipelineState = reactive({
  state: "idle", // 'idle' | 'listening' | 'thinking' | 'speaking'
  mode: "friendly",
  level: 0, // 0-1 smoothed amplitude, written by useAudioLevel.js
});
