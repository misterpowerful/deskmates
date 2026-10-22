<template>
  <q-dialog :model-value="modelValue" position="right" @update:model-value="onToggle">
   <div class="pn-drawer">
    <q-list>
      <q-item-label header>Bot names</q-item-label>
      <q-item v-for="slug in session.personalities" :key="slug" class="pn-row">
        <q-item-section>
          <div class="pn-slug">{{ slug }}</div>
          <div class="pn-input-row">
            <q-input
              v-model="names[slug]"
              dense
              outlined
              dark
              maxlength="60"
              :disable="saving[slug]"
              @keyup.enter="save(slug)"
            />
            <q-btn
              flat
              round
              dense
              :icon="saved[slug] ? 'check' : 'save'"
              :color="saved[slug] ? 'positive' : undefined"
              :loading="saving[slug]"
              :disable="!names[slug]?.trim() || names[slug].trim() === session.displayNames[slug]"
              @click="save(slug)"
            />
          </div>
          <div v-if="renameErrors[slug]" class="pn-error">{{ renameErrors[slug] }}</div>
        </q-item-section>
      </q-item>
    </q-list>
   </div>
  </q-dialog>
</template>

<script setup>
import { reactive, watch } from "vue";
import { session, setPersonalityDisplayName, onPersonalityRenameError } from "../composables/session.js";

defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(["update:modelValue"]);

// Local editable copy — session.displayNames stays the source of truth and
// only updates once the server confirms the change, so a rename in progress
// doesn't flicker other UI (transcript labels, etc.) that reads the same map.
const names = reactive({});
const saving = reactive({});
const saved = reactive({});
const renameErrors = reactive({});
const errorTimers = {};

// A rejected rename (empty/invalid name, unknown slug, etc. — see
// server.js's handleSetPersonalityDisplayName) arrives as a generic "error"
// frame, which session.js now ties back to this slug instead of leaving the
// save spinner stuck forever. Shows the server's reason inline next to the
// row for a few seconds.
onPersonalityRenameError((slug, reason) => {
  if (!saving[slug]) return;
  saving[slug] = false;
  renameErrors[slug] = reason || "rename failed";
  clearTimeout(errorTimers[slug]);
  errorTimers[slug] = setTimeout(() => {
    renameErrors[slug] = "";
  }, 5000);
});

function syncFromSession() {
  for (const slug of session.personalities) {
    if (names[slug] === undefined) names[slug] = session.displayNames[slug] ?? "";
  }
}

watch(() => session.personalities, syncFromSession, { immediate: true });

// Reflects a confirmed rename back into the input (covers the case where
// the server trims/normalizes the name differently than what was typed) and
// clears the in-flight "saving" flag once the round trip lands.
watch(
  () => ({ ...session.displayNames }),
  (current) => {
    for (const slug of Object.keys(current)) {
      if (saving[slug] && names[slug]?.trim() === current[slug]) {
        saving[slug] = false;
        saved[slug] = true;
        names[slug] = current[slug];
      }
    }
  },
  { deep: true },
);

function save(slug) {
  const value = names[slug]?.trim();
  if (!value || value === session.displayNames[slug]) return;
  saving[slug] = true;
  saved[slug] = false;
  clearTimeout(errorTimers[slug]);
  renameErrors[slug] = "";
  setPersonalityDisplayName(slug, value);
}

function onToggle(value) {
  emit("update:modelValue", value);
  if (value) syncFromSession();
}
</script>

<style scoped>
.pn-drawer {
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
.pn-row {
  padding-bottom: 4px;
}
.pn-slug {
  font-size: 11px;
  color: var(--bb-muted, #8b93a1);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.pn-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pn-input-row .q-input {
  flex: 1;
}
.pn-error {
  margin-top: 4px;
  font-size: 12px;
  color: var(--bb-bad, #e2564f);
}
</style>
