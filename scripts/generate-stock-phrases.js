import "dotenv/config";
import "../src/httpAgent.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { log } from "../src/logger.js";

// One-off, standalone from the running server: populates the static
// stock-phrase canned-response folders from data/phrase-manifest.json. Not
// imported by server.js / src/* — run manually via
// `npm run generate-stock-phrases`.

const ROOT = process.cwd();
const MANIFEST_PATH = path.join(ROOT, "data", "phrase-manifest.json");

// Same TTS model speechPipeline.js uses for live generation, so canned and
// live lines share the same voice character.
const TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_16000";
const MAX_ATTEMPTS = 3;
const CONFIRM_THRESHOLD = 10;

function fatal(message) {
  log(`FATAL: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      personality: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      category: { type: "string" },
      limit: { type: "string" },
      speed: { type: "string" },
      concurrency: { type: "string", default: "3" },
      force: { type: "boolean", default: false },
    },
  });

  if (!values.personality) {
    fatal("--personality <name> is required.");
  }

  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      fatal(`--limit must be a positive integer, got "${values.limit}".`);
    }
  }

  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    fatal(`--concurrency must be a positive integer, got "${values.concurrency}".`);
  }

  let speedOverride;
  if (values.speed !== undefined) {
    speedOverride = Number(values.speed);
    if (!Number.isFinite(speedOverride)) {
      fatal(`--speed must be a number, got "${values.speed}".`);
    }
  }

  return {
    personality: values.personality,
    dryRun: values["dry-run"],
    category: values.category,
    limit,
    speedOverride,
    concurrency,
    force: values.force,
  };
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fatal(`Manifest not found at ${MANIFEST_PATH}.`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function loadVoiceConfig(personality) {
  const base = path.join(ROOT, "personalities", personality);
  const voiceConfigPath = path.join(base, "voice-config.json");
  if (!fs.existsSync(voiceConfigPath)) {
    fatal(
      `Personality "${personality}" not found — missing ${path.relative(ROOT, voiceConfigPath)}.`,
    );
  }
  const voiceConfig = JSON.parse(fs.readFileSync(voiceConfigPath, "utf8"));
  return { base, voiceConfig };
}

// Flattens the manifest (optionally filtered to one category) into ordered
// { category, index, text, targetPath } tasks, preserving manifest order —
// both the category iteration order and the per-category array order matter
// for stable filenames and for how --limit truncates the run.
function buildTasks(manifest, category, sharedDir) {
  const categories = Object.keys(manifest);

  if (category) {
    if (!Object.prototype.hasOwnProperty.call(manifest, category)) {
      fatal(`Unknown category "${category}" — not present in the manifest.`);
    }
    return {
      categories: [category],
      tasks: manifest[category].map((entry, index) => ({
        category,
        index,
        text: entry.text,
        targetPath: path.join(sharedDir, category, `${category}_${index}.pcm`),
      })),
    };
  }

  const tasks = [];
  for (const cat of categories) {
    manifest[cat].forEach((entry, index) => {
      tasks.push({
        category: cat,
        index,
        text: entry.text,
        targetPath: path.join(sharedDir, cat, `${cat}_${index}.pcm`),
      });
    });
  }
  return { categories, tasks };
}

// Splits the full task list into { toGenerate, skipped }, applying the
// exists-skip rule and then --limit, in manifest order. --limit counts only
// lines that actually need generating: once it's reached, we stop scanning
// entirely (later categories are left untouched by this run, not just
// unlogged) — see the --limit flag description in the design.
function planTasks(tasks, force, limit) {
  const toGenerate = [];
  const skipped = [];

  for (const task of tasks) {
    const exists = fs.existsSync(task.targetPath);
    if (exists && !force) {
      skipped.push(task);
      continue;
    }
    if (limit !== undefined && toGenerate.length >= limit) {
      break;
    }
    toGenerate.push(task);
  }

  return { toGenerate, skipped };
}

function printDryRun(toGenerate, skipped) {
  for (const task of toGenerate) {
    console.log(
      `${task.category}\t${task.index}\t${JSON.stringify(task.text)}\t${path.relative(ROOT, task.targetPath)}`,
    );
  }
  console.log(
    `\n${toGenerate.length} line(s) would be generated (${skipped.length} already exist and would be skipped).`,
  );
}

async function confirmRun(toGenerate, skipped) {
  const charCount = toGenerate.reduce((sum, t) => sum + t.text.length, 0);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `About to generate ${toGenerate.length} line(s) (${skipped.length} already exist, skipping). ` +
        `Estimated characters: ~${charCount}. Continue? (y/n) `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function generateOne(elevenlabs, voiceId, speed, task) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stream = await elevenlabs.textToSpeech.convert(voiceId, {
        text: task.text,
        modelId: TTS_MODEL,
        outputFormat: OUTPUT_FORMAT,
        voiceSettings: { speed },
      });
      const audio = Buffer.from(await new Response(stream).arrayBuffer());
      fs.writeFileSync(task.targetPath, audio);
      log(`${task.category}/${task.index} (${task.text.length} chars) -> generated`);
      return { ...task, outcome: "generated", charCount: task.text.length, attempts: attempt };
    } catch (err) {
      const status = err?.statusCode;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (retryable && attempt < MAX_ATTEMPTS) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        log(
          `${task.category}/${task.index} attempt ${attempt} failed (status ${status}) — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }
      const message = err?.message ?? String(err);
      log(`${task.category}/${task.index} (${task.text.length} chars) -> FAILED: ${message}`);
      return {
        ...task,
        outcome: "failed",
        charCount: task.text.length,
        attempts: attempt,
        error: message,
      };
    }
  }
}

// Hand-rolled limited-concurrency pool: `concurrency` workers pull from a
// shared cursor over `toGenerate`, in order, until it's drained.
async function runPool(toGenerate, concurrency, worker) {
  const results = [];
  let cursor = 0;

  async function run() {
    while (cursor < toGenerate.length) {
      const task = toGenerate[cursor++];
      results.push(await worker(task));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, toGenerate.length) }, run),
  );
  return results;
}

function writeGenerationLog(personality, skipped, results) {
  const logsDir = path.join(ROOT, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const entries = [
    ...skipped.map((task) => ({
      category: task.category,
      index: task.index,
      text: task.text,
      targetPath: path.relative(ROOT, task.targetPath),
      charCount: task.text.length,
      outcome: "skipped",
    })),
    ...results.map((r) => ({
      category: r.category,
      index: r.index,
      text: r.text,
      targetPath: path.relative(ROOT, r.targetPath),
      charCount: r.charCount,
      outcome: r.outcome,
      attempts: r.attempts,
      ...(r.error ? { error: r.error } : {}),
    })),
  ];

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logsDir, `generation-${personality}-${timestamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2));
  log(`Wrote generation log to ${path.relative(ROOT, logPath)}`);
}

async function main() {
  const args = parseCliArgs();
  const manifest = loadManifest();
  const { base, voiceConfig } = loadVoiceConfig(args.personality);

  const voiceId = voiceConfig.voice_id;
  if (!voiceId) {
    fatal(`voice-config.json for "${args.personality}" has no voice_id.`);
  }

  const speed = args.speedOverride ?? voiceConfig.speed?.friendly;
  if (!Number.isFinite(speed)) {
    fatal(
      `voice-config.json for "${args.personality}" has no speed.friendly value — pass --speed explicitly.`,
    );
  }

  const sharedDir = path.join(base, "canned-responses", "shared");
  const { categories, tasks } = buildTasks(manifest, args.category, sharedDir);
  const { toGenerate, skipped } = planTasks(tasks, args.force, args.limit);

  if (args.dryRun) {
    printDryRun(toGenerate, skipped);
    return;
  }

  // Scaffold shared/<category>/ for every category this run touches — never
  // deletes or touches anything already present (custom-* folders, existing
  // .pcm files).
  for (const category of categories) {
    fs.mkdirSync(path.join(sharedDir, category), { recursive: true });
  }

  if (toGenerate.length === 0) {
    log(`Nothing to generate (${skipped.length} already exist).`);
    writeGenerationLog(args.personality, skipped, []);
    return;
  }

  if (toGenerate.length >= CONFIRM_THRESHOLD) {
    const confirmed = await confirmRun(toGenerate, skipped);
    if (!confirmed) {
      log("Aborted by user.");
      return;
    }
  }

  for (const task of skipped) {
    log(`${task.category}/${task.index} -> SKIP (exists)`);
  }

  const elevenlabs = new ElevenLabsClient();
  const results = await runPool(toGenerate, args.concurrency, (task) =>
    generateOne(elevenlabs, voiceId, speed, task),
  );

  const generated = results.filter((r) => r.outcome === "generated").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  log(`Done: ${generated} generated, ${skipped.length} skipped, ${failed} failed.`);

  writeGenerationLog(args.personality, skipped, results);
}

main();
