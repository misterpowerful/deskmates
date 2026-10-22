import { parseTaskFile } from "./taskFile.js";

// Light gate for the jobs that write data rather than code (ideation writes
// task files, reflection and the approve/reject scripts write insight JSON).
// They validate what they are about to persist; a failure is refused and
// logged rather than committed. See TESTING-GATE.md section 7.

const MAX_TITLE_LENGTH = 300;
const MAX_TASK_BYTES = 200_000;

function isValidDate(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

// Returns { ok, errors } for the raw text of a tasks/*.md file.
export function validateTaskFile(raw) {
  const errors = [];
  if (typeof raw !== "string") return { ok: false, errors: ["task file is not text"] };
  if (Buffer.byteLength(raw) > MAX_TASK_BYTES) errors.push("task file is too large");
  if (raw.includes("\0")) errors.push("task file contains a NUL byte");
  if (!/^---\r?\n/.test(raw)) {
    errors.push("missing frontmatter fence");
    return { ok: false, errors };
  }
  const { frontmatter, body } = parseTaskFile(raw);
  if (!frontmatter.source) errors.push("frontmatter is missing source");
  if (!isValidDate(frontmatter.created)) errors.push("frontmatter created is missing or not a valid date");
  if (!frontmatter.title) errors.push("frontmatter is missing title");
  else if (frontmatter.title.length > MAX_TITLE_LENGTH) errors.push("title is too long");
  if (!body) errors.push("task body is empty");
  return { ok: errors.length === 0, errors };
}

// Returns { ok, errors } for a parsed insights.json value.
export function validateInsights(value) {
  if (!Array.isArray(value)) return { ok: false, errors: ["insights must be an array"] };
  const errors = [];
  value.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`[${i}] is not an object`);
      return;
    }
    if (typeof entry.insight !== "string" || !entry.insight.trim()) errors.push(`[${i}] insight must be non-empty text`);
    if (!Array.isArray(entry.sourceTags) || entry.sourceTags.some((t) => typeof t !== "string")) {
      errors.push(`[${i}] sourceTags must be an array of strings`);
    }
    if (typeof entry.status !== "string" || !entry.status.trim()) errors.push(`[${i}] status must be non-empty text`);
    if (!isValidDate(entry.createdAt)) errors.push(`[${i}] createdAt is missing or not a valid date`);
  });
  return { ok: errors.length === 0, errors };
}

// Returns { ok, errors } for a parsed memory.json (long-term memory facts) value.
export function validateMemoryFacts(value) {
  if (!Array.isArray(value)) return { ok: false, errors: ["memory facts must be an array"] };
  const errors = [];
  value.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`[${i}] is not an object`);
      return;
    }
    if (typeof entry.fact !== "string" || !entry.fact.trim()) errors.push(`[${i}] fact must be non-empty text`);
    if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== "string"))) {
      errors.push(`[${i}] tags must be an array of strings`);
    }
    if (!isValidDate(entry.savedAt)) errors.push(`[${i}] savedAt is missing or not a valid date`);
  });
  return { ok: errors.length === 0, errors };
}
