<template>
  <div class="turns-wrap">
    <div class="turns-toolbar">
      <q-select
        v-model="modeFilter"
        dense
        outlined
        options-dense
        emit-value
        map-options
        class="turns-filter"
        :options="modeOptions"
        label="Mode"
        @update:model-value="reload"
      />
      <q-btn dense flat icon="refresh" :loading="loading" @click="reload" />
      <div class="turns-summary" v-if="total">
        {{ total }} turns · ${{ fmtCost(pageCost) }} shown
      </div>
    </div>

    <div v-if="error" class="turns-error">{{ error }}</div>

    <div class="turns-scroll">
      <div v-if="!loading && turns.length === 0" class="turns-empty">
        No turns logged yet.
      </div>

      <div
        v-for="turn in turns"
        :key="turn.id"
        class="turns-row"
        :class="`turns-mode-${turn.effective_mode}`"
      >
        <div class="turns-head" @click="toggle(turn.id)">
          <span class="turns-time">{{ fmtTime(turn.ts) }}</span>
          <span class="turns-badge">{{ turn.effective_mode }}</span>
          <!-- The reason a turn ran on the expensive model is the single most
               useful thing on this screen, so it sits in the collapsed row
               rather than behind the expander. sticky_carryover in particular
               means nobody asked for deep_thoughtful on this turn — it was
               inherited from an earlier trigger. -->
          <span
            v-if="turn.deep_reason"
            class="turns-reason"
            :class="{ 'turns-reason-warn': turn.deep_reason === 'sticky_carryover' }"
          >{{ turn.deep_reason }}</span>
          <span v-if="turn.tool_calls.length" class="turns-tools">
            {{ turn.tool_calls.length }} tool{{ turn.tool_calls.length === 1 ? "" : "s" }}
          </span>
          <span v-if="!turn.ok" class="turns-failed">failed</span>
          <span class="turns-cost">${{ fmtCost(turn.cost) }}</span>
          <q-icon :name="open.has(turn.id) ? 'expand_less' : 'expand_more'" size="18px" />
        </div>

        <div class="turns-preview">{{ turn.transcript || "(no transcript)" }}</div>

        <div v-if="open.has(turn.id)" class="turns-detail">
          <div class="turns-block">
            <div class="turns-block-label">You</div>
            <div class="turns-block-text">{{ turn.transcript || "—" }}</div>
          </div>
          <div class="turns-block">
            <div class="turns-block-label">Bot</div>
            <div class="turns-block-text">{{ turn.reply || "—" }}</div>
          </div>
          <div v-if="turn.error" class="turns-block">
            <div class="turns-block-label">Error</div>
            <div class="turns-block-text turns-block-error">{{ turn.error }}</div>
          </div>

          <div class="turns-meta">
            <div><span>model</span>{{ turn.model || "—" }}</div>
            <div><span>provider</span>{{ turn.provider || "—" }}{{ turn.unmetered ? " (subscription)" : "" }}</div>
            <div><span>requested</span>{{ turn.requested_mode || "—" }}</div>
            <div><span>personality</span>{{ turn.personality || "—" }}</div>
            <div><span>channel</span>{{ turn.channel || "—" }}</div>
            <div><span>in / out</span>{{ turn.input_tokens ?? "—" }} / {{ turn.output_tokens ?? "—" }}</div>
            <div><span>llm rounds</span>{{ turn.llm_rounds ?? "—" }}</div>
            <div v-if="turn.web_searches"><span>web searches</span>{{ turn.web_searches }}</div>
            <div v-if="turn.tool_calls.length"><span>tools</span>{{ turn.tool_calls.join(", ") }}</div>
            <div><span>stt / llm / tts</span>{{ turn.ms_stt ?? "—" }} / {{ turn.ms_llm ?? "—" }} / {{ turn.ms_tts ?? "—" }} ms</div>
            <div><span>total</span>{{ turn.ms_total ?? "—" }} ms</div>
            <div v-if="turn.session_id"><span>session</span>{{ turn.session_id }}</div>
          </div>
        </div>
      </div>

      <div v-if="turns.length < total" class="turns-more">
        <q-btn dense flat :loading="loading" label="Load more" @click="loadMore" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { session, apiFetch } from "../composables/session.js";

const PAGE = 50;

const turns = ref([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");
const open = ref(new Set());
const modeFilter = ref(null);

const modeOptions = [
  { label: "All modes", value: null },
  { label: "friendly", value: "friendly" },
  { label: "deep_thoughtful", value: "deep_thoughtful" },
  { label: "sentry_intruder", value: "sentry_intruder" },
  { label: "bump_complaint", value: "bump_complaint" },
];

const pageCost = computed(() => turns.value.reduce((a, t) => a + (t.cost ?? 0), 0));

function toggle(id) {
  const next = new Set(open.value);
  next.has(id) ? next.delete(id) : next.add(id);
  open.value = next;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// Turn costs are fractions of a cent; two decimals would render every row as
// $0.00 and make the column useless.
function fmtCost(n) {
  return Number(n ?? 0).toFixed(4);
}

async function fetchPage(offset) {
  const params = { limit: String(PAGE), offset: String(offset) };
  if (modeFilter.value) params.mode = modeFilter.value;
  return apiFetch("/api/turns", params);
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    const data = await fetchPage(0);
    turns.value = data.turns;
    total.value = data.total;
    open.value = new Set();
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  loading.value = true;
  try {
    const data = await fetchPage(turns.value.length);
    turns.value = [...turns.value, ...data.turns];
    total.value = data.total;
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.turns-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.turns-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.turns-filter { min-width: 150px; }
.turns-summary { margin-left: auto; opacity: 0.6; }
.turns-error {
  padding: 8px;
  color: #ff6b6b;
}
.turns-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 24px;
}
.turns-empty {
  padding: 24px 8px;
  text-align: center;
  opacity: 0.5;
}
.turns-row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  border-left: 3px solid transparent;
  padding: 6px 8px;
}
.turns-mode-deep_thoughtful { border-left-color: #b07cff; }
.turns-mode-friendly { border-left-color: #4fc3f7; }
.turns-mode-sentry_intruder { border-left-color: #ff8a65; }
.turns-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 4px;
  gap: 8px;
  cursor: pointer;
}
.turns-time { opacity: 0.55; white-space: nowrap; }
.turns-badge { opacity: 0.85; }
.turns-reason {
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(176, 124, 255, 0.18);
  font-size: 11px;
}
.turns-reason-warn {
  background: rgba(255, 179, 71, 0.22);
  color: #ffc26b;
}
.turns-tools { opacity: 0.6; font-size: 11px; }
.turns-failed { color: #ff6b6b; font-size: 11px; }
.turns-cost { margin-left: auto; opacity: 0.8; white-space: nowrap; }
.turns-preview {
  margin-top: 2px;
  opacity: 0.7;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.turns-detail {
  margin-top: 8px;
  padding: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
}
.turns-block { margin-bottom: 8px; }
.turns-block-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.5;
  margin-bottom: 2px;
}
.turns-block-text { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.turns-block-error { color: #ff6b6b; }
.turns-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 12px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 11px;
}
.turns-meta div { display: flex; justify-content: space-between; gap: 8px; overflow-wrap: anywhere; min-width: 0; }
.turns-meta span { opacity: 0.5; flex-shrink: 0; }
.turns-more { padding: 12px; text-align: center; }
@media (max-width: 480px) {
  .turns-meta { grid-template-columns: 1fr; }
}
</style>
