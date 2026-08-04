import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempDir = await mkdtemp(join(tmpdir(), "attachment-imagebed-manager-test-"));
const output = join(tempDir, "auto-scan-policy.mjs");

try {
  await build({
    entryPoints: [join(root, "src", "auto-scan-policy.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const policy = await import(pathToFileURL(output).href);
  const {
    isFileQuiet,
    meetsAutoScanSize,
    normalizeScanIntervalMinutes,
    shouldScheduleAutoScan,
  } = policy;

  assert.equal(shouldScheduleAutoScan({ isMobile: false, enabled: true, autoScanEnabled: true }), true);
  assert.equal(shouldScheduleAutoScan({ isMobile: true, enabled: true, autoScanEnabled: true }), false);
  assert.equal(shouldScheduleAutoScan({ isMobile: false, enabled: false, autoScanEnabled: true }), false);
  assert.equal(shouldScheduleAutoScan({ isMobile: false, enabled: true, autoScanEnabled: false }), false);
  assert.equal(shouldScheduleAutoScan({ isMobile: false, enabled: true, autoScanEnabled: true, running: true }), false);

  assert.equal(normalizeScanIntervalMinutes(15), 15);
  assert.equal(normalizeScanIntervalMinutes(0), 30);
  assert.equal(normalizeScanIntervalMinutes(-5), 1);
  assert.equal(normalizeScanIntervalMinutes("invalid"), 30);

  const now = 1_000_000;
  assert.equal(isFileQuiet(now - 600_000, 600, now), true);
  assert.equal(isFileQuiet(now - 599_999, 600, now), false);
  assert.equal(isFileQuiet(now + 60_000, 600, now), false);
  assert.equal(isFileQuiet(now, 0, now), true);

  assert.equal(meetsAutoScanSize(0, 0), true);
  assert.equal(meetsAutoScanSize(1024 * 1024, 1), true);
  assert.equal(meetsAutoScanSize(1024 * 1024 - 1, 1), false);
  assert.equal(meetsAutoScanSize(0, "invalid"), true);

  console.log("Auto-scan policy tests passed (desktop/mobile, interval, quiet period, size threshold).");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
