import { reactive } from "vue";

const MAX_ENTRIES = 750;

// Raw event log: sent/received messages, binary frame notices, connection
// state changes, errors. Decoupled from any DOM — a plain reactive array any
// component can read, populated regardless of whether the Log view is
// currently visible.
export const protocolLog = reactive([]);

const DIR_LABEL = { sent: "→", recv: "←", sys: "·", err: "!" };

export function logEvent(dir, text) {
  protocolLog.push({ timestamp: new Date().toISOString(), dir, text });
  if (protocolLog.length > MAX_ENTRIES) {
    protocolLog.splice(0, protocolLog.length - MAX_ENTRIES);
  }
}

export const logSent = (text) => logEvent("sent", text);
export const logRecv = (text) => logEvent("recv", text);
export const logSys = (text) => logEvent("sys", text);
export const logErr = (text) => logEvent("err", text);

export function clearProtocolLog() {
  protocolLog.splice(0, protocolLog.length);
}

export function formatProtocolLogForCopy({ personality, mode, connectionState }) {
  const header = [
    "--- Deskmates session log ---",
    `Captured: ${new Date().toISOString()}`,
    `Personality: ${personality || "—"} | Mode: ${mode || "—"} | Connection: ${connectionState || "—"}`,
    "-----------------------------",
  ].join("\n");

  const lines = protocolLog.map((entry) => {
    const t = new Date(entry.timestamp).toLocaleTimeString();
    return `[${t}] ${DIR_LABEL[entry.dir] ?? "·"} ${entry.text}`;
  });

  return [header, ...lines].join("\n");
}
