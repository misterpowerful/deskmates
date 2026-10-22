<template>
  <q-dialog :model-value="modelValue" position="right" @update:model-value="$emit('update:modelValue', $event)">
   <div class="qd-drawer">
    <div class="qd-head">
      <div class="qd-title">Build queue</div>
      <q-btn flat dense round icon="refresh" :loading="loading" :disable="saving" @click="load" />
    </div>
    <div class="qd-hint">Drag cards to set the order tasks are built overnight — top runs first.</div>

    <div v-if="error" class="qd-error">{{ error }}</div>
    <div v-if="!loading && !tasks.length && !error" class="qd-empty">No pending tasks.</div>

    <div ref="listEl" class="qd-list">
      <div
        v-for="(task, i) in tasks"
        :key="task.filename"
        class="qd-card"
        :class="{ 'qd-card--dragging': dragIndex === i }"
        :data-index="i"
      >
        <span
          class="qd-handle"
          role="button"
          :aria-label="`Drag to reorder: ${task.title}`"
          @pointerdown="startDrag($event, i)"
        >
          <q-icon name="drag_indicator" size="22px" />
        </span>
        <span class="qd-rank">{{ i + 1 }}</span>
        <span class="qd-card-title">{{ task.title }}</span>
        <template v-if="confirmIndex === i">
          <q-btn flat dense round size="sm" icon="close" :disable="deleting" @click="cancelDelete" />
          <q-btn flat dense round size="sm" icon="check" color="negative" :loading="deleting" @click="deleteTask(i)" />
        </template>
        <q-btn
          v-else
          flat
          dense
          round
          size="sm"
          icon="delete_outline"
          :aria-label="`Remove: ${task.title}`"
          :disable="saving || deleting"
          @click="askDelete(i)"
        />
      </div>
    </div>
   </div>
  </q-dialog>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from "vue";
import { apiFetch, apiPost } from "../composables/session.js";

const props = defineProps({ modelValue: { type: Boolean, default: false } });
defineEmits(["update:modelValue"]);

const tasks = ref([]);
const loading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const error = ref("");
const listEl = ref(null);
const dragIndex = ref(-1);
const confirmIndex = ref(-1);

// Refetched on every open so the drawer reflects what's really on disk
// (tasks get queued and built between visits), not what it saw last time.
watch(() => props.modelValue, (open) => { if (open) load(); });

async function load() {
  loading.value = true;
  error.value = "";
  confirmIndex.value = -1;
  try {
    tasks.value = (await apiFetch("/api/queue")).tasks;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

// Deleting is irreversible — the file leaves tasks/pending/ entirely — so a
// trash tap just arms a confirm/cancel pair on that card rather than firing
// the request straight away.
function askDelete(i) {
  if (saving.value || deleting.value) return;
  confirmIndex.value = confirmIndex.value === i ? -1 : i;
}

function cancelDelete() {
  confirmIndex.value = -1;
}

// Same optimistic-then-reconcile pattern as endDrag: remove the card right
// away, and on failure put it back (at its original index) with an error
// rather than leaving the list looking like the delete succeeded.
async function deleteTask(i) {
  const task = tasks.value[i];
  confirmIndex.value = -1;
  deleting.value = true;
  error.value = "";
  const next = [...tasks.value];
  next.splice(i, 1);
  tasks.value = next;
  try {
    await apiPost("/api/queue/reject", { filename: task.filename });
  } catch (err) {
    error.value = `Delete failed: ${err.message}`;
    const restored = [...tasks.value];
    restored.splice(i, 0, task);
    tasks.value = restored;
  } finally {
    deleting.value = false;
  }
}

// Pointer events rather than HTML5 drag-and-drop: this is a phone-first
// webapp and the native drag API doesn't fire from touch input.
let dragStartOrder = null;

function startDrag(event, index) {
  if (saving.value) return;
  confirmIndex.value = -1;
  event.preventDefault();
  dragIndex.value = index;
  dragStartOrder = tasks.value.map((t) => t.filename);
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", cancelDrag);
}

function onMove(event) {
  const cards = [...listEl.value.querySelectorAll(".qd-card")];
  let target = cards.findIndex((el) => event.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
  if (target === -1) target = cards.length - 1;
  if (target === dragIndex.value) return;
  const next = [...tasks.value];
  const [moved] = next.splice(dragIndex.value, 1);
  next.splice(target, 0, moved);
  tasks.value = next;
  dragIndex.value = target;
}

function stopListening() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", cancelDrag);
  dragIndex.value = -1;
}

// Drop = persist. On failure the list is put back and the error shown, so a
// reorder that didn't save is never left looking like one that did.
async function endDrag() {
  stopListening();
  const order = tasks.value.map((t) => t.filename);
  if (order.every((name, i) => name === dragStartOrder[i])) return;
  saving.value = true;
  error.value = "";
  try {
    await apiPost("/api/queue/order", { order });
  } catch (err) {
    error.value = `Reorder not saved: ${err.message}`;
    await load();
  } finally {
    saving.value = false;
  }
}

function cancelDrag() {
  stopListening();
  const byName = new Map(tasks.value.map((t) => [t.filename, t]));
  tasks.value = dragStartOrder.map((name) => byName.get(name));
}

onBeforeUnmount(stopListening);
</script>

<style scoped>
.qd-drawer {
  width: min(360px, 100vw);
  align-self: flex-start;
  margin-top: 56px;
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  border: 1px solid var(--bb-border, #2c3038);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  background: var(--bb-panel, #1c1f26);
  color: var(--bb-text, #e6e8eb);
}
.qd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 0;
}
.qd-title {
  font-weight: 600;
}
.qd-hint,
.qd-empty {
  padding: 4px 16px 12px;
  font-size: 12px;
  color: var(--bb-muted, #8b93a1);
}
.qd-error {
  margin: 0 16px 8px;
  font-size: 12px;
  color: var(--bb-bad, #e2564f);
}
.qd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 16px;
}
.qd-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 4px;
  border: 1px solid var(--bb-border, #2c3038);
  border-radius: 8px;
  background: var(--bb-bg, #14161a);
  font-size: 13px;
  user-select: none;
}
.qd-card--dragging {
  border-color: var(--bb-accent, #5eb1ff);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}
.qd-handle {
  display: flex;
  cursor: grab;
  touch-action: none;
  color: var(--bb-muted, #8b93a1);
}
.qd-rank {
  min-width: 18px;
  text-align: right;
  font-size: 11px;
  color: var(--bb-muted, #8b93a1);
}
.qd-card-title {
  flex: 1;
  min-width: 0;
}
</style>
