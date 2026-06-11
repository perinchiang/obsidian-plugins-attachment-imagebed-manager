import { App, Modal, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export class DryRunModal extends Modal {
  plugin: AttachmentImagebedManagerPlugin;
  count: number;
  samples: string[];

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin, count: number, samples: string[]) {
    super(app);
    this.plugin = plugin;
    this.count = count;
    this.samples = samples;
  }

  onOpen(): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("vaultScanTitle")).setHeading();
    contentEl.createEl("p", { text: t("vaultScanFound", { count: this.count }) });
    if (this.samples.length) {
      contentEl.createEl("pre", {
        text: this.samples.join("\n"),
        cls: "attachment-imagebed-manager-log",
      });
    }
  }
}
