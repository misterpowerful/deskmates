import { ref, onMounted, onUnmounted } from "vue";

// A reactive `performance.now()` ticking on every animation frame — for
// visualizations that need to animate even while `level` is flat (idle
// breathing, a "thinking" loader motion), since a plain computed() only
// re-runs when one of its actual prop dependencies changes.
export function useAnimationClock() {
  const now = ref(performance.now());
  let rafId = null;

  function tick() {
    now.value = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  onMounted(() => {
    rafId = requestAnimationFrame(tick);
  });
  onUnmounted(() => {
    if (rafId) cancelAnimationFrame(rafId);
  });

  return now;
}
