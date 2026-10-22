<template>
  <div class="chg-wrap">
    <div class="chg-toolbar">
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

    <div v-if="error" class="chg-error">{{ error }}</div>

    <div v-if="data" class="chg-scroll">
      <div v-if="!data.days.length" class="chg-empty">No commits in the last {{ days }} days.</div>
      <div v-for="day in data.days" :key="day.date" class="chg-day">
        <div class="chg-day-head">{{ day.date }} · {{ day.commits.length }} commit{{ day.commits.length === 1 ? "" : "s" }}</div>
        <div v-for="c in day.commits" :key="c.hash" class="chg-commit">
          <span class="chg-hash">{{ c.short }}</span>
          <span class="chg-subject">{{ c.subject }}</span>
          <span class="chg-meta">{{ c.time }}<template v-if="c.night"> · night</template> · {{ c.author }}</span>
        </div>
      </div>
    </div>
    <div v-else-if="!error" class="chg-empty">{{ loading ? "Loading…" : "No data." }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { apiFetch } from "../composables/session.js";

const days = ref(7);
const data = ref(null);
const loading = ref(false);
const error = ref("");

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    const res = await apiFetch("/api/changes", { days: String(days.value) });
    data.value = res;
    if (res.error) error.value = res.error;
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.chg-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.chg-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.chg-error { padding: 8px; color: #ff6b6b; }
.chg-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 24px; }
.chg-day-head { margin: 14px 0 6px; font-size: 11px; opacity: 0.55; }
.chg-commit { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 4px 0; }
.chg-hash { color: #4fc3f7; }
.chg-subject { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.chg-meta { width: 100%; font-size: 10px; opacity: 0.45; }
.chg-empty { padding: 24px 8px; text-align: center; opacity: 0.5; }
</style>
