import { App, Modal, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { VaultBatchPlan } from "./types";
import { formatBytes } from "./utils";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function makeT(plugin: { t: (key: string, params?: Record<string, unknown>) => string }): TranslateFn {
  return (key, params) => plugin.t(key, params);
}

export class DryRunModal extends Modal {
  plugin: AttachmentImagebedManagerPlugin;
  plan: VaultBatchPlan;

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin, plan: VaultBatchPlan) {
    super(app);
    this.plugin = plugin;
    this.plan = plan;
  }

  onOpen(): void {
    const t = makeT(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("vaultScanTitle")).setHeading();
    contentEl.createEl("p", {
      text: t("vaultScanSummary", {
        notes: this.plan.noteCount,
        files: this.plan.uniqueFileCount,
        links: this.plan.totalReferences,
        size: formatBytes(this.plan.totalBytes),
      }),
    });
    const samples = this.plan.items
      .flatMap((item) => item.candidates.slice(0, 3).map((candidate) => `${item.noteFile.path} -> ${candidate.file.path}`))
      .slice(0, 20);
    if (samples.length) {
      contentEl.createEl("pre", {
        text: samples.join("\n"),
        cls: "attachment-imagebed-manager-log",
      });
    }
    if (this.plan.scanFailures.length) {
      contentEl.createEl("p", {
        text: t("vaultScanFailures", { count: this.plan.scanFailures.length }),
        cls: "attachment-imagebed-manager-summary",
      });
    }
  }
}
