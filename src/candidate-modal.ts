import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { Candidate, ProgressState, LocalFileRecord } from "./types";
import { formatBytes, isPreviewableImage } from "./utils";
import { FILE_CATEGORIES, getCategoryForExt } from "./file-categories";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;
type ViewMode = "list" | "gallery";

const CATEGORY_ICONS: Record<string, string> = {
  image: "\ud83d\udcf7",
  video: "\ud83c\udfac",
  audio: "\ud83c\udfb5",
  document: "\ud83d\udcc4",
};

export class CandidateModal extends Modal {
  plugin: AttachmentImagebedManagerPlugin;
  noteFile: TFile;
  candidates: Candidate[];
  selected: Set<string>;
  viewMode: ViewMode = "list";
  activeFilter: string = "all";
  progressBar: HTMLProgressElement | null = null;
  progressText: HTMLElement | null = null;

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin, noteFile: TFile, candidates: Candidate[]) {
    super(app);
    this.plugin = plugin;
    this.noteFile = noteFile;
    this.candidates = candidates;
    this.selected = new Set(candidates.map((c) => c.file.path));
  }

  onOpen(): void {
    this.modalEl.addClass("attachment-imagebed-manager-modal");
    this.renderContent();
  }

  private getFilteredCandidates(): Candidate[] {
    if (this.activeFilter === "all") return this.candidates;
    return this.candidates.filter((c) => {
      const cat = getCategoryForExt(c.ext);
      return cat?.id === this.activeFilter;
    });
  }

  private getCategoryCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    counts.set("all", this.candidates.length);
    for (const c of this.candidates) {
      const cat = getCategoryForExt(c.ext);
      const id = cat?.id || "other";
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }

  private renderContent(): void {
    const { contentEl } = this;
    contentEl.empty();
    const t: TranslateFn = this.plugin.t.bind(this.plugin);

    new Setting(contentEl).setName(t("replaceTitle")).setHeading();
    contentEl.createEl("p", {
      text: t("candidateSummary", { path: this.noteFile.path, count: this.candidates.length }),
      cls: "attachment-imagebed-manager-summary",
    });

    // Main layout: sidebar + content
    const layout = contentEl.createDiv({ cls: "attachment-imagebed-manager-modal-layout" });

    // Left sidebar: category filter
    this.renderSidebar(layout);

    // Right content: view toggle + list/gallery + actions
    const rightPanel = layout.createDiv({ cls: "attachment-imagebed-manager-modal-main" });
    this.renderViewToggle(rightPanel);

    const filtered = this.getFilteredCandidates();
    if (this.viewMode === "list") {
      this.renderListView(rightPanel, filtered);
    } else {
      this.renderGalleryView(rightPanel, filtered);
    }

    // Bottom bar: select all + actions
    const bottomBar = rightPanel.createDiv({ cls: "attachment-imagebed-manager-bottom-bar" });
    const selectAllLabel = bottomBar.createEl("label", { cls: "attachment-imagebed-manager-select-all" });
    const selectAllCb = selectAllLabel.createEl("input", { type: "checkbox" });
    const filteredPaths = new Set(filtered.map((c) => c.file.path));
    selectAllCb.checked = filteredPaths.size > 0 && [...filteredPaths].every((p) => this.selected.has(p));
    selectAllCb.addEventListener("change", () => {
      if (selectAllCb.checked) {
        for (const p of filteredPaths) this.selected.add(p);
      } else {
        for (const p of filteredPaths) this.selected.delete(p);
      }
      this.renderContent();
    });
    selectAllLabel.createSpan({ text: t("selectAll") });

    const actions = bottomBar.createDiv({ cls: "attachment-imagebed-manager-actions" });
    new Setting(actions)
      .addButton((button) =>
        button.setButtonText(t("cancel")).onClick(() => this.close())
      )
      .addButton((button) =>
        button.setButtonText(t("uploadReplace")).setCta().onClick(() => this.replaceSelected())
      );
  }

  private renderSidebar(containerEl: HTMLElement): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const counts = this.getCategoryCounts();
    const sidebar = containerEl.createDiv({ cls: "attachment-imagebed-manager-sidebar" });

    // "All" filter
    const allItem = sidebar.createDiv({
      cls: `attachment-imagebed-manager-sidebar-item${this.activeFilter === "all" ? " attachment-imagebed-manager-sidebar-active" : ""}`,
    });
    allItem.createSpan({ text: t("filterAll") });
    allItem.createSpan({ text: String(counts.get("all") || 0), cls: "attachment-imagebed-manager-sidebar-count" });
    allItem.addEventListener("click", () => {
      this.activeFilter = "all";
      this.renderContent();
    });

    // Category filters
    for (const cat of FILE_CATEGORIES) {
      const count = counts.get(cat.id);
      if (!count) continue;
      const item = sidebar.createDiv({
        cls: `attachment-imagebed-manager-sidebar-item${this.activeFilter === cat.id ? " attachment-imagebed-manager-sidebar-active" : ""}`,
      });
      const icon = CATEGORY_ICONS[cat.id] || "";
      item.createSpan({ text: `${icon} ${t(cat.nameKey)}` });
      item.createSpan({ text: String(count), cls: "attachment-imagebed-manager-sidebar-count" });
      item.addEventListener("click", () => {
        this.activeFilter = cat.id;
        this.renderContent();
      });
    }

    // "Other" filter for uncategorized extensions
    const otherCount = counts.get("other");
    if (otherCount) {
      const item = sidebar.createDiv({
        cls: `attachment-imagebed-manager-sidebar-item${this.activeFilter === "other" ? " attachment-imagebed-manager-sidebar-active" : ""}`,
      });
      item.createSpan({ text: t("filterOther") });
      item.createSpan({ text: String(otherCount), cls: "attachment-imagebed-manager-sidebar-count" });
      item.addEventListener("click", () => {
        this.activeFilter = "other";
        this.renderContent();
      });
    }
  }

  private renderViewToggle(containerEl: HTMLElement): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const toggleEl = containerEl.createDiv({ cls: "attachment-imagebed-manager-view-toggle" });

    const listBtn = toggleEl.createEl("button", {
      text: t("viewList"),
      cls: this.viewMode === "list" ? "attachment-imagebed-manager-view-btn-active" : "",
    });
    const galleryBtn = toggleEl.createEl("button", {
      text: t("viewGallery"),
      cls: this.viewMode === "gallery" ? "attachment-imagebed-manager-view-btn-active" : "",
    });

    listBtn.addEventListener("click", () => {
      if (this.viewMode !== "list") {
        this.viewMode = "list";
        this.renderContent();
      }
    });
    galleryBtn.addEventListener("click", () => {
      if (this.viewMode !== "gallery") {
        this.viewMode = "gallery";
        this.renderContent();
      }
    });
  }

  private renderListView(containerEl: HTMLElement, filtered: Candidate[]): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const list = containerEl.createDiv({ cls: "attachment-imagebed-manager-list" });
    for (const candidate of filtered) {
      const row = list.createDiv({ cls: "attachment-imagebed-manager-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(candidate.file.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(candidate.file.path);
        else this.selected.delete(candidate.file.path);
      });
      row.appendChild(this.createPreview(candidate));
      const body = row.createDiv();
      body.createDiv({ text: candidate.file.name, cls: "attachment-imagebed-manager-title" });
      body.createDiv({
        text: `${candidate.file.path} \u00b7 ${formatBytes(candidate.sizeBytes)} \u00b7 ${t("referenceCount", { count: candidate.referenceCount })}`,
        cls: "attachment-imagebed-manager-meta",
      });
      row.createDiv({
        text: candidate.replacement,
        cls: "attachment-imagebed-manager-meta",
      });
    }
  }

  private renderGalleryView(containerEl: HTMLElement, filtered: Candidate[]): void {
    const gallery = containerEl.createDiv({ cls: "attachment-imagebed-manager-gallery" });
    for (const candidate of filtered) {
      const card = gallery.createDiv({ cls: "attachment-imagebed-manager-gallery-card" });

      const previewArea = card.createDiv({ cls: "attachment-imagebed-manager-gallery-preview" });
      if (isPreviewableImage(candidate.file.extension)) {
        const image = previewArea.createEl("img");
        image.src = this.app.vault.getResourcePath(candidate.file);
        image.alt = candidate.file.name;
        image.loading = "lazy";
      } else {
        const badge = previewArea.createDiv({ cls: "attachment-imagebed-manager-gallery-badge" });
        badge.textContent = candidate.file.extension.toUpperCase();
      }

      const info = card.createDiv({ cls: "attachment-imagebed-manager-gallery-info" });
      const checkbox = info.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(candidate.file.path);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(candidate.file.path);
        else this.selected.delete(candidate.file.path);
      });
      info.createDiv({ text: candidate.file.name, cls: "attachment-imagebed-manager-gallery-name" });
      info.createDiv({
        text: formatBytes(candidate.sizeBytes),
        cls: "attachment-imagebed-manager-gallery-size",
      });
    }
  }

  createPreview(candidate: Candidate): HTMLElement {
    const preview = document.createElement("div");
    preview.className = "attachment-imagebed-manager-preview";
    if (isPreviewableImage(candidate.file.extension)) {
      const image = document.createElement("img");
      image.src = this.app.vault.getResourcePath(candidate.file);
      image.alt = candidate.file.name;
      image.loading = "lazy";
      preview.appendChild(image);
      return preview;
    }
    const badge = document.createElement("div");
    badge.className = "attachment-imagebed-manager-file-badge";
    badge.textContent = candidate.file.extension.toUpperCase();
    preview.appendChild(badge);
    return preview;
  }

  async replaceSelected(): Promise<void> {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const chosen = this.candidates.filter((c) => this.selected.has(c.file.path));
    if (!chosen.length) {
      new Notice(t("noSelected"));
      return;
    }
    this.renderProgress(chosen.length);
    try {
      const result = await this.plugin.replaceCandidates(this.noteFile, chosen, (state) => {
        this.updateProgress(state);
      });
      new Notice(t("replacedNotice", { count: result.replaced }));
      this.renderDeleteConfirmation(result.localFiles || []);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Attachment replacement failed", error);
      new Notice(t("replaceFailed", { error: message }), 10000);
      this.renderError(error instanceof Error ? error : new Error(message));
    }
  }

  renderProgress(total: number): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("uploadingTitle")).setHeading();
    contentEl.createEl("p", {
      text: t("preparing", { count: total }),
      cls: "attachment-imagebed-manager-summary",
    });
    this.progressBar = contentEl.createEl("progress", {
      cls: "attachment-imagebed-manager-progress",
    });
    this.progressBar.max = 100;
    this.progressBar.value = 0;
    this.progressText = contentEl.createDiv({
      text: t("starting"),
      cls: "attachment-imagebed-manager-meta",
    });
  }

  updateProgress(state: ProgressState): void {
    if (!this.progressBar || !this.progressText) return;
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const total = Math.max(1, state.total || 1);
    const value = Math.min(100, Math.round(((state.current || 0) / total) * 100));
    this.progressBar.value = value;
    const phaseMap: Record<string, string> = {
      uploading: t("phaseUploading"),
      uploaded: t("phaseUploaded"),
      rewriting: t("phaseRewriting"),
      trashing: t("phaseTrashing"),
      scheduling: t("phaseScheduling"),
      done: t("phaseDone"),
    };
    const phaseText = phaseMap[state.phase] || state.phase;
    this.progressText.setText(`${phaseText}: ${state.label || ""} (${state.current || 0}/${total})`);
  }

  renderDeleteConfirmation(localFiles: LocalFileRecord[]): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("linksReplacedTitle")).setHeading();
    contentEl.createEl("p", {
      text: t("linksReplacedDesc"),
      cls: "attachment-imagebed-manager-summary",
    });
    if (localFiles.length) {
      const list = contentEl.createDiv({ cls: "attachment-imagebed-manager-delete-list" });
      for (const fileRecord of localFiles) {
        list.createDiv({
          text: `${fileRecord.name} \u00b7 ${fileRecord.path}`,
          cls: "attachment-imagebed-manager-meta",
        });
      }
    }
    const actions = contentEl.createDiv({ cls: "attachment-imagebed-manager-actions" });
    new Setting(actions)
      .addButton((button) =>
        button.setButtonText(t("keepLocal")).onClick(() => this.close())
      )
      .addButton((button) =>
        button
          .setButtonText(t("deleteLocal"))
          .setDestructive()
          .onClick(async () => {
            try {
              await this.plugin.deleteLocalFileRecords(this.noteFile, localFiles, "manual-delete");
              new Notice(t("movedToTrash", { count: localFiles.length }));
              this.close();
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              console.error("Attachment local delete failed", error);
              new Notice(t("localDeleteFailed", { error: message }), 10000);
              this.renderError(error instanceof Error ? error : new Error(message));
            }
          })
      );
  }

  renderError(error: Error): void {
    const t: TranslateFn = this.plugin.t.bind(this.plugin);
    const { contentEl } = this;
    contentEl.createEl("p", {
      text: error.message || String(error),
      cls: "attachment-imagebed-manager-summary",
    });
    const actions = contentEl.createDiv({ cls: "attachment-imagebed-manager-actions" });
    new Setting(actions).addButton((button) =>
      button.setButtonText(t("close")).onClick(() => this.close())
    );
  }
}
