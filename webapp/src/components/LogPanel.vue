<template>
  <div class="lp-wrap">
    <div class="lp-toolbar">
      <q-btn dense flat :label="copyLabel" icon="content_copy" @click="onCopy" />
    </div>
    <div ref="scrollEl" class="lp-scroll">
      <div v-if="protocolLog.length === 0" class="lp-empty">No events yet.</div>
      <div v-for="(entry, i) in protocolLog" :key="i" class="lp-row" :class="`lp-${entry.dir}`">
        <span class="lp-time">{{ fmtTime(entry.timestamp) }}</span>
        <span class="lp-dir">{{ dirGlyph(entry.dir) }}</span>
        <span class="lp-text">{{ entry.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, watch } from "vue";
import { protocolLog, formatProtocolLogForCopy } from "../composables/useProtocolLog.js";
import { session, DEFAULT_MODE } from "../composables/session.js";

const scrollEl = ref(null);
const copyLabel = ref("Copy");

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString();
}

const GLYPH = { sent: "→", recv: "←", sys: "·", err: "!" };
function dirGlyph(dir) {
  return GLYPH[dir] ?? "·";
}

async function onCopy() {
  try {
    const text = formatProtocolLogForCopy({
      personality: session.activePersonality,
      mode: DEFAULT_MODE,
      connectionState: session.connectionState,
    });
    await navigator.clipboard.writeText(text);
    copyLabel.value = "Copied!";
  } catch {
    copyLabel.value = "Copy failed";
  }
  setTimeout(() => (copyLabel.value = "Copy"), 1000);
}

watch(
  () => protocolLog.length,
  async () => {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  },
);
</script>

<style scoped>
.lp-wrap {
  width: 100%;
  max-width: 640px;
  height: calc(100vh - 128px);
  display: flex;
  flex-direction: column;
}
.lp-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 4px 4px 8px;
}
.lp-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.lp-empty {
  color: var(--bb-muted);
  text-align: center;
  margin-top: 24px;
}
.lp-row {
  display: flex;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.lp-sent { background: rgba(94, 177, 255, 0.06); }
.lp-recv { background: rgba(76, 175, 125, 0.06); }
.lp-err { background: rgba(226, 86, 79, 0.08); }
.lp-time { color: var(--bb-muted); font-size: 11px; flex-shrink: 0; }
.lp-dir { flex-shrink: 0; font-weight: 700; width: 14px; }
</style>
