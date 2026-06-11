import { App, Modal, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function makeT(plugin: { t: (key: string, params?: Record<string, unknown>) => string }): TranslateFn {
  return (key, params) => plugin.t(key, params);
}

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
    const t = makeT(this.plugin);
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
