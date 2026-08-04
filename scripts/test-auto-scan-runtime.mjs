import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempDir = await mkdtemp(join(tmpdir(), "attachment-imagebed-manager-runtime-test-"));
const output = join(tempDir, "plugin.mjs");
const mockPath = fileURLToPath(new URL("./obsidian-runtime-mock.mjs", import.meta.url));
const intervals = [];
const cleared = [];

globalThis.window = {
  setInterval(callback, delay) {
    const timer = { callback, delay };
    intervals.push(timer);
    return timer;
  },
  clearInterval(timer) {
    cleared.push(timer);
  },
};

try {
  await build({
    entryPoints: [join(root, "src", "plugin.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    plugins: [{
      name: "mock-obsidian",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: mockPath }));
      },
    }],
  });

  const { default: PluginClass } = await import(pathToFileURL(output).href);
  const { TFile } = await import(pathToFileURL(mockPath).href);
  const plugin = new PluginClass();
  plugin.settings = { enabled: true, autoScanEnabled: true, scanIntervalMinutes: 15 };
  plugin.isMobile = false;
  plugin.configureAutoScan();
  assert.equal(intervals.length, 1, "desktop should create an auto-scan timer");
  assert.equal(intervals[0].delay, 15 * 60 * 1000, "desktop timer should use configured minutes");

  plugin.isMobile = true;
  plugin.configureAutoScan();
  assert.equal(plugin.autoScanTimer, null, "mobile should not retain an auto-scan timer");
  assert.equal(cleared.length, 1, "switching off desktop scheduling should clear the old timer");

  let ensureCalls = 0;
  plugin.ensureS3Settings = () => {
    ensureCalls += 1;
    throw new Error("missing S3");
  };
  await plugin.runAutoScan();
  assert.equal(ensureCalls, 0, "mobile runAutoScan should be a no-op");

  plugin.isMobile = false;
  await plugin.runAutoScan();
  assert.equal(ensureCalls, 1, "desktop runAutoScan should validate S3 once");
  assert.equal(plugin.autoScanRunning, false, "failed desktop run should release its running guard");

  plugin.autoScanRunning = true;
  await plugin.runAutoScan();
  assert.equal(ensureCalls, 1, "overlapping auto scans should be ignored");

  const attachment = new TFile();
  attachment.path = "99 Attachments/shared.png";
  const note = new TFile();
  note.path = "Notes/other.md";
  note.extension = "md";
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => path === attachment.path ? attachment : null,
      getMarkdownFiles: () => [note],
      read: async () => "![[99 Attachments/shared.png]]",
    },
  };
  plugin.resolveLinkedFile = (target) => target === attachment.path ? attachment : null;
  assert.equal(await plugin.isLocalFileReferenced(attachment.path), true, "shared local files should be protected");
  plugin.app.vault.read = async () => "No local attachment";
  assert.equal(await plugin.isLocalFileReferenced(attachment.path), false, "unreferenced local files may be deleted");

  plugin.settings.autoDeleteDelayHours = 1;
  plugin.settings.logs = [];
  plugin.settings.pendingDeletes = [{
    createdAt: new Date(0).toISOString(),
    dueAt: 0,
    notePath: "Notes/other.md",
    sourcePath: attachment.path,
    remoteUrl: "https://example.test/shared.png",
  }];
  plugin.saveSettings = async () => {};
  let deleteCalls = 0;
  plugin.deleteLocalFileRecords = async () => {
    deleteCalls += 1;
  };
  plugin.app.vault.read = async () => "![[99 Attachments/shared.png]]";
  await plugin.processPendingDeletes();
  assert.equal(deleteCalls, 0, "due shared files should not be deleted");
  assert.equal(plugin.settings.pendingDeletes.length, 1, "protected deletes should be retried later");

  plugin.settings.pendingDeletes[0].dueAt = 0;
  plugin.app.vault.read = async () => "No local attachment";
  await plugin.processPendingDeletes();
  assert.equal(deleteCalls, 1, "unreferenced due files should be deleted");
  assert.equal(plugin.settings.pendingDeletes.length, 0, "completed deletes should leave the queue");

  console.log("Auto-scan runtime tests passed (desktop timer, mobile no-op, overlap guard, S3 guard, delete protection).");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
