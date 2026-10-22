<template>
  <div class="atom-wrap">
    <canvas ref="canvasEl" class="atom-canvas" />
  </div>
</template>

<script setup>
// Props-only contract, same as the pipeline expects — see App.vue's
// :state/:mode/:level/:primary-color/:secondary-color bindings. `level` is
// the audio-reactive 0-1 loudness useAudioLevel.js derives from an
// AnalyserNode and writes into pipelineState.level once per animation
// frame — passed straight into the engine's setLevel so the nucleus pulse
// tracks real mic/playback loudness instead of its own synthetic pulse.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createAtomVisualizer } from "../lib/atomVisualizer.js";

const props = defineProps({
  state: { type: String, default: "idle" },
  mode: { type: String, default: "" },
  level: { type: Number, default: 0 },
  primaryColor: { type: String, default: "#5eb1ff" },
  secondaryColor: { type: String, default: "#1c3a52" },
});

const canvasEl = ref(null);
let viz = null;

onMounted(() => {
  viz = createAtomVisualizer(canvasEl.value, {
    primary: props.primaryColor,
    secondary: props.secondaryColor,
    state: props.state,
  });
  viz.setLevel(props.level);
});

watch(() => props.state, (next) => viz?.setState(next));
watch([() => props.primaryColor, () => props.secondaryColor], ([p, s]) => viz?.setColors(p, s));
watch(() => props.level, (next) => viz?.setLevel(next));

onBeforeUnmount(() => {
  viz?.destroy();
  viz = null;
});
</script>

<style scoped>
.atom-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.atom-canvas {
  width: 100%;
  max-width: 340px;
  height: 320px;
}
</style>
