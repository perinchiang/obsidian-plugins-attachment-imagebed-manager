import { App, Modal, Notice, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { VaultBatchPlan, VaultBatchProgress, VaultBatchResult } from "./types";
import { formatBytes } from "./utils";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function makeT(plugin: { t: (key: string, params?: Record<string, unknown>) => string }): TranslateFn {
  return (key, params) => plugin.t(key, params);
}

export class VaultBatchModal extends Modal {
  plugin: AttachmentImagebedManagerPlugin;
  plan: VaultBatchPlan;
  progressText: HTMLElement | null = null;
  running = false;

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin, plan: VaultBatchPlan) {
    super(app);
    this.plugin = plugin;
    this.plan = plan;
  }

  onOpen(): void {
    this.modalEl.addClass("attachment-imagebed-manager-modal");
    this.renderPlan();
  }

  renderPlan(): void {
    const t = makeT(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("batchTitle")).setHeading();
    contentEl.createEl("p", {
      text: t("batchSummary", {
        notes: this.plan.noteCount,
        files: this.plan.uniqueFileCount,
        links: this.plan.totalReferences,
        size: formatBytes(this.plan.totalBytes),
      }),
      cls: "attachment-imagebed-manager-summary",
    });
    if (this.plugin.isMobile) {
      contentEl.createEl("p", {
        text: t("mobileBatchHint"),
        cls: "attachment-imagebed-manager-mobile-hint",
      });
    }
    if (this.plan.scanFailures.length) {
      contentEl.createEl("p", {
        text: t("vaultScanFailures", { count: this.plan.scanFailures.length }),
        cls: "attachment-imagebed-manager-summary",
      });
    }
    const actions = contentEl.createDiv({ cls: "attachment-imagebed-manager-actions" });
    new Setting(actions)
      .addButton((button) => button.setButtonText(t("cancel")).onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText(t("batchStart")).setCta().onClick(() => void this.startBatch())
      );
  }

  async startBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.renderProgress();
    try {
      const result = await this.plugin.runVaultBatch(this.plan, (state) => this.updateProgress(state));
      this.renderResult(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Vault batch failed", error);
      new Notice(this.plugin.t("batchFailed", { error: message }), 10000);
      this.renderError(message);
    } finally {
      this.running = false;
    }
  }

  renderProgress(): void {
    const t = makeT(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("batchRunning")).setHeading();
    this.progressText = contentEl.createDiv({
      text: t("starting"),
      cls: "attachment-imagebed-manager-summary",
    });
  }

  updateProgress(state: VaultBatchProgress): void {
    if (!this.progressText) return;
    const t = makeT(this.plugin);
    const phaseMap: Record<string, string> = {
      scanning: t("batchPhaseScanning"),
      uploading: t("phaseUploading"),
      rewriting: t("phaseRewriting"),
      trashing: t("phaseTrashing"),
      scheduling: t("phaseScheduling"),
      done: t("phaseDone"),
    };
    const phase = phaseMap[state.phase] || state.phase;
    const position = state.total ? ` (${state.current}/${state.total})` : "";
    this.progressText.setText(`${phase}${position}: ${state.label || state.notePath}`);
  }

  renderResult(result: VaultBatchResult): void {
    const t = makeT(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("batchComplete")).setHeading();
    contentEl.createEl("p", {
      text: t("batchResultSummary", {
        notes: result.notesChanged,
        files: result.uploadedFiles,
        links: result.replacedLinks,
        deleted: result.deletedFiles,
        scheduled: result.scheduledFiles,
      }),
      cls: "attachment-imagebed-manager-summary",
    });
    if (result.protectedFiles) {
      contentEl.createEl("p", {
        text: t("batchProtectedFiles", { count: result.protectedFiles }),
        cls: "attachment-imagebed-manager-summary",
      });
    }
    if (result.failures.length) {
      contentEl.createEl("pre", {
        text: result.failures.map((failure) => `${failure.notePath}: ${failure.error}`).join("\n"),
        cls: "attachment-imagebed-manager-log",
      });
    }

    const actions = contentEl.createDiv({ cls: "attachment-imagebed-manager-actions" });
    if (result.pendingLocalFiles.length) {
      contentEl.createEl("p", {
        text: t("batchDeleteConfirm", { count: result.pendingLocalFiles.length }),
        cls: "attachment-imagebed-manager-summary",
      });
      new Setting(actions)
        .addButton((button) => button.setButtonText(t("keepLocal")).onClick(() => this.close()))
        .addButton((button) => {
          button.setButtonText(t("deleteLocal"));
          button.buttonEl.addClass("mod-warning");
          button.onClick(() => void this.deletePendingFiles(result.pendingLocalFiles));
        });
    } else {
      new Setting(actions).addButton((button) =>
        button.setButtonText(t("close")).onClick(() => this.close())
      );
    }
  }

  async deletePendingFiles(files: VaultBatchResult["pendingLocalFiles"]): Promise<void> {
    const t = makeT(this.plugin);
    let deleted = 0;
    try {
      for (const record of files) {
        const notePath = this.plugin.firstReferencingNote(record.path, this.plan) || "vault-batch";
        await this.plugin.deleteLocalFileRecords({ path: notePath }, [record], "manual-delete");
        deleted += 1;
      }
      new Notice(t("movedToTrash", { count: deleted }));
      this.close();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t("localDeleteFailed", { error: message }), 10000);
      this.renderError(message);
    }
  }

  renderError(message: string): void {
    const t = makeT(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("batchFailedTitle")).setHeading();
    contentEl.createEl("p", {
      text: message,
      cls: "attachment-imagebed-manager-summary",
    });
    new Setting(contentEl).addButton((button) =>
      button.setButtonText(t("close")).onClick(() => this.close())
    );
  }
}
