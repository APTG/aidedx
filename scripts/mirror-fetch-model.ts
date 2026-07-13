/**
 * Two-phase local staging for an S3-compatible model mirror (issue #34 / #9):
 *
 *   Phase 1 — fetch from Hugging Face to local disk (`.hf-cache/`)
 *   Phase 2 — restage that into the upload-ready layout (`mirror-staging/`)
 *
 * Phase 1 reuses the exact same mechanism as `scripts/prefetch-whisper-models.mjs`
 * (`env.cacheDir` + the real `from_pretrained()` loaders), rather than a
 * hand-maintained file list or plain `curl`/`wget` of guessed URLs — the
 * dtype→file mapping is transformers.js's own internal logic (e.g. `q8` →
 * `*_quantized.onnx`, not every dtype variant in the repo) and would silently
 * drift from a hardcoded list if that mapping ever changes. Already-cached
 * files are reused, not re-downloaded — safe to re-run.
 *
 * Phase 2 exists because Node's on-disk cache layout is flat
 * (`<org>/<repo>/<file>`, confirmed by inspecting `FileCache.js` and by
 * direct probing) — it does NOT match the remote URL layout the browser
 * fetches from. `env.remotePathTemplate` defaults to
 * `{model}/resolve/{revision}/`, so the actual browser request is
 * `<remoteHost>/<org>/<repo>/resolve/<revision>/<file>`. Phase 2 copies each
 * file into that layout so `mirror-staging/` can be `s3cmd sync`'d to a
 * bucket root as a byte-for-byte drop-in replacement for huggingface.co (see
 * docs/model-hosting-cyfronet.md).
 *
 * Usage:
 *   node scripts/mirror-fetch-model.ts <repo> <dtype> [options]
 *
 * Options:
 *   --kind=asr|causal-lm   Which from_pretrained pair to use (default: asr)
 *   --out=<dir>            Staging directory (default: ./mirror-staging)
 *   --revision=<rev>       Model revision (default: main)
 *
 * Example (the whisper-small q8 mirror this issue starts with):
 *   node scripts/mirror-fetch-model.ts onnx-community/whisper-small q8
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [repo, dtype] = positional;
  if (!repo || !dtype) {
    console.error("Usage: node scripts/mirror-fetch-model.ts <repo> <dtype> [options]");
    process.exit(1);
  }

  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    if (key) flags.set(key, value ?? "true");
  }

  return {
    repo,
    dtype,
    kind: flags.get("kind") ?? "asr",
    outDir: path.resolve(PROJECT_ROOT, flags.get("out") ?? "mirror-staging"),
    revision: flags.get("revision") ?? "main",
  };
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const { repo, dtype, kind, outDir, revision } = parseArgs(process.argv.slice(2));

  const { env } = await import("@huggingface/transformers");
  env.cacheDir = path.join(PROJECT_ROOT, ".hf-cache");
  env.allowLocalModels = false;

  console.log("=== Phase 1: fetch from Hugging Face -> local .hf-cache/ ===");
  console.log(`Repo:      ${repo}`);
  console.log(`Dtype:     ${dtype}`);
  console.log(`Cache dir: ${env.cacheDir}`);
  console.log("(already-cached files are reused, not re-downloaded)\n");

  if (kind === "asr") {
    const { AutoProcessor, WhisperForConditionalGeneration } =
      await import("@huggingface/transformers");
    await AutoProcessor.from_pretrained(repo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dtype is validated by from_pretrained itself
    await WhisperForConditionalGeneration.from_pretrained(repo, { dtype: dtype as any });
  } else if (kind === "causal-lm") {
    const { AutoTokenizer, AutoModelForCausalLM } = await import("@huggingface/transformers");
    await AutoTokenizer.from_pretrained(repo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dtype is validated by from_pretrained itself
    await AutoModelForCausalLM.from_pretrained(repo, { dtype: dtype as any });
  } else {
    console.error(`Unknown --kind=${kind}. Expected "asr" or "causal-lm".`);
    process.exit(1);
  }

  const repoRoot = path.join(env.cacheDir, repo);
  const files = walkFiles(repoRoot);
  if (files.length === 0) {
    console.error(`No files found under ${repoRoot} — did from_pretrained() fail silently?`);
    process.exit(1);
  }

  let fetchedBytes = 0;
  for (const file of files) fetchedBytes += statSync(file).size;
  console.log(`Fetched ${files.length} files, ${formatMB(fetchedBytes)}, now sitting at:`);
  console.log(`  ${repoRoot}/\n`);

  console.log(`=== Phase 2: restage for upload -> ${outDir} ===\n`);
  const stagingRepoRoot = path.join(outDir, repo, "resolve", revision);
  mkdirSync(stagingRepoRoot, { recursive: true });

  let totalBytes = 0;
  console.log(`Copying into ${stagingRepoRoot}:\n`);
  for (const file of files) {
    const relative = path.relative(repoRoot, file);
    const dest = path.join(stagingRepoRoot, relative);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(file, dest);
    const size = statSync(file).size;
    totalBytes += size;
    console.log(`  ${formatMB(size).padStart(10)}  ${relative}`);
  }

  console.log(`\nTotal: ${files.length} files, ${formatMB(totalBytes)}`);
  console.log(`\nStaged at: ${stagingRepoRoot}`);
  console.log(`Upload the *contents* of ${outDir} to the bucket root with s3cmd, e.g.:`);
  console.log(`  scripts/mirror-upload-s3.sh ${outDir}`);
  console.log(
    `\nOnce uploaded, point the app at the mirror by setting env.remoteHost to your bucket's ` +
      `public base URL (see docs/model-hosting-cyfronet.md) — no other code changes needed, ` +
      `since env.remotePathTemplate ("{model}/resolve/{revision}/") already matches this layout.`,
  );
}

await main();
