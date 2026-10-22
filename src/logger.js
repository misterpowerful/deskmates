export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// console.error rather than console.log: journald tags stderr output at a
// higher priority than stdout, so `journalctl -p err` (or any log shipper
// filtering on severity) actually catches these. Use for failures that
// should be visible without having to grep the full-volume info log —
// e.g. a turn-log insert failing silently would otherwise look identical
// to routine chatter.
export function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}
