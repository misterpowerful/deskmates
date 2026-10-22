import { logError } from "./logger.js";

function describe(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try {
    return `non-Error value: ${typeof err === "string" ? err : JSON.stringify(err)}`;
  } catch {
    return `non-Error value: ${String(err)}`;
  }
}

// Last-resort safety net: record why the process died in the structured log
// before exiting. systemd restarts the service; we don't try to keep serving
// from a possibly corrupted state. `getContext` (optional) returns extra
// details about what was in flight, e.g. the connection count.
export function installCrashHandlers({
  proc = process,
  log = logError,
  exit = (code) => process.exit(code),
  getContext = () => ({}),
} = {}) {
  let crashing = false;
  const handle = (kind) => (err) => {
    if (crashing) return;
    crashing = true;
    let context = "";
    try {
      context = JSON.stringify(getContext());
    } catch {
      context = "(context unavailable)";
    }
    try {
      log(`FATAL ${kind}: ${describe(err)} context=${context}`);
    } catch {
      // logging must never prevent the exit
    }
    exit(1);
  };
  proc.on("uncaughtException", handle("uncaughtException"));
  proc.on("unhandledRejection", handle("unhandledRejection"));
}
