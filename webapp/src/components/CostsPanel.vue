<template>
  <div class="costs-wrap">
    <div class="costs-toolbar">
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

    <div v-if="error" class="costs-error">{{ error }}</div>

    <div class="costs-scroll">
      <div class="costs-totals">
        <div class="costs-stat">
          <div class="costs-stat-value">${{ total.toFixed(2) }}</div>
          <div class="costs-stat-label">last {{ days }} days</div>
        </div>
        <div class="costs-stat">
          <div class="costs-stat-value">${{ projected.toFixed(2) }}</div>
          <div class="costs-stat-label">projected 30d</div>
        </div>
        <div class="costs-stat">
          <div class="costs-stat-value">{{ totalTurns }}</div>
          <div class="costs-stat-label">turns</div>
        </div>
        <div class="costs-stat">
          <div class="costs-stat-value">${{ perTurn.toFixed(4) }}</div>
          <div class="costs-stat-label">per turn</div>
        </div>
      </div>

      <!-- Inline SVG rather than a charting library: this is one stacked bar
           chart, and the webapp currently ships zero chart dependencies. -->
      <div class="costs-chart-box">
        <svg
          v-if="data.days.length"
          class="costs-chart"
          :viewBox="`0 0 ${VW} ${VH}`"
          preserveAspectRatio="none"
          role="img"
          aria-label="Daily API cost by model"
        >
          <line
            v-for="tick in yTicks"
            :key="tick.v"
            class="costs-grid"
            :x1="0" :x2="VW"
            :y1="tick.y" :y2="tick.y"
          />
          <g v-for="(d, i) in data.days" :key="d.day">
            <rect
              v-for="seg in stack(d)"
              :key="seg.model"
              :x="x(i)"
              :y="seg.y"
              :width="barW"
              :height="seg.h"
              :fill="colorFor(seg.model)"
            >
              <title>{{ d.day }} · {{ seg.model }} · ${{ seg.cost.toFixed(4) }}</title>
            </rect>
          </g>
        </svg>
        <div v-else-if="!loading" class="costs-empty">No cost data yet.</div>

        <div class="costs-yaxis" v-if="data.days.length">
          <span v-for="tick in yTicks" :key="tick.v" :style="{ top: `${(tick.y / VH) * 100}%` }">
            ${{ tick.v.toFixed(tick.v < 1 ? 3 : 2) }}
          </span>
        </div>
      </div>

      <div class="costs-xaxis" v-if="data.days.length">
        <span>{{ shortDay(data.days[0].day) }}</span>
        <span>{{ shortDay(data.days[data.days.length - 1].day) }}</span>
      </div>

      <div class="costs-legend">
        <div v-for="m in data.models" :key="m" class="costs-legend-item">
          <span class="costs-swatch" :style="{ background: colorFor(m) }"></span>
          <span class="costs-legend-label">{{ m }}</span>
          <span class="costs-legend-value">${{ modelTotal(m).toFixed(4) }}</span>
        </div>
      </div>

      <div class="costs-note">
        Estimated from logged token counts and a local price table — the
        Anthropic console remains the source of truth.
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { apiFetch } from "../composables/session.js";

const VW = 300;
const VH = 120;

const days = ref(14);
const data = ref({ days: [], models: [] });
const loading = ref(false);
const error = ref("");

// Stable per-model colours so a model keeps the same colour across reloads
// and between the chart and the legend.
const MODEL_COLORS = {
  "claude-haiku-4-5-20251001": "#4fc3f7",
  "claude-sonnet-5": "#b07cff",
};
const FALLBACK = ["#ffb347", "#7ddf9a", "#ff8a65", "#e0e0e0"];
function colorFor(model) {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model];
  const idx = data.value.models.indexOf(model);
  return FALLBACK[Math.max(0, idx) % FALLBACK.length];
}

const total = computed(() => data.value.days.reduce((a, d) => a + d.total, 0));
const totalTurns = computed(() => data.value.days.reduce((a, d) => a + d.turns, 0));
const projected = computed(() => (days.value ? (total.value / days.value) * 30 : 0));
const perTurn = computed(() => (totalTurns.value ? total.value / totalTurns.value : 0));

// Never zero: a flat-zero max would divide by zero and collapse every bar.
const maxDay = computed(() => Math.max(...data.value.days.map((d) => d.total), 0.0001));

const barW = computed(() => Math.max(2, (VW / Math.max(1, data.value.days.length)) * 0.72));
function x(i) {
  const slot = VW / Math.max(1, data.value.days.length);
  return i * slot + (slot - barW.value) / 2;
}

const yTicks = computed(() => {
  const m = maxDay.value;
  return [0, m / 2, m].map((v) => ({ v, y: VH - (v / m) * VH }));
});

// Stacks a day's per-model costs from the bottom up.
function stack(day) {
  let acc = 0;
  return Object.entries(day.byModel).map(([model, info]) => {
    const h = (info.cost / maxDay.value) * VH;
    const y = VH - acc - h;
    acc += h;
    return { model, cost: info.cost, y, h: Math.max(h, info.cost > 0 ? 1 : 0) };
  });
}

function modelTotal(model) {
  return data.value.days.reduce((a, d) => a + (d.byModel[model]?.cost ?? 0), 0);
}

function shortDay(day) {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await apiFetch("/api/turns/daily", { days: String(days.value) });
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.costs-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.costs-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.costs-error { padding: 8px; color: #ff6b6b; }
.costs-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 8px 24px; }
.costs-totals {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}
.costs-stat {
  padding: 8px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  text-align: center;
}
.costs-stat-value { font-size: 15px; }
.costs-stat-label {
  font-size: 10px;
  opacity: 0.5;
  margin-top: 2px;
}
.costs-chart-box { position: relative; padding-left: 44px; }
.costs-chart { width: 100%; height: 140px; display: block; }
.costs-grid { stroke: rgba(255, 255, 255, 0.1); stroke-width: 1; vector-effect: non-scaling-stroke; }
.costs-yaxis { position: absolute; left: 0; top: 0; height: 140px; width: 42px; }
.costs-yaxis span {
  position: absolute;
  right: 4px;
  transform: translateY(-50%);
  font-size: 10px;
  opacity: 0.5;
}
.costs-xaxis {
  display: flex;
  justify-content: space-between;
  padding: 4px 0 0 44px;
  font-size: 10px;
  opacity: 0.5;
}
.costs-empty { padding: 32px 0; text-align: center; opacity: 0.5; }
.costs-legend { margin-top: 16px; }
.costs-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.costs-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.costs-legend-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.costs-legend-value { margin-left: auto; opacity: 0.7; }
.costs-note { margin-top: 16px; font-size: 10px; opacity: 0.45; line-height: 1.5; }
@media (max-width: 400px) {
  .costs-totals { grid-template-columns: repeat(2, 1fr); }
}
</style>
