// Which views are always visible as tabs vs. tucked behind the ☰ menu.
export const PRIMARY_VIEWS = [
  { name: "visualizer", label: "Visualizer" },
  { name: "transcript", label: "Transcript" },
];

export const MENU_VIEWS = [
  { name: "tasks", label: "Tasks", icon: "task_alt" },
  { name: "log", label: "Log", icon: "list_alt" },
  { name: "turns", label: "Turns", icon: "forum" },
  { name: "costs", label: "Costs", icon: "paid" },
  { name: "usage", label: "Usage", icon: "data_usage" },
  { name: "changes", label: "Changes", icon: "commit" },
  { name: "changelog", label: "Latest Changes", icon: "new_releases" },
  { name: "memory", label: "Memory", icon: "psychology" },
];

export function isPrimaryView(name) {
  return PRIMARY_VIEWS.some((v) => v.name === name);
}

export function isMenuView(name) {
  return MENU_VIEWS.some((v) => v.name === name);
}
