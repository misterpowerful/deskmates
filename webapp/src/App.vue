<template>
  <q-layout view="hHh lpR fFf" class="bb-app">
    <template v-if="!session.token">
      <div class="bb-token-gate">
        <q-card flat bordered class="bb-token-card">
          <q-card-section>
            <div class="text-subtitle1 q-mb-sm">Deskmates access token</div>
            <q-input
              v-model="tokenInput"
              type="password"
              dense
              outlined
              autofocus
              placeholder="BOT_AUTH_TOKEN"
              @keyup.enter="submitToken"
            />
          </q-card-section>
          <q-card-actions align="right">
            <q-btn color="primary" unelevated label="Continue" :disable="!tokenInput" @click="submitToken" />
          </q-card-actions>
        </q-card>
      </div>
    </template>

    <template v-else>
      <q-header class="bb-header">
        <q-toolbar>
          <q-toolbar-title class="bb-title">Deskmates</q-toolbar-title>

          <q-space />

          <div class="bb-status" :class="session.connectionState">
            <span class="bb-dot" />
            {{ session.connectionState }}
          </div>

          <q-btn flat round dense icon="menu" aria-label="Menu" @click="menuOpen = !menuOpen" />
        </q-toolbar>

        <q-tabs v-model="activeView" dense align="justify" class="bb-view-tabs">
          <q-tab v-for="v in PRIMARY_VIEWS" :key="v.name" :name="v.name" :label="v.label" />
        </q-tabs>
      </q-header>

      <!-- Collapsed by default; everything that isn't Visualizer/Transcript lives here. -->
      <q-drawer v-model="menuOpen" side="right" overlay behavior="mobile" class="bb-menu">
        <q-list>
          <q-item v-if="session.personalities.length">
            <q-item-section>
              <q-select
                :model-value="session.activePersonality"
                :options="personalityOptions"
                option-value="value"
                option-label="label"
                emit-value
                map-options
                label="Personality"
                dense
                outlined
                dark
                @update:model-value="onPersonalityChange"
              />
            </q-item-section>
          </q-item>
          <q-item v-if="session.llmOptions.length">
            <q-item-section>
              <q-select
                :model-value="session.activeLlm"
                :options="session.llmOptions"
                option-value="value"
                option-label="label"
                emit-value
                map-options
                label="Model"
                dense
                outlined
                dark
                @update:model-value="setLlm"
              />
            </q-item-section>
          </q-item>
          <q-item clickable @click="openQueue">
            <q-item-section avatar><q-icon name="low_priority" /></q-item-section>
            <q-item-section>Build queue</q-item-section>
          </q-item>
          <q-item clickable @click="openColors">
            <q-item-section avatar><q-icon name="palette" /></q-item-section>
            <q-item-section>Colors</q-item-section>
          </q-item>
          <q-item clickable @click="openBotNames">
            <q-item-section avatar><q-icon name="badge" /></q-item-section>
            <q-item-section>Bot names</q-item-section>
          </q-item>
          <q-separator dark />
          <q-item
            v-for="v in MENU_VIEWS"
            :key="v.name"
            clickable
            :active="activeView === v.name"
            @click="openView(v.name)"
          >
            <q-item-section avatar><q-icon :name="v.icon" /></q-item-section>
            <q-item-section>{{ v.label }}</q-item-section>
          </q-item>
        </q-list>
      </q-drawer>

      <ColorSettingsDrawer v-model="colorDrawerOpen" />
      <QueueDrawer v-model="queueDrawerOpen" />
      <PersonalityNamesDrawer v-model="botNamesDrawerOpen" />

      <q-page-container>
        <q-page class="bb-page">
          <!-- All three views stay mounted and populated regardless of which is
               visible (v-show, not v-if) — switching never drops entries that
               arrived while a view was hidden. -->
          <div v-show="activeView === 'visualizer'" class="bb-view bb-view--visualizer">
            <div class="bb-visualizer-stage">
              <VisualizerCarousel
                :state="pipelineState.state"
                :mode="pipelineState.mode"
                :level="pipelineState.level"
                :primary-color="currentModeColors.primary"
                :secondary-color="currentModeColors.secondary"
                :bot-name="activeBotName"
              />
            </div>
            <div class="bb-mic-dock">
              <q-btn
                round
                size="xl"
                class="bb-mic-btn"
                :color="autoConversation.active ? 'negative' : 'primary'"
                :icon="autoConversation.active ? 'mic' : 'mic_none'"
                @click="toggleMic"
              />
              <div class="bb-mic-hint">{{ micHint }}</div>
            </div>
          </div>

          <div v-show="activeView === 'transcript'" class="bb-view">
            <TranscriptPanel />
          </div>

          <div v-show="activeView === 'log'" class="bb-view">
            <LogPanel />
          </div>

          <!-- Unlike the three views above, these two are v-if rather than
               v-show: each fetches from /api on mount, and the live views are
               deliberately always-mounted so they never miss a socket event.
               These have no such requirement, so there is no reason to query
               the turn log on every page load whether or not anyone opens
               them. They refetch on each open, which is also what makes the
               numbers current rather than frozen at page load. -->
          <div v-if="activeView === 'turns'" class="bb-view">
            <TurnsPanel />
          </div>

          <div v-if="activeView === 'costs'" class="bb-view">
            <CostsPanel />
          </div>

          <div v-if="activeView === 'usage'" class="bb-view">
            <UsagePanel />
          </div>

          <div v-if="activeView === 'changes'" class="bb-view">
            <ChangesPanel />
          </div>

          <div v-if="activeView === 'changelog'" class="bb-view">
            <ChangelogPanel />
          </div>

          <div v-if="activeView === 'memory'" class="bb-view">
            <MemoryPanel />
          </div>
        </q-page>
      </q-page-container>
    </template>
  </q-layout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useQuasar } from "quasar";
import { session, setToken, connect, setPersonality, setLlm } from "./composables/session.js";
import { describeTaskNotification } from "./composables/taskNotifications.js";
import { pipelineState } from "./composables/pipelineState.js";
import { autoConversation, toggle as toggleAutoConversation, micStartError } from "./composables/useAutoConversation.js";
import { colorSettings, modeColors } from "./composables/colorSettings.js";
import VisualizerCarousel from "./components/VisualizerCarousel.vue";
import ColorSettingsDrawer from "./components/ColorSettingsDrawer.vue";
import QueueDrawer from "./components/QueueDrawer.vue";
import PersonalityNamesDrawer from "./components/PersonalityNamesDrawer.vue";
import TranscriptPanel from "./components/TranscriptPanel.vue";
import LogPanel from "./components/LogPanel.vue";
import TurnsPanel from "./components/TurnsPanel.vue";
import CostsPanel from "./components/CostsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import ChangesPanel from "./components/ChangesPanel.vue";
import ChangelogPanel from "./components/ChangelogPanel.vue";
import MemoryPanel from "./components/MemoryPanel.vue";
import { PRIMARY_VIEWS, MENU_VIEWS } from "./composables/menuViews.js";

const $q = useQuasar();

const activeView = ref("visualizer");
const tokenInput = ref("");
const colorDrawerOpen = ref(false);
const queueDrawerOpen = ref(false);
const botNamesDrawerOpen = ref(false);
const menuOpen = ref(false);

function openQueue() {
  menuOpen.value = false;
  queueDrawerOpen.value = true;
}

function openColors() {
  menuOpen.value = false;
  colorDrawerOpen.value = true;
}

function openBotNames() {
  menuOpen.value = false;
  botNamesDrawerOpen.value = true;
}

function openView(name) {
  menuOpen.value = false;
  activeView.value = name;
}

// colorSettings is keyed on the reactive store itself so switching modes
// (once the protocol can tell us the effective mode — see session.js) picks
// up the drawer's saved colors automatically.
const currentModeColors = computed(() => modeColors(pipelineState.mode) ?? colorSettings.friendly);

// { label: display name, value: slug } so the picker shows "Gatsby" instead
// of "gatsby-sardonic" while still emitting the slug set_personality expects.
// Falls back to the raw slug for a personality session.displayNames hasn't
// heard about yet (list_personalities hasn't returned, or a genuinely
// unnamed one) rather than showing a blank label.
const personalityOptions = computed(() =>
  session.personalities.map((slug) => ({ value: slug, label: session.displayNames[slug] ?? slug })),
);

const activeBotName = computed(() => session.displayNames[session.activePersonality] ?? session.activePersonality);

function submitToken() {
  if (!tokenInput.value) return;
  setToken(tokenInput.value);
  connect();
}

function onPersonalityChange(name) {
  setPersonality(name);
}

function toggleMic() {
  toggleAutoConversation();
}

// micStartError takes priority: it's only set when start() never reaches
// "listening" at all (getUserMedia rejected) or a recording couldn't even
// begin (MediaRecorder unsupported) — see useAutoConversation.js — cases
// where pipelineState.state stays "idle" and would otherwise show the
// generic "Tap to start talking" with no indication anything went wrong.
const micHint = computed(() => {
  if (micStartError.message) return micStartError.message;
  return pipelineState.state === "idle" ? "Tap to start talking" :
    pipelineState.state === "listening" ? "Listening…" :
    pipelineState.state === "thinking" ? "Thinking…" :
    "Speaking…";
});

// A delegated task finished while this connection was open — session.js
// just parses/stores the frame (no Quasar context there), so the actual
// toast fires here. Visual only, never spoken, same rule as the physical
// bot's completion chime (CAPABILITIES.md's "Async task delegation").
watch(
  () => session.lastTaskNotification,
  (notification) => {
    if (!notification) return;
    $q.notify({ message: describeTaskNotification(notification), type: "info", position: "top" });
    session.lastTaskNotification = null;
  },
);

onMounted(() => {
  // Same ?token= query-param pattern the console's WS URL already uses —
  // here it's how a shared link can pre-fill the stored token instead of
  // showing the manual prompt.
  const params = new URLSearchParams(location.search);
  const urlToken = params.get("token");
  if (urlToken) {
    setToken(urlToken);
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
  }

  if (session.token) connect();
});
</script>

<style>
:root {
  --bb-bg: #14161a;
  --bb-panel: #1c1f26;
  --bb-border: #2c3038;
  --bb-text: #e6e8eb;
  --bb-muted: #8b93a1;
  --bb-accent: #5eb1ff;
  --bb-ok: #4caf7d;
  --bb-bad: #e2564f;
  --bb-warn: #d9a441;
}
body {
  background: var(--bb-bg);
  color: var(--bb-text);
}
.bb-app {
  min-height: 100vh;
}
.bb-token-gate {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--bb-bg);
}
.bb-token-card {
  width: 100%;
  max-width: 360px;
  background: var(--bb-panel);
  color: var(--bb-text);
}
.bb-header {
  background: var(--bb-panel);
  border-bottom: 1px solid var(--bb-border);
}
.bb-title {
  flex: none;
  margin-right: 12px;
  font-weight: 600;
}
.bb-menu {
  background: var(--bb-panel);
  color: var(--bb-text);
}
.bb-status {
  margin-right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--bb-muted);
  flex-shrink: 0;
}
.bb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bb-muted);
}
.bb-status.connected .bb-dot { background: var(--bb-ok); }
.bb-status.connecting .bb-dot { background: var(--bb-warn); }
.bb-status.reconnecting .bb-dot { background: var(--bb-warn); }
.bb-status.error .bb-dot { background: var(--bb-bad); }
.bb-view-tabs {
  background: var(--bb-panel);
}
.bb-page {
  padding: 0;
}
.bb-view {
  /* dvh, not vh — see TranscriptPanel.vue comment for why. Same reasoning
     applies here: this height staying stale against vh is what let the
     transcript tab's layout drift out of sync with the real visible
     viewport after switching tabs away and back. */
  min-height: calc(100dvh - 112px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 16px;
}
.bb-view--visualizer {
  justify-content: space-between;
  gap: 0;
  padding-bottom: max(32px, env(safe-area-inset-bottom));
}
.bb-visualizer-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}
.bb-mic-dock {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.bb-mic-btn {
  width: 88px;
  height: 88px;
}
.bb-mic-hint {
  color: var(--bb-muted);
  font-size: 13px;
}
</style>
