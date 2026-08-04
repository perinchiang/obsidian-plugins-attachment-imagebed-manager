import { App, Modal, Notice, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { FILE_CATEGORIES, getCategoryForExt } from "./file-categories";
import { Candidate, VaultBatchPlan } from "./types";
import { formatBytes } from "./utils";
import { VaultBatchModal } from "./vault-batch-modal";

interface AttachmentChoice {
  path: string;
  name: string;
  ext: string;
  sizeBytes: number;
  references: number;
  candidate: Candidate;
  category: string;
}

export class VaultBatchFilterModal extends Modal {
  plugin: AttachmentImagebedManagerPlugin;
  plan: VaultBatchPlan;
  selectedPaths = new Set<string>();
  activeCategory = "all";
  choices: AttachmentChoice[];

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin, plan: VaultBatchPlan) {
    super(app);
    this.plugin = plugin;
    this.plan = plan;
    this.choices = this.buildChoices(plan);
    for (const choice of this.choices) this.selectedPaths.add(choice.path);
  }

  onOpen(): void {
    this.modalEl.addClass("attachment-imagebed-manager-modal");
    this.render();
  }

  buildChoices(plan: VaultBatchPlan): AttachmentChoice[] {
    const byPath = new Map<string, AttachmentChoice>();
    for (const item of plan.items) {
      for (const candidate of item.candidates) {
        const existing = byPath.get(candidate.file.path);
        if (existing) {
          existing.references += candidate.refs.length;
          continue;
        }
        const category = getCategoryForExt(candidate.ext);
        byPath.set(candidate.file.path, {
          path: candidate.file.path,
          name: candidate.file.name,
          ext: candidate.ext,
          sizeBytes: candidate.sizeBytes,
          references: candidate.refs.length,
          candidate,
          category: category?.id || "other",
        });
      }
    }
    return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  categoryLabel(category: string): string {
    if (category === "all") return this.plugin.t("filterAll");
    if (category === "other") return this.plugin.t("filterOther");
    const definition = FILE_CATEGORIES.find((entry) => entry.id === category);
    return definition ? this.plugin.t(definition.nameKey) : category;
  }

  visibleChoices(): AttachmentChoice[] {
    if (this.activeCategory === "all") return this.choices;
    return this.choices.filter((choice) => choice.category === this.activeCategory);
  }

  render(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(this.plugin.t("batchFilterTitle")).setHeading();
    contentEl.createEl("p", {
      text: this.plugin.t("batchFilterSummary", {
        selected: this.selectedPaths.size,
        total: this.choices.length,
      }),
      cls: "attachment-imagebed-manager-summary",
    });
    if (this.plugin.isMobile) {
      contentEl.createEl("p", {
        text: this.plugin.t("mobileBatchHint"),
        cls: "attachment-imagebed-manager-mobile-hint",
      });
    }

    const categories = contentEl.createDiv({
      cls: "attachment-imagebed-manager-batch-filter-categories",
    });
    const categoryIds = ["all", ...FILE_CATEGORIES.map((entry) => entry.id), "other"];
    for (const category of categoryIds) {
      const count = category === "all"
        ? this.choices.length
        : this.choices.filter((choice) => choice.category === category).length;
      if (category !== "all" && count === 0) continue;
      const button = categories.createEl("button", {
        text: `${this.categoryLabel(category)} ${count}`,
        cls: "attachment-imagebed-manager-batch-filter-category",
      });
      if (category === this.activeCategory) button.addClass("is-active");
      button.addEventListener("click", () => {
        this.activeCategory = category;
        this.render();
      });
    }

    const visible = this.visibleChoices();
    const toolbar = contentEl.createDiv({ cls: "attachment-imagebed-manager-batch-filter-toolbar" });
    const visibleSelected = visible.filter((choice) => this.selectedPaths.has(choice.path)).length;
    const selectAll = toolbar.createEl("label", {
      cls: "attachment-imagebed-manager-select-all",
    });
    const selectAllInput = selectAll.createEl("input", { type: "checkbox" });
    selectAllInput.checked = visible.length > 0 && visibleSelected === visible.length;
    selectAllInput.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    selectAllInput.addEventListener("change", () => {
      for (const choice of visible) {
        if (selectAllInput.checked) this.selectedPaths.add(choice.path);
        else this.selectedPaths.delete(choice.path);
      }
      this.render();
    });
    selectAll.createSpan({ text: this.plugin.t("batchFilterSelectAll") });
    const clearButton = toolbar.createEl("button", {
      text: this.plugin.t("batchFilterClearAll"),
      cls: "mod-muted",
    });
    clearButton.addEventListener("click", () => {
      this.selectedPaths.clear();
      this.render();
    });

    const list = contentEl.createDiv({ cls: "attachment-imagebed-manager-batch-filter-list" });
    if (!visible.length) {
      list.createEl("p", {
        text: this.plugin.t("batchFilterNoVisible"),
        cls: "attachment-imagebed-manager-summary",
      });
    }
    for (const choice of visible) {
      const row = list.createDiv({ cls: "attachment-imagebed-manager-batch-filter-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selectedPaths.has(choice.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedPaths.add(choice.path);
        else this.selectedPaths.delete(choice.path);
        this.render();
      });
      const details = row.createDiv({ cls: "attachment-imagebed-manager-batch-filter-details" });
      details.createDiv({ text: choice.name, cls: "attachment-imagebed-manager-batch-filter-name" });
      details.createDiv({
        text: choice.path,
        cls: "attachment-imagebed-manager-batch-filter-path",
      });
      const meta = row.createDiv({ cls: "attachment-imagebed-manager-batch-filter-meta" });
      meta.createSpan({ text: formatBytes(choice.sizeBytes) });
      meta.createSpan({ text: `${choice.ext.toUpperCase()} · ${choice.references}` });
    }

    const actions = contentEl.createDiv({ cls: "attachment-imagebed-manager-actions" });
    new Setting(actions)
      .addButton((button) => button.setButtonText(this.plugin.t("cancel")).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.plugin.t("batchFilterStart"))
          .setCta()
          .onClick(() => void this.startBatch())
      );
  }

  startBatch(): void {
    if (this.selectedPaths.size === 0) {
      new Notice(this.plugin.t("batchFilterNoSelection"));
      return;
    }
    const items = this.plan.items
      .map((item) => ({
        noteFile: item.noteFile,
        candidates: item.candidates.filter((candidate) => this.selectedPaths.has(candidate.file.path)),
      }))
      .filter((item) => item.candidates.length > 0);
    const selectedFiles = new Map<string, Candidate>();
    let totalReferences = 0;
    for (const item of items) {
      for (const candidate of item.candidates) {
        selectedFiles.set(candidate.file.path, candidate);
        totalReferences += candidate.refs.length;
      }
    }
    const filteredPlan: VaultBatchPlan = {
      items,
      noteCount: items.length,
      uniqueFileCount: selectedFiles.size,
      totalBytes: Array.from(selectedFiles.values()).reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
      totalReferences,
      scanFailures: [...this.plan.scanFailures],
      referencesBySource: this.plan.referencesBySource,
    };
    this.close();
    new VaultBatchModal(this.app, this.plugin, filteredPlan).open();
  }
}
