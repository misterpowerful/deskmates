import "dotenv/config";
import "../src/httpAgent.js";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { log } from "../src/logger.js";

// Reusable, manifest-free batch generator for hand-picked canned-response
// lines (greeting, filler round 2, question_filler, ...) — as opposed to
// generate-stock-phrases.js, which is tied to the firmware-driven
// data/phrase-manifest.json and always targets canned-responses/shared/.
// This script takes an arbitrary { path, text }[] manifest (a JSON file via
// --manifest, or piped on stdin) and writes each line to its exact target
// path, so nothing about a specific batch needs to live in this repo
// permanently.
//
// Usage:
//   node scripts/generate-canned-lines.js --manifest batch.json
//   cat batch.json | node scripts/generate-canned-lines.js
//   node scripts/generate-canned-lines.js --manifest batch.json --dry-run

const ROOT = process.cwd();

const TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_16000";
const DEFAULT_VOICE_ID = "iOaeOfjw5WOFoce6tLnY"; // Gatsby (gatsby-sardonic)

// Hard account-plan ceiling on simultaneous ElevenLabs requests — same limit
// already respected elsewhere in this project (Flow generations there cap
// generations_count at 2). Not just a default: --concurrency is clamped to
// this, never raised past it.
const MAX_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;

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
      manifest: { type: "string" },
      "voice-id": { type: "string", default: DEFAULT_VOICE_ID },
      concurrency: { type: "string", default: String(MAX_CONCURRENCY) },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    fatal(`--concurrency must be a positive integer, got "${values.concurrency}".`);
  }
  if (concurrency > MAX_CONCURRENCY) {
    log(
      `--concurrency ${concurrency} exceeds the account-plan cap of ${MAX_CONCURRENCY} — clamping.`,
    );
  }

  return {
    manifestPath: values.manifest,
    voiceId: values["voice-id"],
    concurrency: Math.min(concurrency, MAX_CONCURRENCY),
    dryRun: values["dry-run"],
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadManifest(manifestPath) {
  const raw = manifestPath
    ? fs.readFileSync(manifestPath, "utf8")
    : await readStdin();

  if (!raw.trim()) {
    fatal(
      "No manifest provided — pass --manifest <file.json> or pipe a JSON array on stdin.",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    fatal(`Manifest is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(manifest)) {
    fatal("Manifest must be a JSON array of { path, text } objects.");
  }
  manifest.forEach((entry, i) => {
    if (typeof entry?.path !== "string" || typeof entry?.text !== "string") {
      fatal(`Manifest entry ${i} must have string "path" and "text" fields.`);
    }
  });

  return manifest;
}

// Splits the manifest into { toGenerate, skipped } — an existing target file
// is left untouched (and logged) rather than regenerated, so a re-run can
// never silently clobber a take that's already been picked.
function planTasks(manifest) {
  const toGenerate = [];
  const skipped = [];

  for (const entry of manifest) {
    const targetPath = path.resolve(ROOT, entry.path);
    if (fs.existsSync(targetPath)) {
      log(`SKIP (already exists): ${path.relative(ROOT, targetPath)}`);
      skipped.push({ ...entry, targetPath });
      continue;
    }
    toGenerate.push({ ...entry, targetPath });
  }

  return { toGenerate, skipped };
}

function printDryRun(toGenerate, skipped) {
  for (const task of toGenerate) {
    console.log(`${path.relative(ROOT, task.targetPath)}\t${JSON.stringify(task.text)}`);
  }
  console.log(
    `\n${toGenerate.length} line(s) would be generated (${skipped.length} already exist and would be skipped).`,
  );
}

async function generateOne(elevenlabs, voiceId, task) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stream = await elevenlabs.textToSpeech.convert(voiceId, {
        text: task.text,
        modelId: TTS_MODEL,
        outputFormat: OUTPUT_FORMAT,
      });
      const audio = Buffer.from(await new Response(stream).arrayBuffer());
      fs.mkdirSync(path.dirname(task.targetPath), { recursive: true });
      fs.writeFileSync(task.targetPath, audio);
      log(`OK: ${path.relative(ROOT, task.targetPath)}`);
      return { ...task, outcome: "generated", attempts: attempt };
    } catch (err) {
      const status = err?.statusCode;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (retryable && attempt < MAX_ATTEMPTS) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        log(
          `${path.relative(ROOT, task.targetPath)} attempt ${attempt} failed (status ${status}) — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }
      const message = err?.message ?? String(err);
      log(`FAILED: ${path.relative(ROOT, task.targetPath)} — ${message}`);
      return { ...task, outcome: "failed", attempts: attempt, error: message };
    }
  }
}

// Hand-rolled limited-concurrency pool, same shape as generate-stock-phrases.js:
// `concurrency` workers pull from a shared cursor over `toGenerate`, in order.
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

function printSummary(skipped, results) {
  const generated = results.filter((r) => r.outcome === "generated");
  const failed = results.filter((r) => r.outcome === "failed");

  console.log("\n--- Summary ---");
  console.log(`Generated: ${generated.length}`);
  for (const r of generated) console.log(`  OK    ${path.relative(ROOT, r.targetPath)}`);

  console.log(`Skipped (already existed): ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP  ${path.relative(ROOT, s.targetPath)}`);

  console.log(`Failed: ${failed.length}`);
  for (const r of failed) {
    console.log(`  FAIL  ${path.relative(ROOT, r.targetPath)} — ${r.error}`);
  }

  if (failed.length > 0) process.exitCode = 1;
}

async function main() {
  const args = parseCliArgs();
  const manifest = await loadManifest(args.manifestPath);
  const { toGenerate, skipped } = planTasks(manifest);

  if (args.dryRun) {
    printDryRun(toGenerate, skipped);
    return;
  }

  if (toGenerate.length === 0) {
    log(`Nothing to generate (${skipped.length} already exist).`);
    printSummary(skipped, []);
    return;
  }

  const elevenlabs = new ElevenLabsClient();
  const results = await runPool(toGenerate, args.concurrency, (task) =>
    generateOne(elevenlabs, args.voiceId, task),
  );

  printSummary(skipped, results);
}

main();
