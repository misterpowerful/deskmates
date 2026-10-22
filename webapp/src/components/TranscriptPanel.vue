<template>
  <div class="tp-wrap">
    <div class="tp-bot-name">{{ activeBotName }}</div>
    <div class="tp-toolbar">
      <span class="tp-summary">{{ summaryLabel }}</span>
      <div class="tp-toolbar-actions">
        <button
          type="button"
          class="tp-copyall"
          :disabled="historyPull.loading"
          :aria-label="historyPull.loading ? 'Pulling today’s conversation' : 'Replace with today’s conversation'"
          @click="onPullToday"
        >
          <q-icon name="today" size="18px" />
          {{ historyPull.loading ? "Pulling…" : "Pull today" }}
        </button>
        <button type="button" class="tp-copyall" @click="onCopy">
          <q-icon name="content_copy" size="18px" />
          {{ copyLabel }}
        </button>
      </div>
    </div>

    <div ref="scrollEl" class="tp-scroll" role="log" aria-label="Conversation">
      <div v-if="transcript.length === 0" class="tp-empty">No turns yet — start talking.</div>

      <div
        v-for="(turn, i) in transcript"
        :key="i"
        class="tp-turn"
        :class="{ 'tp-turn--deep': isDeepThoughtful(turn) }"
        :style="turnVars(turn)"
      >
        <!-- Mine: right-aligned, avatar on the right. -->
        <div v-if="turn.user_text" class="tp-row tp-row--you">
          <div class="tp-body tp-body--you">
            <div class="tp-meta">
              <span class="tp-time">{{ fmtTime(turn.timestamp) }}</span>
              <span class="tp-name">You</span>
            </div>
            <div class="tp-text">{{ turn.user_text }}</div>
          </div>
          <div class="tp-avatar tp-avatar--you" aria-hidden="true">
            <q-icon name="person" size="20px" />
          </div>
        </div>

        <!-- The bot's line: avatar on the left, mode chip, per-reply copy. -->
        <div class="tp-row tp-row--bot">
          <div class="tp-avatar tp-avatar--bot" aria-hidden="true">{{ botInitial(turn) }}</div>
          <div class="tp-body">
            <div class="tp-meta">
              <span class="tp-name tp-name--bot">{{ botName(turn) }}</span>
              <span v-if="modeLabel(turn)" class="tp-chip">
                <q-icon v-if="isDeepThoughtful(turn)" name="psychology" size="14px" aria-hidden="true" />
                {{ modeLabel(turn) }}
              </span>
              <span class="tp-time">{{ fmtTime(turn.timestamp) }}</span>
              <button
                v-if="!turn.is_filler && turn.bot_text"
                type="button"
                class="tp-icon-btn"
                :aria-label="copyBoxIndices.has(i) ? 'Hide copy options' : 'Copy this reply'"
                @click="toggleCopyBox(i)"
              >
                <q-icon :name="copyBoxIndices.has(i) ? 'expand_less' : 'content_copy'" size="18px" />
              </button>
            </div>
            <span v-if="turn.pending" class="tp-typing" aria-label="Typing">
              <span class="tp-dot"></span><span class="tp-dot"></span><span class="tp-dot"></span>
            </span>
            <template v-else>
              <div class="tp-text">{{ turn.bot_text ?? "(no transcript line for this turn)" }}</div>
              <div v-if="copyBoxIndices.has(i)" class="tp-copybox-wrap">
                <textarea
                  readonly
                  class="tp-copybox"
                  :value="turn.bot_text"
                  @click="$event.target.select()"
                ></textarea>
                <q-btn
                  dense
                  flat
                  no-caps
                  size="sm"
                  :label="rowCopyLabels[i] ?? 'Copy'"
                  icon="content_copy"
                  @click="onCopyRow(i, turn.bot_text)"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="tp-text-request">
      <q-input
        v-model="textInput"
        type="textarea"
        autogrow
        dense
        outlined
        dark
        hide-bottom-space
        class="tp-text-input"
        :placeholder="placeholder"
        :input-attrs="{ 'aria-label': placeholder }"
        :disable="session.connectionState !== 'connected'"
        @keydown.enter.exact.prevent="onSendText"
      />
      <button
        type="button"
        class="tp-send"
        :style="sendStyle"
        aria-label="Send message"
        :disabled="!textInput.trim() || session.connectionState !== 'connected'"
        @click="onSendText"
      >
        <q-icon name="send" size="22px" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, watch } from "vue";
import { transcript, formatTranscriptForCopy, personalityDisplayName } from "../composables/useTranscript.js";
import { session, sendTextRequest, pullTodayHistory, historyPull } from "../composables/session.js";
import { pipelineState } from "../composables/pipelineState.js";
import { isDeepThoughtful } from "../composables/effectiveMode.js";
import { modeColors, modeDisplayLabel } from "../composables/colorSettings.js";

const scrollEl = ref(null);
const copyLabel = ref("Copy all");
const textInput = ref("");
// Per-row expand state for the copyable-text toggle — deliberately local UI
// state, not mutated onto the shared transcript turns, so it never leaks
// into formatTranscriptForCopy() or anything persisted/replayed elsewhere.
const copyBoxIndices = ref(new Set());
const rowCopyLabels = reactive({});

function toggleCopyBox(i) {
  if (copyBoxIndices.value.has(i)) {
    copyBoxIndices.value.delete(i);
  } else {
    copyBoxIndices.value.add(i);
  }
}

async function onCopyRow(i, text) {
  try {
    await navigator.clipboard.writeText(text ?? "");
    rowCopyLabels[i] = "Copied!";
  } catch {
    rowCopyLabels[i] = "Copy failed";
  }
  setTimeout(() => {
    delete rowCopyLabels[i];
  }, 1000);
}

function onSendText() {
  const text = textInput.value.trim();
  if (!text || session.connectionState !== "connected") return;
  sendTextRequest(text);
  textInput.value = "";
}

// Full time including seconds — this is a test console, so the gaps between
// lines are useful.
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString();
}

// personalityDisplayName() returns "BOT" (shouty) when there is no slug; the
// row wants a plain "Bot" instead. The copy-all export keeps using the
// original helper so its format doesn't change.
function botName(turn) {
  return turn.personality ? personalityDisplayName(turn.personality) : "Bot";
}

function botInitial(turn) {
  return botName(turn).charAt(0).toUpperCase();
}

function modeLabel(turn) {
  if (turn.is_filler) return "Filler";
  return turn.mode ? modeDisplayLabel(turn.mode) : "";
}

// "Today · 6 messages" — day of the first turn (the store only holds what
// arrived since page load) and a count of lines with text.
const summaryLabel = computed(() => {
  if (transcript.length === 0) return "";
  let n = 0;
  for (const t of transcript) {
    if (t.user_text) n++;
    if (t.bot_text) n++;
  }
  const first = new Date(transcript[0].timestamp);
  const day = first.toDateString() === new Date().toDateString() ? "Today" : first.toLocaleDateString();
  return `${day} · ${n} message${n === 1 ? "" : "s"}`;
});

const placeholder = computed(() => `Message ${botName({ personality: session.activePersonality })} (text only)`);

// Same top-of-view slot the Visualizer tab uses for the bot's name — see
// VisualizerCarousel.vue's .vc-bot-name.
const activeBotName = computed(() => botName({ personality: session.activePersonality }));

// ---- colour coding -------------------------------------------------------
// Every turn is coloured from the Visualizer tab's per-mode palette
// (ColorSettingsDrawer / colorSettings.js), looked up by that turn's own
// mode: "primary" is the bot's colour (avatar, name, mode chip, row tint) and
// "secondary" is the human's (avatar). modeColors() reads the reactive store,
// so editing a swatch in the drawer recolours the existing transcript live.

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function toRgb(hex, fallback) {
  const m = HEX_RE.exec(String(hex ?? "").trim());
  const clean = (m ? m[1] : fallback).replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgba(hex, alpha, fallback) {
  const [r, g, b] = toRgb(hex, fallback);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Mix toward white by t (0..1). Keeps text/name/chip readable on the dark
// background even when the picked swatch is a dark, saturated colour.
function lighten(hex, t, fallback) {
  const [r, g, b] = toRgb(hex, fallback);
  const mix = (v) => Math.round(v + (255 - v) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Filler lines ("one sec…" canned audio) aren't a real reply, so they stay
// neutral rather than borrowing the mode colour.
const NEUTRAL = {
  "--tp-primary": "#8b93a1",
  "--tp-primary-light": "#a9b0bc",
  "--tp-secondary": "#2c3038",
  "--tp-secondary-light": "#c5cad3",
  "--tp-chip-bg": "rgba(139, 147, 161, 0.18)",
  "--tp-border": "rgba(139, 147, 161, 0.35)",
  "--tp-band": "rgba(139, 147, 161, 0.06)",
};

function turnVars(turn) {
  if (turn.is_filler) return NEUTRAL;
  const c = modeColors(turn.mode);
  return {
    "--tp-primary": c.primary,
    "--tp-primary-light": lighten(c.primary, 0.25, "5eb1ff"),
    "--tp-secondary": c.secondary,
    "--tp-secondary-light": lighten(c.secondary, 0.75, "1c3a52"),
    "--tp-chip-bg": rgba(c.primary, 0.18, "5eb1ff"),
    "--tp-border": rgba(c.primary, 0.35, "5eb1ff"),
    "--tp-band": rgba(c.primary, 0.07, "5eb1ff"),
  };
}

// The send button follows whichever mode the next message will be sent in.
const sendStyle = computed(() => ({ background: modeColors(pipelineState.mode).primary }));

async function onPullToday() {
  await pullTodayHistory();
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText(formatTranscriptForCopy());
    copyLabel.value = "Copied!";
  } catch {
    copyLabel.value = "Copy failed";
  }
  setTimeout(() => (copyLabel.value = "Copy all"), 1000);
}

// Follow new turns, and also the moment a "typing…" placeholder resolves
// into its reply (same turn, so the length doesn't change).
watch(
  () => [transcript.length, transcript[transcript.length - 1]?.bot_text],
  async () => {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  },
);
</script>

<style scoped>
.tp-wrap {
  width: 100%;
  max-width: 640px;
  /* dvh, not vh — vh is fixed against the largest possible viewport and
     doesn't shrink when the on-screen keyboard opens or the mobile browser
     chrome changes state, which was leaving this box mis-sized (untappable
     input after switching tabs, send button hidden behind the keyboard).
     dvh tracks the actual visible viewport. */
  height: calc(100dvh - 128px);
  display: flex;
  flex-direction: column;
}

/* ---- header ---- */
.tp-bot-name {
  flex-shrink: 0;
  text-align: center;
  padding-top: 8px;
  font-size: 12px;
  color: var(--bb-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* ---- toolbar ---- */
.tp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0 4px 0 12px;
  flex-shrink: 0;
}
.tp-summary {
  font-size: 12px;
  color: var(--bb-muted);
}
.tp-toolbar-actions {
  display: flex;
  align-items: center;
}
.tp-copyall {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  background: transparent;
  border: 0;
  color: var(--bb-accent);
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.tp-copyall:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---- transcript ---- */
.tp-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  font-size: 15px;
}
.tp-empty {
  color: var(--bb-muted);
  text-align: center;
  margin-top: 24px;
}
.tp-turn {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.tp-row {
  display: flex;
  gap: 12px;
  padding: 10px 16px;
}
/* The bot's rows carry a faint tint of that turn's primary colour. */
.tp-row--bot {
  background: var(--tp-band);
}
/* deep_thoughtful replies get an accent bar so the mode is visible at a glance. */
.tp-turn--deep .tp-row--bot {
  border-left: 3px solid var(--tp-primary);
}
.tp-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tp-body--you {
  align-items: flex-end;
  text-align: right;
}
.tp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
.tp-body--you .tp-meta {
  justify-content: flex-end;
}
.tp-time {
  color: var(--bb-muted);
  font-size: 12px;
  flex-shrink: 0;
}
.tp-name {
  font-size: 14px;
  font-weight: 800;
}
.tp-name--bot {
  color: var(--tp-primary-light);
}
.tp-chip {
  font-size: 12px;
  font-weight: 700;
  color: var(--tp-primary-light);
  background: var(--tp-chip-bg);
  padding: 1px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.tp-text {
  line-height: 1.45;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.tp-avatar {
  width: 36px;
  height: 36px;
  box-sizing: border-box;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 800;
}
.tp-avatar--bot {
  background: var(--tp-primary);
  color: #0b1a2a;
}
.tp-avatar--you {
  background: var(--tp-secondary);
  border: 1px solid var(--tp-border);
  color: var(--tp-secondary-light);
}

/* 44px tap target that doesn't add height to the 20px meta line. */
.tp-icon-btn {
  width: 44px;
  height: 44px;
  margin: -12px -12px -12px auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: transparent;
  border: 0;
  border-radius: 22px;
  color: var(--bb-muted);
  cursor: pointer;
}
.tp-icon-btn:hover {
  color: var(--bb-text, #eee);
}

.tp-copybox-wrap {
  /* Full-width so it drops to its own line under the reply text. */
  width: 100%;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.tp-copybox {
  flex: 1;
  min-height: 60px;
  max-height: 240px;
  resize: vertical;
  font-family: monospace;
  font-size: 12px;
  color: var(--bb-text, #eee);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--bb-border);
  border-radius: 4px;
  padding: 6px 8px;
  /* Selecting-to-copy on mobile is the primary use case (tap-and-hold, or
     the explicit Copy button beside it); this isn't meant to be edited. */
  cursor: text;
}

.tp-typing {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 8px 0;
}
.tp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tp-primary, var(--bb-muted));
  animation: tp-typing-bounce 1.2s infinite ease-in-out;
}
.tp-dot:nth-child(2) { animation-delay: 0.2s; }
.tp-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes tp-typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* ---- composer ---- */
.tp-text-request {
  display: flex;
  /* flex-end, not center: keeps the send button pinned to the bottom row as
     the textarea grows upward with autogrow instead of re-centering on it. */
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
  padding: 10px 4px 0;
  border-top: 1px solid var(--bb-border);
}
.tp-text-input {
  flex: 1 1 0%;
  min-width: 0;
}
.tp-text-input :deep(.q-field__control) {
  /* min-height, not the old fixed height: autogrow needs the control free to
     grow past the single-line size. Quasar's outlined focus border tracks
     the control's actual box via top/bottom anchoring, not a copied height
     value, so it still frames correctly as this grows. */
  min-height: 48px;
  border-radius: 12px;
  background: var(--bb-panel);
  align-items: flex-end;
}
.tp-text-input :deep(.q-field__native) {
  align-self: center;
  /* iOS Safari auto-zooms the page on focus for any input under 16px,
     which is what was shoving the send button off-screen — not a
     keyboard/viewport-height issue. 16px keeps focus from zooming at all. */
  font-size: 16px;
  resize: none;
  line-height: 20px;
  /* Caps autogrow at 15 lines (15 * 20px line-height); past that the
     textarea itself scrolls instead of growing further. */
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tp-send {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 12px;
  color: #0b1a2a;
  cursor: pointer;
}
.tp-send:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
