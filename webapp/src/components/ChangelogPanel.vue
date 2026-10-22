<template>
  <div class="clg-wrap">
    <div class="clg-toolbar">
      <div class="clg-title">Latest Changes</div>
      <q-btn dense flat icon="refresh" :loading="loading" @click="reload" />
    </div>

    <div v-if="error" class="clg-error">{{ error }}</div>

    <!-- entries are already newest-first (src/changelog.js sorts them);
         text interpolation only, never v-html, so nothing in the markdown
         file can inject markup into the page. -->
    <div v-if="entries" class="clg-scroll">
      <div v-if="!entries.length" class="clg-empty">No changelog entries yet.</div>
      <div v-for="(entry, i) in entries" :key="i" class="clg-entry">
        <div class="clg-entry-head">
          <span v-if="entry.date" class="clg-date">{{ entry.date }}</span>
          <span class="clg-entry-title">{{ entry.title }}</span>
        </div>
        <ul v-if="entry.items.length" class="clg-items">
          <li v-for="(item, j) in entry.items" :key="j">{{ item }}</li>
        </ul>
      </div>
    </div>
    <div v-else-if="!error" class="clg-empty">{{ loading ? "Loading…" : "No data." }}</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { apiFetch } from "../composables/session.js";

const entries = ref(null);
const loading = ref(false);
const error = ref("");

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    const res = await apiFetch("/api/changelog");
    entries.value = res.entries ?? [];
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
.clg-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
}
.clg-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.clg-title { font-weight: 600; opacity: 0.85; }
.clg-error { padding: 8px; color: #ff6b6b; }
.clg-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 24px; }
.clg-entry { margin: 0 0 18px; }
.clg-entry-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.clg-date { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: 0.55; }
.clg-entry-title { font-weight: 600; }
.clg-items { margin: 6px 0 0; padding-left: 18px; }
.clg-items li { margin: 2px 0; overflow-wrap: anywhere; }
.clg-empty { padding: 24px 8px; text-align: center; opacity: 0.5; }
</style>
