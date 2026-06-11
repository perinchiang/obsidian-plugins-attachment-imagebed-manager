import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type AttachmentImagebedManagerPlugin from "./plugin";
import { FILE_CATEGORIES } from "./file-categories";
import { FileCategory, DeletePolicy, S3Provider, S3Config } from "./types";
import { debounce } from "./utils";
import { testS3Connection } from "./s3-client";

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function makeT(plugin: { t: (key: string, params?: Record<string, unknown>) => string }): TranslateFn {
  return (key, params) => plugin.t(key, params);
}

const CATEGORY_ICONS: Record<string, string> = {
  image: "\ud83d\udcf7",
  video: "\ud83c\udfac",
  audio: "\ud83c\udfb5",
  document: "\ud83d\udcc4",
};

export class AttachmentImagebedSettingTab extends PluginSettingTab {
  plugin: AttachmentImagebedManagerPlugin;

  constructor(app: App, plugin: AttachmentImagebedManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const t = makeT(this.plugin);

    new Setting(containerEl).setName(t("settingsTitle")).setHeading();
    this.renderSetupStatus(containerEl);
    this.renderS3Settings(containerEl);
    this.renderGeneralSettings(containerEl);
    if (!this.plugin.isMobile && this.plugin.settings.autoScanEnabled) {
      this.renderFileTypeSettings(containerEl);
    }
    this.renderLogSection(containerEl);
  }

  private isS3Configured(): boolean {
    const s3 = this.plugin.settings.s3;
    return !!(
      s3.endpoint.trim() &&
      s3.bucketName.trim() &&
      s3.accessKeyId.trim() &&
      s3.secretAccessKey.trim() &&
      s3.customDomainName.trim()
    );
  }

  private renderSetupStatus(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    const configured = this.isS3Configured();
    const statusEl = containerEl.createDiv({ cls: "attachment-imagebed-manager-status" });
    const icon = statusEl.createEl("span", {
      cls: configured
        ? "attachment-imagebed-manager-status-ok"
        : "attachment-imagebed-manager-status-warn",
    });
    icon.textContent = configured ? "\u2705" : "\u26a0\ufe0f";
    statusEl.createSpan({
      text: configured ? t("setupComplete") : t("setupIncomplete"),
    });
  }

  private renderS3Settings(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    const save = () => this.plugin.saveSettings();
    const debouncedSave = debounce(save, 500);

    new Setting(containerEl).setName(t("s3Storage")).setHeading();
    containerEl.createEl("p", {
      text: t("s3SetupGuide"),
      cls: "attachment-imagebed-manager-guide",
    });

    new Setting(containerEl)
      .setName(t("provider"))
      .setDesc(t("providerDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("r2", t("providerR2"))
          .addOption("s3", t("providerS3"))
          .addOption("minio", t("providerMinio"))
          .addOption("custom", t("providerCustom"))
          .setValue(this.plugin.settings.s3.provider)
          .onChange((value) => {
            const provider = value as S3Provider;
            this.plugin.settings.s3.provider = provider;
            if (provider === "r2") {
              this.plugin.settings.s3.region = "auto";
            } else if (!this.plugin.settings.s3.region || this.plugin.settings.s3.region === "auto") {
              this.plugin.settings.s3.region = "us-east-1";
            }
            void save();
            this.display();
          })
      );

    if (this.plugin.settings.s3.provider !== "r2") {
      new Setting(containerEl)
        .setName(t("region"))
        .setDesc(t("regionDesc"))
        .addText((text) =>
          text.setValue(this.plugin.settings.s3.region).onChange((value) => {
            this.plugin.settings.s3.region = value.trim() || "us-east-1";
            void debouncedSave();
          })
        );
    }

    const s3Fields: Array<[string, string, string, boolean]> = [
      ["endpoint", t("endpoint"), t("endpointDesc"), false],
      ["bucketName", t("bucketName"), t("bucketNameDesc"), false],
      ["accessKeyId", t("accessKeyId"), t("accessKeyIdDesc"), false],
      ["secretAccessKey", t("secretAccessKey"), "", true],
      ["customDomainName", t("publicDomain"), t("publicDomainDesc"), false],
    ];

    for (const [key, label, desc, isPassword] of s3Fields) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addText((text) => {
          if (isPassword) text.inputEl.type = "password";
          text.setPlaceholder(isPassword ? "********" : "");
          const s3Key = key as keyof S3Config;
          text.setValue(String(this.plugin.settings.s3[s3Key] || "")).onChange((value) => {
            const trimmed = value.trim();
            switch (s3Key) {
              case "endpoint": this.plugin.settings.s3.endpoint = trimmed; break;
              case "bucketName": this.plugin.settings.s3.bucketName = trimmed; break;
              case "accessKeyId": this.plugin.settings.s3.accessKeyId = trimmed; break;
              case "secretAccessKey": this.plugin.settings.s3.secretAccessKey = trimmed; break;
              case "customDomainName": this.plugin.settings.s3.customDomainName = trimmed; break;
              case "pathTemplate": this.plugin.settings.s3.pathTemplate = trimmed; break;
              case "provider": this.plugin.settings.s3.provider = trimmed as S3Provider; break;
              case "region": this.plugin.settings.s3.region = trimmed; break;
            }
            void debouncedSave();
          });
        });
    }

    new Setting(containerEl)
      .setName(t("objectPathTemplate"))
      .setDesc(t("pathTemplateDesc"))
      .addText((text) =>
        text
          .setPlaceholder("attachments/{ext}/{hash2}/{hash}.{ext}")
          .setValue(String(this.plugin.settings.s3.pathTemplate || ""))
          .onChange((value) => {
            this.plugin.settings.s3.pathTemplate = value.trim();
            void debouncedSave();
          })
      );

    new Setting(containerEl)
      .setName(t("testConnection"))
      .setDesc(t("testConnectionDesc"))
      .addButton((button) =>
        button.setButtonText(t("testConnection")).setCta().onClick(async () => {
          try {
            this.plugin.ensureS3Settings();
          } catch (error: unknown) {
            new Notice(error instanceof Error ? error.message : String(error));
            return;
          }
          button.setButtonText(t("testing"));
          button.setDisabled(true);
          try {
            await testS3Connection(this.plugin.settings.s3);
            new Notice(t("testConnectionSuccess"));
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            new Notice(t("testConnectionFailed", { error: errMsg }), 10000);
          } finally {
            button.setButtonText(t("testConnection"));
            button.setDisabled(false);
          }
        })
      );
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    const save = () => this.plugin.saveSettings();
    const debouncedSave = debounce(save, 500);

    new Setting(containerEl).setName(t("generalSettings")).setHeading();

    new Setting(containerEl)
      .setName(t("pluginEnabled"))
      .setDesc(t("pluginEnabledDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange((value) => {
          this.plugin.settings.enabled = value;
          this.plugin.configureAutoScan();
          void save();
        })
      );

    new Setting(containerEl)
      .setName(t("attachmentRoot"))
      .setDesc(t("attachmentRootDesc"))
      .addText((text) =>
        text.setValue(this.plugin.settings.attachmentRoot).onChange((value) => {
          this.plugin.settings.attachmentRoot = value.trim() || "99 Attachments";
          void save();
        })
      );

    new Setting(containerEl)
      .setName(t("deletePolicy"))
      .setDesc(t("deletePolicyDesc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("confirm", t("deleteConfirm"))
          .addOption("immediate", t("deleteImmediate"));
        if (!this.plugin.isMobile) {
          dropdown.addOption("delayed", t("deleteDelayed"));
        }
        dropdown
          .setValue(this.plugin.settings.deletePolicy)
          .onChange((value) => {
            this.plugin.settings.deletePolicy = value as DeletePolicy;
            void save();
            this.display();
          });
      });

    if (!this.plugin.isMobile && this.plugin.settings.deletePolicy === "delayed") {
      new Setting(containerEl)
        .setName(t("deleteDelayHours"))
        .setDesc(t("deleteDelayHoursDesc"))
        .addText((text) =>
          text.setValue(String(this.plugin.settings.autoDeleteDelayHours)).onChange((value) => {
            this.plugin.settings.autoDeleteDelayHours = Math.max(0, Number(value) || 24);
            void debouncedSave();
          })
        );
    }

    if (!this.plugin.isMobile) {
      new Setting(containerEl)
        .setName(t("automaticScan"))
        .setDesc(t("automaticScanDesc"))
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.autoScanEnabled).onChange((value) => {
          this.plugin.settings.autoScanEnabled = value;
          this.plugin.configureAutoScan();
          void save();
          this.display();
        })
        );

      if (this.plugin.settings.autoScanEnabled) {
        new Setting(containerEl)
          .setName(t("scanInterval"))
          .setDesc(t("scanIntervalDesc"))
          .addText((text) =>
            text.setValue(String(this.plugin.settings.scanIntervalMinutes)).onChange((value) => {
              this.plugin.settings.scanIntervalMinutes = Number(value) || 30;
              this.plugin.configureAutoScan();
              void debouncedSave();
            })
          );

        new Setting(containerEl)
          .setName(t("quietSeconds"))
          .setDesc(t("quietSecondsDesc"))
          .addText((text) =>
            text.setValue(String(this.plugin.settings.quietSeconds)).onChange((value) => {
              this.plugin.settings.quietSeconds = Number(value) || 0;
              void debouncedSave();
            })
          );

        new Setting(containerEl)
          .setName(t("autoScanMinSize"))
          .setDesc(t("autoScanMinSizeDesc"))
          .addText((text) =>
            text.setValue(String(this.plugin.settings.autoScanMinSizeMiB || 0)).onChange((value) => {
              this.plugin.settings.autoScanMinSizeMiB = Math.max(0, Number(value) || 0);
              void debouncedSave();
            })
          );
      }
    } else {
      const hintEl = containerEl.createEl("p", {
        cls: "setting-item-description",
      });
      hintEl.textContent = t("mobileHint");
    }
  }

  private renderFileTypeSettings(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    new Setting(containerEl).setName(t("fileTypes")).setHeading();
    containerEl.createEl("p", {
      text: t("fileTypesDesc"),
      cls: "attachment-imagebed-manager-guide",
    });

    for (const category of FILE_CATEGORIES) {
      this.renderCategory(containerEl, category);
    }

    this.renderCustomExtensions(containerEl);
  }

  private renderCategory(containerEl: HTMLElement, category: FileCategory): void {
    const t = makeT(this.plugin);
    const settings = this.plugin.settings;
    const enabledSet = new Set(settings.enabledExtensions);
    const autoSet = new Set(settings.autoCandidateExts);
    const icon = CATEGORY_ICONS[category.id] || "";

    const enabledCount = category.extensions.filter((e: string) => enabledSet.has(e)).length;
    const totalCount = category.extensions.length;
    const catEnabled = enabledCount === totalCount;
    const catPartiallyEnabled = !catEnabled && enabledCount > 0;

    // Default: expand if any extension is enabled
    const defaultExpanded = enabledCount > 0;

    const card = containerEl.createDiv({ cls: "attachment-imagebed-manager-category" });

    // ── Header row ──
    const headerRow = card.createDiv({ cls: "attachment-imagebed-manager-category-header" });

    const catCheckbox = headerRow.createEl("input", { type: "checkbox" });
    catCheckbox.checked = catEnabled;
    catCheckbox.indeterminate = catPartiallyEnabled;

    const catLabel = headerRow.createEl("span", { cls: "attachment-imagebed-manager-category-name" });
    catLabel.textContent = `${icon} ${t(category.nameKey)}`;

    const countLabel = headerRow.createEl("span", { cls: "attachment-imagebed-manager-category-count" });
    countLabel.textContent = t("extCount", { enabled: enabledCount, total: totalCount });

    const autoEnabled = category.extensions
      .filter((e: string) => enabledSet.has(e))
      .every((e: string) => autoSet.has(e));

    const autoLabel = headerRow.createEl("label", { cls: "attachment-imagebed-manager-auto-label" });
    const autoCheckbox = autoLabel.createEl("input", { type: "checkbox" });
    autoCheckbox.checked = autoEnabled;
    autoLabel.createSpan({ text: t("autoScanShort") });

    const toggleBtn = headerRow.createEl("span", { cls: "attachment-imagebed-manager-category-toggle" });
    toggleBtn.textContent = defaultExpanded ? "\u25bc" : "\u25b6";

    // ── Chips body (collapsible) ──
    const chipsBody = card.createDiv({ cls: "attachment-imagebed-manager-category-body" });
    if (!defaultExpanded) chipsBody.addClass("attachment-imagebed-manager-collapsed");

    const chips = chipsBody.createDiv({ cls: "attachment-imagebed-manager-chips" });
    for (const ext of category.extensions) {
      const chip = chips.createEl("span", { cls: "attachment-imagebed-manager-chip" });
      if (enabledSet.has(ext)) chip.addClass("attachment-imagebed-manager-chip-active");
      chip.textContent = `.${ext}`;
      chip.addEventListener("click", () => {
        if (enabledSet.has(ext)) enabledSet.delete(ext);
        else enabledSet.add(ext);
        settings.enabledExtensions = Array.from(enabledSet);
        void this.plugin.saveSettings();
        this.display();
      });
    }

    // ── Event handlers ──
    catCheckbox.addEventListener("change", () => {
      for (const ext of category.extensions) {
        if (catCheckbox.checked) enabledSet.add(ext);
        else enabledSet.delete(ext);
      }
      settings.enabledExtensions = Array.from(enabledSet);
      void this.plugin.saveSettings();
      this.display();
    });

    autoCheckbox.addEventListener("change", () => {
      const enabledInCat = category.extensions.filter((e: string) => enabledSet.has(e));
      for (const ext of enabledInCat) {
        if (autoCheckbox.checked) autoSet.add(ext);
        else autoSet.delete(ext);
      }
      settings.autoCandidateExts = Array.from(autoSet);
      void this.plugin.saveSettings();
      this.display();
    });

    let expanded = defaultExpanded;
    toggleBtn.addEventListener("click", () => {
      expanded = !expanded;
      chipsBody.toggleClass("attachment-imagebed-manager-collapsed", !expanded);
      toggleBtn.textContent = expanded ? "\u25bc" : "\u25b6";
    });
  }

  private renderCustomExtensions(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    const settings = this.plugin.settings;
    const enabledSet = new Set(settings.enabledExtensions);
    const autoSet = new Set(settings.autoCandidateExts);
    const allKnownExts = FILE_CATEGORIES.flatMap((c) => c.extensions);
    const customExts = settings.customExtensions.filter((e) => !allKnownExts.includes(e));

    const card = containerEl.createDiv({ cls: "attachment-imagebed-manager-category" });
    const headerRow = card.createDiv({ cls: "attachment-imagebed-manager-category-header" });
    headerRow.createEl("span", { cls: "attachment-imagebed-manager-category-name" }).textContent = `\u2795 ${t("customExtensions")}`;

    let inputValue = "";
    const inputRow = card.createDiv({ cls: "attachment-imagebed-manager-custom-input-row" });

    const input = inputRow.createEl("input", {
      type: "text",
      placeholder: t("customExtPlaceholder"),
    });
    input.addEventListener("input", () => { inputValue = input.value; });

    const addBtn = inputRow.createEl("button", { text: t("addExtension") });
    addBtn.addEventListener("click", () => {
      const exts = inputValue
        .split(/[,\s]+/)
        .map((e) => e.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean);
      for (const ext of exts) {
        if (!settings.customExtensions.includes(ext)) settings.customExtensions.push(ext);
        if (!enabledSet.has(ext)) enabledSet.add(ext);
      }
      settings.enabledExtensions = Array.from(enabledSet);
      void this.plugin.saveSettings();
      this.display();
    });

    if (customExts.length > 0) {
      const tagContainer = card.createDiv({ cls: "attachment-imagebed-manager-custom-tags" });
      for (const ext of customExts) {
        const tag = tagContainer.createEl("span", { cls: "attachment-imagebed-manager-custom-tag" });

        const extCheckbox = tag.createEl("input", { type: "checkbox" });
        extCheckbox.checked = enabledSet.has(ext);
        extCheckbox.addEventListener("change", () => {
          if (extCheckbox.checked) enabledSet.add(ext);
          else enabledSet.delete(ext);
          settings.enabledExtensions = Array.from(enabledSet);
          void this.plugin.saveSettings();
          this.display();
        });

        tag.createSpan({ text: `.${ext}` });

        const autoCb = tag.createEl("input", { type: "checkbox" });
        autoCb.checked = autoSet.has(ext);
        autoCb.title = t("autoScanShort");
        autoCb.addEventListener("change", () => {
          if (autoCb.checked) autoSet.add(ext);
          else autoSet.delete(ext);
          settings.autoCandidateExts = Array.from(autoSet);
          void this.plugin.saveSettings();
        });

        const autoSpan = tag.createEl("span", { cls: "attachment-imagebed-manager-auto-text" });
        autoSpan.textContent = t("autoScanShort");

        const removeBtn = tag.createEl("span", { cls: "attachment-imagebed-manager-remove" });
        removeBtn.textContent = "\u00d7";
        removeBtn.addEventListener("click", () => {
          settings.customExtensions = settings.customExtensions.filter((e) => e !== ext);
          enabledSet.delete(ext);
          settings.enabledExtensions = Array.from(enabledSet);
          delete settings.minSizeRules[ext];
          delete settings.customReplacements[ext];
          autoSet.delete(ext);
          settings.autoCandidateExts = Array.from(autoSet);
          void this.plugin.saveSettings();
          this.display();
        });
      }
    }
  }

  private renderLogSection(containerEl: HTMLElement): void {
    const t = makeT(this.plugin);
    const settings = this.plugin.settings;

    new Setting(containerEl).setName(t("recentLog")).setHeading();

    if ((settings.pendingDeletes || []).length) {
      new Setting(containerEl).setName(t("pendingDeletes")).setHeading();
      containerEl.createEl("pre", {
        text: settings.pendingDeletes
          .slice(0, 20)
          .map((entry) => `${new Date(entry.dueAt).toLocaleString()} ${entry.sourcePath}`)
          .join("\n"),
        cls: "attachment-imagebed-manager-log",
      });
    }

    const logs = (settings.logs || []).slice(0, 20);
    if (logs.length > 0) {
      containerEl.createEl("pre", {
        text: logs
          .map((log) => `${log.time} ${log.status} ${log.sourcePath || ""} -> ${log.remoteUrl || ""}`)
          .join("\n"),
        cls: "attachment-imagebed-manager-log",
      });
    } else {
      containerEl.createEl("p", {
        text: t("noLogs"),
        cls: "attachment-imagebed-manager-meta",
      });
    }
  }
}
