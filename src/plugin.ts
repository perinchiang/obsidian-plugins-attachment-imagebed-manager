import { Notice, Platform, Plugin, TFile, getLanguage } from "obsidian";
import {
  Candidate,
  DeletePolicy,
  LocalFileRecord,
  LocalRef,
  LogEntry,
  PluginSettings,
  ProgressState,
  ReplaceResult,
  ScanOptions,
  UploadResult,
} from "./types";
import { DEFAULT_SETTINGS, getReplacementForExt, mergeSettings } from "./settings";
import { extractLocalRefs } from "./link-parser";
import { putS3Object, deleteS3Object } from "./s3-client";
import { sha256Hex } from "./crypto";
import {
  basename,
  buildPublicUrl,
  contentTypeForExt,
  escapeMarkdownLabel,
  renderPathTemplate,
  replaceAllLiteral,
  safeFilename,
  trimSlashes,
} from "./utils";
import { detectLocaleFromApp, t as translate } from "./i18n";
import { CandidateModal } from "./candidate-modal";
import { DryRunModal } from "./dry-run-modal";
import { AttachmentImagebedSettingTab } from "./settings-tab";

export default class AttachmentImagebedManagerPlugin extends Plugin {
  declare settings: PluginSettings;
  locale!: string;
  autoScanTimer: number | null = null;
  isMobile: boolean = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.locale = detectLocaleFromApp(getLanguage);
    this.isMobile = Platform.isMobile;

    this.addRibbonIcon("upload-cloud", this.t("ribbonScan"), () => {
      void this.scanCurrentNote();
    });

    this.addCommand({
      id: "scan-current-note",
      name: this.t("commandScanCurrent"),
      callback: () => this.scanCurrentNote(),
    });

    this.addCommand({
      id: "scan-vault-candidates-dry-run",
      name: this.t("commandScanVault"),
      callback: () => this.scanVaultDryRun(),
    });

    this.addCommand({
      id: "process-delayed-deletes",
      name: this.t("commandProcessDeletes"),
      callback: () => this.processPendingDeletes(),
    });

    this.addSettingTab(new AttachmentImagebedSettingTab(this.app, this));
    if (!this.isMobile) {
      await this.processPendingDeletes();
      this.registerInterval(
        window.setInterval(() => {
          this.processPendingDeletes().catch((error) => {
            console.error(this.t("delayedDeleteFailed"), error);
          });
        }, 60 * 1000)
      );
    }
    this.configureAutoScan();
  }

  onunload(): void {
    if (this.autoScanTimer) window.clearInterval(this.autoScanTimer);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Record<string, unknown> | null;
    this.settings = mergeSettings(DEFAULT_SETTINGS, loaded || {});
  }

  async saveSettings(): Promise<void> {
    const toSave: Record<string, unknown> = { ...this.settings };
    toSave.logs = this.settings.logs.slice(0, 50);
    await this.saveData(toSave);
  }

  t(key: string, params: Record<string, unknown> = {}): string {
    return translate(this.locale, key, params);
  }

  configureAutoScan(): void {
    if (this.autoScanTimer) window.clearInterval(this.autoScanTimer);
    this.autoScanTimer = null;
    if (this.isMobile) return;
    if (!this.settings.enabled || !this.settings.autoScanEnabled) return;
    const minutes = Math.max(1, Number(this.settings.scanIntervalMinutes) || 30);
    this.autoScanTimer = window.setInterval(() => {
      this.runAutoScan().catch((error) => {
        console.error("Auto scan failed", error);
        new Notice(this.t("autoScanFailed", { error: error instanceof Error ? error.message : String(error) }));
      });
    }, minutes * 60 * 1000);
  }

  async scanCurrentNote(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice(this.t("disabled"));
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== "md") {
      new Notice(this.t("openMarkdownFirst"));
      return;
    }
    try {
      this.ensureS3Settings();
    } catch (error: unknown) {
      new Notice(error instanceof Error ? error.message : String(error));
      return;
    }
    const candidates = await this.findCandidatesInNote(activeFile, {
      requireAutoCandidate: false,
      enforceAttachmentRoot: false,
      enforceSizeRule: false,
      skipExtensionFilter: true,
    });
    if (candidates.length === 0) {
      new Notice(this.t("noCandidates"));
      return;
    }
    new CandidateModal(this.app, this, activeFile, candidates).open();
  }

  async scanVaultDryRun(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let count = 0;
    const samples: string[] = [];
    const notice = new Notice(this.t("scanningVault", { current: 0, total: files.length }), 0);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (i % 50 === 0) {
        notice.setMessage(this.t("scanningVault", { current: i, total: files.length }));
      }
      try {
        const candidates = await this.findCandidatesInNote(file, {
          requireAutoCandidate: true,
          enforceAttachmentRoot: true,
          enforceSizeRule: true,
        });
        count += candidates.length;
        for (const candidate of candidates.slice(0, 3)) {
          if (samples.length < 20) samples.push(`${file.path} -> ${candidate.file.path}`);
        }
      } catch (error) {
        console.error(`Dry-run scan error for ${file.path}:`, error);
      }
    }
    notice.hide();
    new DryRunModal(this.app, this, count, samples).open();
  }

  async runAutoScan(): Promise<void> {
    if (!this.settings.enabled || !this.settings.autoScanEnabled) return;
    try {
      this.ensureS3Settings();
    } catch (_error) {
      // S3 not configured, skip auto scan silently
    }
    const minBytes = Math.max(0, Number(this.settings.autoScanMinSizeMiB) || 0) * 1024 * 1024;
    const files = this.app.vault.getMarkdownFiles();
    let replaced = 0;
    for (const file of files) {
      try {
        if (!this.isQuiet(file)) continue;
        const candidates = await this.findCandidatesInNote(file, {
          requireAutoCandidate: true,
          enforceAttachmentRoot: true,
          enforceSizeRule: true,
        });
        const quietCandidates = candidates.filter((c) => {
          if (!this.isQuiet(c.file)) return false;
          if (minBytes > 0 && c.sizeBytes < minBytes) return false;
          return true;
        });
        if (quietCandidates.length === 0) continue;
        const result = await this.replaceCandidates(file, quietCandidates, null, {
          deleteMode: "delayed",
        });
        replaced += result.replaced;
      } catch (error) {
        console.error(`Auto-scan error for ${file.path}:`, error);
      }
    }
    if (replaced > 0) new Notice(this.t("autoScanReplaced", { count: replaced }));
  }

  isQuiet(file: TFile): boolean {
    const quietMs = Math.max(0, Number(this.settings.quietSeconds) || 0) * 1000;
    if (!quietMs) return true;
    return Date.now() - file.stat.mtime >= quietMs;
  }

  async findCandidatesInNote(noteFile: TFile, options: ScanOptions): Promise<Candidate[]> {
    const text = await this.app.vault.read(noteFile);
    const refs = extractLocalRefs(text);
    const byKey = new Map<string, Candidate>();

    for (const ref of refs) {
      const targetFile = this.resolveLinkedFile(ref.target, noteFile);
      if (!targetFile || !(targetFile instanceof TFile)) continue;
      if (options.enforceAttachmentRoot !== false && !this.isUnderAttachmentRoot(targetFile))
        continue;
      if (this.isCoverReference(text, ref)) continue;

      const ext = targetFile.extension.toLowerCase();
      if (ext === "md") continue;
      if (!options.skipExtensionFilter && !this.settings.enabledExtensions.includes(ext)) continue;
      if (options.requireAutoCandidate && !this.settings.autoCandidateExts.includes(ext))
        continue;
      if (options.enforceSizeRule !== false && !this.meetsSizeRule(targetFile, ext)) continue;

      const replacement = getReplacementForExt(ext, this.settings);
      const key = `${targetFile.path}::${replacement}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.refs.push(ref);
        existing.referenceCount += 1;
      } else {
        byKey.set(key, {
          file: targetFile,
          ext,
          replacement,
          refs: [ref],
          referenceCount: 1,
          sizeBytes: targetFile.stat.size,
        });
      }
    }

    return Array.from(byKey.values()).sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  resolveLinkedFile(target: string, noteFile: TFile): TFile | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      decoded = target;
    }
    const direct = this.app.vault.getAbstractFileByPath(decoded);
    if (direct instanceof TFile) return direct;
    const fromCache = this.app.metadataCache.getFirstLinkpathDest(decoded, noteFile.path);
    if (fromCache instanceof TFile) return fromCache;
    const noteDir = noteFile.parent ? noteFile.parent.path : "";
    const relativePath = noteDir ? `${noteDir}/${decoded}` : decoded;
    const relative = this.app.vault.getAbstractFileByPath(relativePath);
    return relative instanceof TFile ? relative : null;
  }

  isUnderAttachmentRoot(file: TFile): boolean {
    const root = trimSlashes(this.settings.attachmentRoot || "99 Attachments");
    return file.path === root || file.path.startsWith(`${root}/`);
  }

  isCoverReference(text: string, ref: LocalRef): boolean {
    if (/\/cover\//i.test(ref.target)) return true;
    const fmEnd = text.indexOf("\n---", 4);
    if (fmEnd === -1) return false;
    if (ref.start > fmEnd) return false;
    const lineStart = text.lastIndexOf("\n", ref.start) + 1;
    const lineEndIndex = text.indexOf("\n", ref.end);
    const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
    const line = text.slice(lineStart, lineEnd);
    return /^\s*cover\s*:/i.test(line);
  }

  meetsSizeRule(file: TFile, ext: string): boolean {
    const minMiB = this.settings.minSizeRules[ext] || 0;
    const minSize = Math.max(0, minMiB) * 1024 * 1024;
    return file.stat.size >= minSize;
  }

  async replaceCandidates(
    noteFile: TFile,
    candidates: Candidate[],
    progress: ((state: ProgressState) => void) | null,
    options: { deleteMode?: DeletePolicy } = {}
  ): Promise<ReplaceResult> {
    const deleteMode = options.deleteMode || this.settings.deletePolicy || "confirm";
    this.ensureS3Settings();
    const originalText = await this.app.vault.read(noteFile);
    let noteChanged = false;
    let replaced = 0;
    const replacementMap = new Map<string, string>();
    const uploaded = new Map<string, UploadResult>();
    const uploadedKeys: string[] = [];
    const uniqueFiles = new Set(candidates.map((c) => c.file.path)).size;
    let completedUploads = 0;

    try {
      for (const candidate of candidates) {
        let upload = uploaded.get(candidate.file.path);
        if (!upload) {
          progress?.({
            phase: "uploading",
            current: completedUploads,
            total: uniqueFiles,
            label: candidate.file.name,
          });
          upload = await this.uploadCandidate(candidate);
          uploaded.set(candidate.file.path, upload);
          uploadedKeys.push(upload.key);
          completedUploads += 1;
          progress?.({
            phase: "uploaded",
            current: completedUploads,
            total: uniqueFiles,
            label: candidate.file.name,
          });
        }
        for (const ref of candidate.refs) {
          replacementMap.set(ref.raw, this.buildReplacement(ref, candidate, upload.publicUrl));
        }
      }

      progress?.({
        phase: "rewriting",
        current: completedUploads,
        total: uniqueFiles,
        label: noteFile.name,
      });

      await this.app.vault.process(noteFile, (current) => {
        if (current !== originalText) {
          throw new Error(this.t("noteChanged"));
        }
        let next = current;
        for (const [raw, replacement] of replacementMap.entries()) {
          if (!next.includes(raw)) {
            throw new Error(this.t("originalLinkChanged", { link: raw }));
          }
          next = replaceAllLiteral(next, raw, replacement);
        }
        noteChanged = next !== current;
        return next;
      });
    } catch (error) {
      for (const key of uploadedKeys) {
        await deleteS3Object(this.settings.s3, key).catch(() => {});
      }
      throw error;
    }

    if (!noteChanged) return { replaced: 0 };

    const localFiles = this.buildLocalFileRecords(candidates, uploaded);
    for (const candidate of candidates) replaced += candidate.refs.length;

    if (deleteMode === "delayed") {
      progress?.({
        phase: "scheduling",
        current: completedUploads,
        total: uniqueFiles,
        label: this.t("phaseScheduling"),
      });
      this.scheduleDelayedDeletes(noteFile, localFiles);
    } else if (deleteMode === "immediate") {
      progress?.({
        phase: "trashing",
        current: completedUploads,
        total: uniqueFiles,
        label: this.t("phaseTrashing"),
      });
      await this.deleteLocalFileRecords(noteFile, localFiles, "manual-delete");
    } else {
      for (const fileRecord of localFiles) {
        this.addLog({
          status: "replaced-awaiting-delete-confirm",
          notePath: noteFile.path,
          sourcePath: fileRecord.path,
          remoteUrl: fileRecord.remoteUrl,
          trashed: false,
        });
      }
    }

    await this.saveSettings();
    progress?.({
      phase: "done",
      current: uniqueFiles,
      total: uniqueFiles,
      label: this.t("phaseDone"),
    });
    return { replaced, localFiles };
  }

  async uploadCandidate(candidate: Candidate): Promise<UploadResult> {
    const binary = await this.app.vault.readBinary(candidate.file);
    const body = new Uint8Array(binary);
    const hash = await sha256Hex(body);
    const ext = candidate.file.extension.toLowerCase();
    const key = renderPathTemplate(this.settings.s3.pathTemplate, {
      ext,
      hash,
      hash2: hash.slice(0, 2),
      filename: safeFilename(candidate.file.name),
    });
    const contentType = contentTypeForExt(ext);
    await putS3Object(
      this.settings.s3,
      key,
      body,
      contentType,
      (status, text) => this.t("uploadFailed", { status, text }),
      hash
    );
    return { key, publicUrl: buildPublicUrl(this.settings.s3.customDomainName, key) };
  }

  buildReplacement(ref: LocalRef, candidate: Candidate, publicUrl: string): string {
    const encodedBase = encodeURI(publicUrl);
    const url = ref.fragment
      ? `${encodedBase}#${encodeURIComponent(ref.fragment)}`
      : encodedBase;
    const label = ref.label || candidate.file.basename;

    if (candidate.replacement === "image")
      return `![${escapeMarkdownLabel(label)}](${url})`;
    if (candidate.replacement === "video")
      return `<video src="${url}" controls></video>`;
    if (candidate.replacement === "audio")
      return `<audio src="${url}" controls></audio>`;
    return `[${escapeMarkdownLabel(label)}](${url})`;
  }

  buildLocalFileRecords(
    candidates: Candidate[],
    uploaded: Map<string, UploadResult>
  ): LocalFileRecord[] {
    const byPath = new Map<string, LocalFileRecord>();
    for (const candidate of candidates) {
      if (byPath.has(candidate.file.path)) continue;
      byPath.set(candidate.file.path, {
        path: candidate.file.path,
        name: candidate.file.name,
        remoteUrl: uploaded.get(candidate.file.path)?.publicUrl || "",
      });
    }
    return Array.from(byPath.values());
  }

  scheduleDelayedDeletes(noteFile: TFile, localFiles: LocalFileRecord[]): void {
    const delayMs =
      Math.max(0, Number(this.settings.autoDeleteDelayHours) || 0) * 60 * 60 * 1000;
    const dueAt = Date.now() + delayMs;
    const existing = new Set(
      (this.settings.pendingDeletes || []).map((entry) => entry.sourcePath)
    );
    for (const fileRecord of localFiles) {
      if (!existing.has(fileRecord.path)) {
        this.settings.pendingDeletes.push({
          createdAt: new Date().toISOString(),
          dueAt,
          notePath: noteFile.path,
          sourcePath: fileRecord.path,
          remoteUrl: fileRecord.remoteUrl,
        });
      }
      this.addLog({
        status: "scheduled-delayed-delete",
        notePath: noteFile.path,
        sourcePath: fileRecord.path,
        remoteUrl: fileRecord.remoteUrl,
        trashed: false,
        dueAt: new Date(dueAt).toISOString(),
      });
    }
  }

  async deleteLocalFileRecords(
    noteFile: { path: string },
    localFiles: LocalFileRecord[],
    status: string
  ): Promise<void> {
    for (const fileRecord of localFiles) {
      const file = this.app.vault.getAbstractFileByPath(fileRecord.path);
      if (!(file instanceof TFile)) {
        this.addLog({
          status: `${status}-missing-local-file`,
          notePath: noteFile.path,
          sourcePath: fileRecord.path,
          remoteUrl: fileRecord.remoteUrl,
          trashed: false,
        });
        continue;
      }
      await this.app.fileManager.trashFile(file);
      this.addLog({
        status,
        notePath: noteFile.path,
        sourcePath: fileRecord.path,
        remoteUrl: fileRecord.remoteUrl,
        trashed: true,
      });
    }
    this.settings.pendingDeletes = (this.settings.pendingDeletes || []).filter(
      (entry) => !localFiles.some((f) => f.path === entry.sourcePath)
    );
    await this.saveSettings();
  }

  async processPendingDeletes(): Promise<void> {
    const pending = Array.isArray(this.settings.pendingDeletes)
      ? this.settings.pendingDeletes
      : [];
    const now = Date.now();
    const due = pending.filter((entry) => Number(entry.dueAt) <= now);
    if (due.length === 0) return;
    const remaining = pending.filter((entry) => Number(entry.dueAt) > now);
    this.settings.pendingDeletes = remaining;
    for (const entry of due) {
      try {
        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        await this.deleteLocalFileRecords(
          noteFile instanceof TFile ? noteFile : { path: entry.notePath },
          [{ path: entry.sourcePath, name: basename(entry.sourcePath), remoteUrl: entry.remoteUrl }],
          "delayed-delete"
        );
      } catch (error) {
        console.error(`Delayed delete failed for ${entry.sourcePath}:`, error);
      }
    }
    await this.saveSettings();
  }

  ensureS3Settings(): void {
    const s3 = this.settings.s3;
    const missing: string[] = [];
    for (const key of [
      "endpoint",
      "bucketName",
      "accessKeyId",
      "secretAccessKey",
      "customDomainName",
    ] as const) {
      if (!String(s3[key] || "").trim()) missing.push(key);
    }
    if (s3.provider !== "r2" && !String(s3.region || "").trim()) missing.push("region");
    if (missing.length) throw new Error(this.t("missingS3", { settings: missing.join(", ") }));
  }

  addLog(entry: Omit<LogEntry, "time"> & { time?: string }): void {
    this.settings.logs.unshift({
      time: new Date().toISOString(),
      ...entry,
    } as LogEntry);
    this.settings.logs = this.settings.logs.slice(0, 100);
  }
}
