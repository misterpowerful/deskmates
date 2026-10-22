<template>
  <div class="cw-wrap">
    <canvas
      ref="canvasEl"
      class="cw-canvas"
      :width="SIZE"
      :height="SIZE"
      @pointerdown="onPointerDown"
    />
    <input
      type="range"
      min="0"
      max="100"
      v-model.number="lightness"
      class="cw-lightness"
      @input="onLightnessInput"
    />
    <div class="cw-row">
      <span class="cw-swatch" :style="{ background: modelValue }" />
      <input class="cw-hex" :value="modelValue" spellcheck="false" @change="onHexInput" />
    </div>
  </div>
</template>

<script setup>
// A literal circular hue/saturation wheel (Quasar's own QColor picker only
// offers a square spectrum + hue bar) plus a lightness slider and a hex
// fallback for precise entry. Emits hex strings only.
import { ref, computed, onMounted, watch } from "vue";

const props = defineProps({
  modelValue: { type: String, required: true },
});
const emit = defineEmits(["update:modelValue"]);

const SIZE = 140;
const RADIUS = SIZE / 2;

const canvasEl = ref(null);
const hue = ref(0);
const sat = ref(0);
const lightness = ref(50);
let dragging = false;
let suppressWatch = false;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hslToHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

// Standard hex -> HSL, used only to seed the wheel/slider from modelValue.
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return { h: 0, s: 0, l: 50 };
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function seedFromModelValue() {
  const { h, s, l } = hexToHsl(props.modelValue);
  hue.value = h;
  sat.value = s;
  lightness.value = Math.round(l);
}

function currentHex() {
  return hslToHex(hue.value, sat.value, lightness.value);
}

function emitCurrent() {
  emit("update:modelValue", currentHex());
}

function draw() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.arc(RADIUS, RADIUS, RADIUS - 1, 0, Math.PI * 2);
  ctx.clip();

  if (ctx.createConicGradient) {
    const hueGrad = ctx.createConicGradient(0, RADIUS, RADIUS);
    for (let i = 0; i <= 360; i += 30) {
      hueGrad.addColorStop(i / 360, `hsl(${i}, 100%, 50%)`);
    }
    ctx.fillStyle = hueGrad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else {
    // Fallback for engines without conic gradients: coarse wedge fill.
    for (let deg = 0; deg < 360; deg += 4) {
      ctx.beginPath();
      ctx.moveTo(RADIUS, RADIUS);
      ctx.arc(RADIUS, RADIUS, RADIUS, (deg * Math.PI) / 180, ((deg + 4) * Math.PI) / 180);
      ctx.closePath();
      ctx.fillStyle = `hsl(${deg}, 100%, 50%)`;
      ctx.fill();
    }
  }

  const satGrad = ctx.createRadialGradient(RADIUS, RADIUS, 0, RADIUS, RADIUS, RADIUS);
  satGrad.addColorStop(0, "rgba(255,255,255,1)");
  satGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = satGrad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.restore();

  const angleRad = (hue.value * Math.PI) / 180;
  const r = (sat.value / 100) * RADIUS;
  const x = RADIUS + Math.cos(angleRad) * r;
  const y = RADIUS + Math.sin(angleRad) * r;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function updateFromPoint(clientX, clientY) {
  const canvas = canvasEl.value;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left - rect.width / 2;
  const y = clientY - rect.top - rect.height / 2;
  const dist = clamp(Math.sqrt(x * x + y * y), 0, rect.width / 2);
  let angle = (Math.atan2(y, x) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  hue.value = angle;
  sat.value = (dist / (rect.width / 2)) * 100;
  suppressWatch = true;
  emitCurrent();
  draw();
}

function onPointerDown(e) {
  dragging = true;
  e.target.setPointerCapture(e.pointerId);
  updateFromPoint(e.clientX, e.clientY);
  const move = (ev) => {
    if (!dragging) return;
    updateFromPoint(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    dragging = false;
    e.target.releasePointerCapture(ev.pointerId);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function onLightnessInput() {
  suppressWatch = true;
  emitCurrent();
  draw();
}

function onHexInput(e) {
  const hex = e.target.value.trim();
  if (!/^#?[0-9a-f]{6}$/i.test(hex)) {
    e.target.value = props.modelValue;
    return;
  }
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  suppressWatch = true;
  emit("update:modelValue", normalized);
}

watch(
  () => props.modelValue,
  () => {
    if (suppressWatch) {
      suppressWatch = false;
      return;
    }
    seedFromModelValue();
    draw();
  },
);

onMounted(() => {
  seedFromModelValue();
  draw();
});
</script>

<style scoped>
.cw-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 140px;
}
.cw-canvas {
  border-radius: 50%;
  touch-action: none;
  cursor: crosshair;
}
.cw-lightness {
  width: 100%;
}
.cw-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}
.cw-swatch {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--bb-border, #2c3038);
  flex-shrink: 0;
}
.cw-hex {
  flex: 1;
  min-width: 0;
  background: var(--bb-panel, #1c1f26);
  color: var(--bb-text, #e6e8eb);
  border: 1px solid var(--bb-border, #2c3038);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
