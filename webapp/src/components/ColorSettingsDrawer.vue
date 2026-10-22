<template>
  <q-dialog :model-value="modelValue" position="right" @update:model-value="$emit('update:modelValue', $event)">
   <div class="cs-drawer">
    <q-list>
      <q-item-label header>Mode colors</q-item-label>
      <q-expansion-item
        v-for="mode in MODE_LIST"
        :key="mode"
        :label="modeDisplayLabel(mode)"
        default-opened
      >
        <div class="cs-mode-body">
          <div class="cs-swatch-row">
            <div class="cs-picker">
              <div class="cs-picker-label">Primary</div>
              <ColorWheel
                :model-value="colorSettings[mode].primary"
                @update:model-value="(v) => setModeColor(mode, 'primary', v)"
              />
            </div>
            <div class="cs-picker">
              <div class="cs-picker-label">Secondary</div>
              <ColorWheel
                :model-value="colorSettings[mode].secondary"
                @update:model-value="(v) => setModeColor(mode, 'secondary', v)"
              />
            </div>
          </div>
          <q-btn flat dense no-caps size="sm" label="Reset to default" @click="resetModeColors(mode)" />
        </div>
      </q-expansion-item>
    </q-list>
   </div>
  </q-dialog>
</template>

<script setup>
import ColorWheel from "./ColorWheel.vue";
import { colorSettings, setModeColor, resetModeColors, modeDisplayLabel, MODE_LIST } from "../composables/colorSettings.js";

defineProps({ modelValue: { type: Boolean, default: false } });
defineEmits(["update:modelValue"]);
</script>

<style scoped>
.cs-drawer {
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
.cs-mode-body {
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cs-swatch-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.cs-picker {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.cs-picker-label {
  font-size: 11px;
  color: var(--bb-muted, #8b93a1);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
