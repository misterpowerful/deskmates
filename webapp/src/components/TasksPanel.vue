<template>
  <div class="tk-wrap">
    <div class="tk-toolbar">
      <div class="tk-title">Tasks</div>
      <div class="tk-actions">
        <q-btn dense flat icon="add_a_photo" aria-label="Add a photo for Gatsby to look at" @click="pickPhoto" />
        <q-btn dense flat icon="refresh" aria-label="Refresh" :loading="loading" @click="load" />
      </div>
      <input ref="fileEl" class="tk-file" type="file" accept="image/*" @change="onFileChosen" />
    </div>

    <div v-if="error" class="tk-error">{{ error }}</div>

    <div class="tk-scroll">
      <!-- A chosen photo waits here for an optional "what should I look for?"
           before it's sent, rather than uploading the instant it's picked. -->
      <div v-if="draft" class="tk-card tk-draft">
        <img class="tk-thumb tk-thumb--draft" :src="draft.previewUrl" alt="Photo to send" />
        <div class="tk-draft-form">
          <q-input
            v-model="draft.note"
            dense
            dark
            filled
            maxlength="500"
            label="What should I look for? (optional)"
            :disable="uploading"
            @keyup.enter="sendDraft"
          />
          <div class="tk-row">
            <q-btn flat dense label="Cancel" :disable="uploading" @click="clearDraft" />
            <q-btn dense color="primary" icon="send" label="Send" :loading="uploading" @click="sendDraft" />
          </div>
        </div>
      </div>

      <div v-if="!loading && !tasks.length && !error" class="tk-empty">
        No tasks yet. Ask Gatsby to delegate something, or add a photo.
      </div>

      <template v-for="section in sections" :key="section.key">
        <div v-if="section.items.length" class="tk-section">
          <div class="tk-section-head">{{ section.label }} ({{ section.items.length }})</div>
          <div
            v-for="task in section.items"
            :key="task.id"
            class="tk-card"
            :class="{ 'tk-card--muted': section.key === 'earlier' }"
          >
            <div class="tk-card-main" role="button" tabindex="0" @click="toggle(task)" @keyup.enter="toggle(task)">
              <img v-if="task.hasImage" class="tk-thumb" :src="imageUrl(task)" alt="" loading="lazy" />
              <div class="tk-card-body">
                <div class="tk-card-title">{{ task.title }}</div>
                <div class="tk-card-meta">
                  <span class="tk-chip" :class="`tk-chip--${task.status}`">
                    <q-spinner v-if="task.status === 'running'" size="10px" class="tk-spin" />
                    {{ statusLabel(task.status) }}
                  </span>
                  <span>{{ formatAge(task.completed || task.created, now) }}</span>
                  <span v-if="task.heard">heard</span>
                  <span v-else-if="task.viewedAt">read</span>
                </div>
                <div v-if="task.summary" class="tk-summary">{{ task.summary }}</div>
              </div>
            </div>

            <div v-if="openId === task.id" class="tk-detail">
              <img v-if="task.hasImage" class="tk-image" :src="imageUrl(task)" alt="Task photo" />
              <div v-if="detailLoading" class="tk-empty">Loading…</div>
              <div v-else-if="detail && detail.result" class="tk-result">{{ detail.result }}</div>
              <div v-else-if="task.status === 'running'" class="tk-empty">Still working on it…</div>
              <div class="tk-row">
                <q-btn
                  v-if="task.status !== 'running' && task.status !== 'failed'"
                  dense
                  flat
                  icon="record_voice_over"
                  label="Read to me"
                  :disable="session.connectionState !== 'connected'"
                  @click="readAloud(task)"
                />
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useQuasar } from "quasar";
import { session, apiFetch, apiPost, sendTextRequest } from "../composables/session.js";
import {
  groupTasks,
  needsPolling,
  statusLabel,
  formatAge,
  readAloudPrompt,
  taskImageUrl,
  fitWithin,
} from "../composables/taskView.js";

const emit = defineEmits(["show-transcript"]);
const $q = useQuasar();

const tasks = ref([]);
const loading = ref(false);
const error = ref("");
const now = ref(Date.now());
const openId = ref("");
const detail = ref(null);
const detailLoading = ref(false);

const fileEl = ref(null);
const draft = ref(null); // { blob, previewUrl, note }
const uploading = ref(false);

const sections = computed(() => {
  const g = groupTasks(tasks.value);
  return [
    { key: "needsSignOff", label: "Needs your sign-off", items: g.needsSignOff },
    { key: "inFlight", label: "In progress", items: g.inFlight },
    { key: "ready", label: "Ready", items: g.ready },
    { key: "failed", label: "Failed", items: g.failed },
    { key: "earlier", label: "Earlier", items: g.earlier },
  ];
});

const imageUrl = (task) => taskImageUrl(task.id, session.token);

async function load() {
  loading.value = true;
  try {
    const data = await apiFetch("/api/tasks");
    tasks.value = Array.isArray(data.tasks) ? data.tasks : [];
    error.value = "";
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
    now.value = Date.now();
  }
}

// Fast while something is running, slow otherwise — a task the bot creates by
// voice while this tab is open still shows up without a manual refresh. The
// panel is v-if mounted, so this only runs while the Tasks tab is open.
let timer = null;
function schedulePoll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await load();
    schedulePoll();
  }, needsPolling(tasks.value) ? 4000 : 15000);
}

async function toggle(task) {
  if (openId.value === task.id) {
    openId.value = "";
    return;
  }
  openId.value = task.id;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await apiFetch(`/api/tasks/${task.id}`);
    // Opening a finished task counts as a human reading it; a still-running
    // one hasn't produced anything to read yet.
    if (task.status !== "running" && !task.viewedAt) {
      const updated = await apiPost(`/api/tasks/${task.id}/viewed`, {});
      const row = tasks.value.find((t) => t.id === task.id);
      if (row) row.viewedAt = updated.viewedAt;
    }
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    detailLoading.value = false;
  }
}

function readAloud(task) {
  sendTextRequest(readAloudPrompt(task));
  $q.notify({ message: "Asking Gatsby to read it out…", type: "info", position: "top", timeout: 1500 });
  emit("show-transcript");
}

// ---- photo upload ---------------------------------------------------------

function pickPhoto() {
  fileEl.value?.click();
}

// Phone photos are 3-10 MB; the worker doesn't need that much, and a smaller
// image uploads faster and costs fewer tokens. Downscale to a 1568px long edge
// JPEG client-side. Anything the browser can't decode falls back to the
// original file (the server re-validates type and size either way).
async function downscale(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = fitWithin(bitmap.width, bitmap.height);
    if (!size) return file;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = ""; // so picking the same photo twice still fires change
  if (!file) return;
  clearDraft();
  const blob = await downscale(file);
  draft.value = { blob, previewUrl: URL.createObjectURL(blob), note: "" };
}

function clearDraft() {
  if (draft.value?.previewUrl) URL.revokeObjectURL(draft.value.previewUrl);
  draft.value = null;
}

async function sendDraft() {
  if (!draft.value || uploading.value) return;
  uploading.value = true;
  try {
    const query = new URLSearchParams({ token: session.token, title: "Photo", note: draft.value.note });
    const res = await fetch(`/api/tasks/vision?${query}`, {
      method: "POST",
      headers: { "Content-Type": draft.value.blob.type || "application/octet-stream" },
      body: draft.value.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
    clearDraft();
    error.value = "";
    await load();
    schedulePoll();
  } catch (err) {
    error.value = err?.message ?? String(err);
  } finally {
    uploading.value = false;
  }
}

onMounted(async () => {
  await load();
  schedulePoll();
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  clearDraft();
});
</script>

<style scoped>
.tk-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 13px; }
.tk-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.tk-title { font-weight: 600; opacity: 0.85; }
.tk-file { display: none; }
.tk-error { padding: 8px; color: #ff6b6b; }
.tk-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 8px 24px; }
.tk-empty { padding: 12px 4px; opacity: 0.55; }
.tk-section { margin: 0 0 18px; }
.tk-section-head { margin: 0 0 8px; font-size: 11px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.04em; }
.tk-card {
  margin: 0 0 8px; border-radius: 10px; background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.07); overflow: hidden;
}
.tk-card--muted { opacity: 0.65; }
.tk-card-main { display: flex; gap: 10px; padding: 10px; cursor: pointer; }
.tk-thumb { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; flex: none; background: rgba(255, 255, 255, 0.08); }
.tk-thumb--draft { width: 88px; height: 88px; }
.tk-card-body { min-width: 0; flex: 1; }
.tk-card-title { font-weight: 600; overflow-wrap: anywhere; }
.tk-card-meta { margin-top: 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 11px; opacity: 0.7; }
.tk-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px; background: rgba(255, 255, 255, 0.1); }
.tk-chip--running { background: rgba(90, 160, 255, 0.25); }
.tk-chip--done { background: rgba(90, 200, 130, 0.25); }
.tk-chip--failed { background: rgba(255, 107, 107, 0.25); }
.tk-chip--needs_confirmation { background: rgba(255, 190, 70, 0.28); }
.tk-spin { margin-right: 2px; }
.tk-summary { margin-top: 6px; overflow-wrap: anywhere; }
.tk-detail { padding: 0 10px 10px; }
.tk-image { display: block; max-width: 100%; max-height: 320px; margin: 0 auto 10px; border-radius: 8px; }
.tk-result { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; border-radius: 8px; background: rgba(0, 0, 0, 0.25); }
.tk-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.tk-draft { display: flex; gap: 10px; padding: 10px; }
.tk-draft-form { flex: 1; min-width: 0; }
</style>
