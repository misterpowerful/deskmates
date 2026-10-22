<template>
  <div class="mem-wrap">
    <div class="mem-toolbar">
      <div class="mem-title">Memory{{ session.activePersonality ? ` · ${session.activePersonality}` : "" }}</div>
      <q-btn dense flat icon="refresh" :loading="loading" @click="reload" />
    </div>

    <div v-if="error" class="mem-error">{{ error }}</div>

    <!-- A bad auto-approved insight or an unwanted saved fact can be
         deleted straight from here (confirm, then DELETE via
         /api/memory/insight or /api/memory/fact) — no more need to SSH in
         and run `npm run reject-insight` / `npm run reject-memory-fact` by
         hand, though those CLI scripts still work the same way. -->
    <div v-if="data" class="mem-scroll">
      <div class="mem-section">
        <div class="mem-section-head">
          Insights ({{ data.insights.length }})
        </div>
        <div v-if="!data.insights.length" class="mem-empty">No insights yet.</div>
        <div v-for="insight in data.insights" :key="`i${insight.index}`" class="mem-entry">
          <div class="mem-entry-text">{{ insight.insight }}</div>
          <div class="mem-entry-meta">
            <span v-if="insight.status" class="mem-status">{{ insight.status }}</span>
            <span v-if="insight.createdAt">{{ insight.createdAt }}</span>
            <span v-for="tag in insight.sourceTags" :key="tag" class="mem-tag">{{ tag }}</span>
            <q-btn
              class="mem-delete"
              flat
              dense
              round
              size="sm"
              icon="delete_outline"
              :aria-label="`Delete insight: ${insight.insight}`"
              :loading="deleting === insightKey(insight)"
              @click="deleteInsight(insight)"
            />
          </div>
        </div>
      </div>

      <div class="mem-section">
        <div class="mem-section-head">
          Facts ({{ data.facts.length }})
        </div>
        <div v-if="!data.facts.length" class="mem-empty">No saved facts yet.</div>
        <div v-for="fact in data.facts" :key="`f${fact.index}`" class="mem-entry">
          <div class="mem-entry-text">{{ fact.fact }}</div>
          <div class="mem-entry-meta">
            <span v-if="fact.savedAt">{{ fact.savedAt }}</span>
            <span v-for="tag in fact.tags" :key="tag" class="mem-tag">{{ tag }}</span>
            <q-btn
              class="mem-delete"
              flat
              dense
              round
              size="sm"
              icon="delete_outline"
              :aria-label="`Delete fact: ${fact.fact}`"
              :loading="deleting === factKey(fact)"
              @click="deleteFact(fact)"
            />
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="!error" class="mem-empty">{{ loading ? "Loading…" : "No data." }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from "vue";
import { session, apiFetch, apiPost } from "../composables/session.js";

const data = ref(null);
const loading = ref(false);
const error = ref("");
// Tracks which entry's delete is in flight (a string key, not just an
// index) so the spinner on one row can't light up a different row — facts
// and insights both index from 0.
const deleting = ref(null);

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    const params = session.activePersonality ? { personality: session.activePersonality } : {};
    const res = await apiFetch("/api/memory", params);
    data.value = res;
    if (res.error) error.value = res.error;
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

const factKey = (fact) => `f${fact.index}`;
const insightKey = (insight) => `i${insight.index}`;

// Deletion is irreversible (see src/longTermMemory.js's removeMemoryFact/
// removeInsight) so both paths confirm first, same as QueueDrawer.vue's
// delete action. `index` is the on-disk index the snapshot carries per
// entry (see longTermMemory.js), not its position in this sorted list.
async function deleteFact(fact) {
  if (!window.confirm(`Delete this memory fact?\n\n"${fact.fact}"`)) return;
  deleting.value = factKey(fact);
  error.value = "";
  try {
    await apiPost("/api/memory/fact", { personality: session.activePersonality, index: fact.index });
    await reload();
  } catch (err) {
    error.value = `Delete failed: ${err.message}`;
  } finally {
    deleting.value = null;
  }
}

async function deleteInsight(insight) {
  if (!window.confirm(`Delete this insight?\n\n"${insight.insight}"`)) return;
  deleting.value = insightKey(insight);
  error.value = "";
  try {
    await apiPost("/api/memory/insight", { personality: session.activePersonality, index: insight.index });
    await reload();
  } catch (err) {
    error.value = `Delete failed: ${err.message}`;
  } finally {
    deleting.value = null;
  }
}

onMounted(reload);
watch(() => session.activePersonality, reload);
</script>

<style scoped>
.mem-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
}
.mem-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.mem-title { font-weight: 600; opacity: 0.85; }
.mem-error { padding: 8px; color: #ff6b6b; }
.mem-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 24px; }
.mem-section { margin: 0 0 20px; }
.mem-section-head { margin: 0 0 8px; font-size: 11px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.04em; }
.mem-entry { padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.mem-entry-text { overflow-wrap: anywhere; }
.mem-entry-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  font-size: 10px;
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.mem-status { text-transform: uppercase; }
.mem-tag {
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
}
.mem-delete {
  margin-left: auto;
  opacity: 0.6;
}
.mem-empty { padding: 24px 8px; text-align: center; opacity: 0.5; }
</style>
