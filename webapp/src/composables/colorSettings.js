import { reactive } from "vue";

const STORAGE_KEY = "deskmates_mode_colors";

// Same three live mode values the rest of the app already treats as the
// known set (see session.js's DEFAULT_MODE comment). The server reports the
// mode each turn actually ran in as `effective_mode`, so the sentry_intruder
// and deep_thoughtful palettes show live when those modes are active.
export const MODE_LIST = ["friendly", "sentry_intruder", "deep_thoughtful"];

const DEFAULTS = {
  friendly: { primary: "#5eb1ff", secondary: "#1c3a52" },
  sentry_intruder: { primary: "#e2564f", secondary: "#4a1f1d" },
  deep_thoughtful: { primary: "#b28dff", secondary: "#2c2350" },
};

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function buildInitial() {
  const overrides = loadOverrides();
  const state = {};
  for (const mode of MODE_LIST) {
    state[mode] = { ...DEFAULTS[mode], ...(overrides[mode] ?? {}) };
  }
  return state;
}

export const colorSettings = reactive(buildInitial());

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colorSettings));
  } catch {
    /* storage unavailable — setting still applies for this session */
  }
}

export function setModeColor(mode, slot, hex) {
  if (!colorSettings[mode]) return;
  colorSettings[mode][slot] = hex;
  persist();
}

export function resetModeColors(mode) {
  if (!DEFAULTS[mode]) return;
  colorSettings[mode] = { ...DEFAULTS[mode] };
  persist();
}

export function modeColors(mode) {
  return colorSettings[mode] ?? DEFAULTS.friendly;
}

export function modeDisplayLabel(mode) {
  return mode
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
