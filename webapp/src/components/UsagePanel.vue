<template>
  <div class="usage-wrap">
    <div class="usage-toolbar">
      <q-btn-toggle
        v-model="days"
        dense
        unelevated
        no-caps
        size="sm"
        toggle-color="primary"
        :options="[
          { label: '7d', value: 7 },
          { label: '14d', value: 14 },
          { label: '30d', value: 30 },
        ]"
        @update:model-value="reload"
      />
      <q-btn dense flat icon="refresh" :loading="loading" @click="reload" />
    </div>

    <div v-if="error" class="usage-error">{{ error }}</div>

    <div v-if="data" class="usage-scroll">
      <div class="usage-cards">
        <div class="usage-card">
          <div class="usage-card-value">${{ data.billed_usd.toFixed(2) }}</div>
          <div class="usage-card-label">billed (Haiku API)</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-value">{{ fmt(subscriptionTokens) }}</div>
          <div class="usage-card-label">subscription tokens</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-value">{{ pct(plan.seven_day?.used_pct) }}</div>
          <div class="usage-card-label">weekly limit used</div>
        </div>
        <div class="usage-card">
          <div class="usage-card-value usage-bb-text">{{ pct(plan.seven_day?.deskmates_pct) }}</div>
          <div class="usage-card-label">Deskmates' part</div>
        </div>
      </div>

      <div class="usage-section">Plan usage now</div>
      <template v-if="hasPlan">
        <div v-for="w in windows" :key="w.key" class="usage-meter-block">
          <div v-if="plan[w.key]" class="usage-meter-head">
            <span>{{ w.label }}</span>
            <span class="usage-dim">
              {{ pct(plan[w.key].used_pct) }} used<template v-if="plan[w.key].resets_at"> · resets {{ resetText(plan[w.key].resets_at) }}</template>
            </span>
          </div>
          <div v-if="plan[w.key]" class="usage-meter" role="img" :aria-label="`${w.label}: ${pct(plan[w.key].deskmates_pct)} Deskmates, ${pct(plan[w.key].other_pct)} everything else`">
            <div class="usage-seg usage-bb" :style="{ width: segWidth(plan[w.key].deskmates_pct) }"></div>
            <div class="usage-seg usage-other" :style="{ width: segWidth(plan[w.key].other_pct) }"></div>
          </div>
        </div>
        <div class="usage-legend">
          <span><i class="usage-swatch usage-bb"></i>Deskmates</span>
          <span><i class="usage-swatch usage-other"></i>Everything else</span>
        </div>
        <div class="usage-note">
          Deskmates' part counts deep thought turns only — each call's own
          movement of the meter, so it is a floor. Overnight jobs are not
          included. "Everything else" includes Claude chat and desktop.
          <template v-if="plan.seven_day">
            Weekly window: {{ plan.seven_day.calls }} calls,
            {{ plan.seven_day.calls_that_moved_meter }} moved the meter.
          </template>
        </div>
      </template>
      <div v-else class="usage-empty">
        No plan usage reported yet. It appears after the first deep thought
        turn that runs through Claude Code.
      </div>

      <div class="usage-section">Deskmates tokens · {{ fmt(data.tokens.total) }}</div>
      <div class="usage-meter" role="img" aria-label="Deskmates tokens by path">
        <div
          v-for="row in pathRows"
          :key="row.key"
          class="usage-seg"
          :style="{ width: segWidthOf(row.total, data.tokens.total), background: row.color }"
          :title="`${row.label} · ${fmt(row.total)}`"
        ></div>
      </div>

      <div v-for="row in pathRows" :key="row.key" class="usage-path">
        <div class="usage-path-head">
          <span><i class="usage-swatch" :style="{ background: row.color }"></i>{{ row.label }}</span>
          <span class="usage-dim">{{ row.cost }}</span>
        </div>
        <div class="usage-path-sub usage-dim">
          {{ row.count }} {{ row.countLabel }} · {{ fmt(row.total) }} tokens
        </div>
      </div>

      <div class="usage-section">By token type</div>
      <div v-for="t in tokenTypes" :key="t.key" class="usage-row">
        <span class="usage-dim">{{ t.label }}</span>
        <span>{{ fmt(data.tokens[t.key]) }}</span>
      </div>

      <div class="usage-note">
        Billed is estimated from logged tokens and a local price table
        (cache reads at 0.1x, cache writes at 1.25x input) — the Anthropic
        console remains the source of truth. ≈ figures are API-equivalent
        cost of subscription usage, not money spent.
      </div>
    </div>
    <div v-else-if="!error" class="usage-empty">{{ loading ? "Loading…" : "No data." }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { apiFetch } from "../composables/session.js";

const days = ref(7);
const data = ref(null);
const loading = ref(false);
const error = ref("");

const windows = [
  { key: "five_hour", label: "5-hour session" },
  { key: "seven_day", label: "Weekly" },
];
const tokenTypes = [
  { key: "input", label: "input" },
  { key: "cache_read", label: "cache read" },
  { key: "cache_write", label: "cache write" },
  { key: "output", label: "output" },
];

const plan = computed(() => data.value?.plan ?? {});
const hasPlan = computed(() => Boolean(plan.value.five_hour || plan.value.seven_day));
const subscriptionTokens = computed(
  () => (data.value?.paths.deep_thought.total_tokens ?? 0) + (data.value?.paths.overnight.total_tokens ?? 0),
);

const usd = (n) => `$${n.toFixed(2)}`;
const pathRows = computed(() => {
  const p = data.value?.paths;
  if (!p) return [];
  return [
    {
      key: "api",
      label: "Chat & voice (Haiku API)",
      color: "#4fc3f7",
      count: p.api.turns,
      countLabel: "turns",
      total: p.api.total_tokens,
      cost: `${usd(p.api.billed_usd)} billed`,
    },
    {
      key: "deep_thought",
      label: "Deep thought (Claude Code)",
      color: "#b07cff",
      count: p.deep_thought.turns,
      countLabel: "turns",
      total: p.deep_thought.total_tokens,
      cost: `≈${usd(p.deep_thought.equivalent_usd)}`,
    },
    {
      key: "overnight",
      label: "Overnight jobs (Claude Code)",
      color: "#ffb347",
      count: p.overnight.runs,
      countLabel: "runs",
      total: p.overnight.total_tokens,
      cost: `≈${usd(p.overnight.equivalent_usd)}`,
    },
  ];
});

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
function pct(n) {
  if (n == null) return "—";
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}
// A segment with any usage stays visible even when it is a sliver.
function segWidth(p) {
  return p > 0 ? `${Math.max(p, 0.8)}%` : "0";
}
function segWidthOf(part, total) {
  return part > 0 && total > 0 ? `${Math.max((part / total) * 100, 0.8)}%` : "0";
}
function resetText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "soon";
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `in ${Math.round(h / 24)}d`;
  if (h >= 1) return `in ${h}h`;
  return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await apiFetch("/api/usage", { days: String(days.value) });
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.usage-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.usage-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.usage-error { padding: 8px; color: #ff6b6b; }
.usage-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 8px 24px; }
.usage-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.usage-card {
  padding: 8px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  text-align: center;
}
.usage-card-value { font-size: 15px; }
.usage-card-label { font-size: 10px; opacity: 0.5; margin-top: 2px; }
.usage-section { margin: 18px 0 8px; font-size: 11px; opacity: 0.55; }
.usage-meter-block { margin-bottom: 10px; }
.usage-meter-head { display: flex; justify-content: space-between; margin-bottom: 4px; }
.usage-meter {
  display: flex;
  gap: 2px;
  height: 14px;
  padding: 1px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.usage-seg { height: 100%; border-radius: 3px; }
.usage-bb { background: #4fc3f7; }
.usage-other { background: #8a8a8a; }
.usage-bb-text { color: #4fc3f7; }
.usage-legend { display: flex; gap: 14px; margin-top: 6px; font-size: 10px; opacity: 0.7; }
.usage-swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: -1px;
}
.usage-path { margin-top: 10px; }
.usage-path-head { display: flex; justify-content: space-between; }
.usage-path-sub { margin: 2px 0 0 15px; font-size: 10px; }
.usage-row { display: flex; justify-content: space-between; padding: 3px 0; }
.usage-dim { opacity: 0.6; }
.usage-empty { padding: 24px 8px; text-align: center; opacity: 0.5; line-height: 1.5; }
.usage-note { margin-top: 12px; font-size: 10px; opacity: 0.45; line-height: 1.5; }
@media (max-width: 400px) {
  .usage-cards { grid-template-columns: repeat(2, 1fr); }
}
</style>
