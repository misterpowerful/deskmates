<template>
  <div class="vc-wrap">
    <div class="vc-bot-name">{{ botName }}</div>
    <div class="vc-stage">
      <VisualizerAtom
        :state="state"
        :mode="mode"
        :level="level"
        :primary-color="primaryColor"
        :secondary-color="secondaryColor"
      />
    </div>
  </div>
</template>

<script setup>
import VisualizerAtom from "./VisualizerAtom.vue";

defineProps({
  state: { type: String, default: "idle" },
  mode: { type: String, default: "" },
  level: { type: Number, default: 0 },
  primaryColor: { type: String, default: "#5eb1ff" },
  secondaryColor: { type: String, default: "#1c3a52" },
  // The state caption ("Listening"/"Thinking"/"Speaking") used to live here,
  // but App.vue's mic hint already shows the current action right below the
  // mic button — this slot shows who you're talking to instead.
  botName: { type: String, default: "" },
});
</script>

<style scoped>
.vc-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.vc-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 360px;
  height: 340px;
}
.vc-bot-name {
  font-size: 12px;
  color: var(--bb-muted, #8b93a1);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
