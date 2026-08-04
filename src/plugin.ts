import { Notice, Platform, Plugin, TFile, getLanguage } from "obsidian";
import {
  Candidate,
  DeletePolicy,
  LocalFileRecord,
  LocalRef,
  LogEntry,
  PluginSettings,
  ProgressState,
  ReplaceOptions,
  ReplaceResult,
  ScanOptions,
  UploadResult,
  VaultBatchFailure,
  VaultBatchPlan,
  VaultBatchProgress,
  VaultBatchResult,
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
import { VaultBatchModal } from "./vault-batch-modal";
import { VaultBatchFilterModal } from "./vault-batch-filter-modal";
import { DryRunModal } from "./dry-run-modal";
import { AttachmentImagebedSettingTab } from "./settings-tab";
import {
  isFileQuiet,
  meetsAutoScanSize,
  normalizeScanIntervalMinutes,
  shouldScheduleAutoScan,
} from "./auto-scan-policy";

export default class AttachmentImagebedManagerPlugin extends Plugin {
  declare settings: PluginSettings;
  locale!: string;
  autoScanTimer: number | null = null;
  autoScanRunning = false;
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
      id: "batch-replace-vault-attachments",
      name: this.t("commandBatchReplaceVault"),
      callback: () => this.openVaultBatch(),
    });

    this.addCommand({
      id: "filter-batch-replace-vault-attachments",
      name: this.t("commandFilterBatchReplaceVault"),
      callback: () => this.openFilteredVaultBatch(),
    });

    if (!this.isMobile) {
      this.addCommand({
        id: "process-delayed-deletes",
        name: this.t("commandProcessDeletes"),
        callback: () => this.processPendingDeletes(),
      });
    }

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
    if (!shouldScheduleAutoScan({
      isMobile: this.isMobile,
      enabled: this.settings.enabled,
      autoScanEnabled: this.settings.autoScanEnabled,
    })) return;
    const minutes = normalizeScanIntervalMinutes(this.settings.scanIntervalMinutes);
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
      includeCoverReferences: true,
    });
    if (candidates.length === 0) {
      new Notice(this.t("noCandidates"));
      return;
    }
    new CandidateModal(this.app, this, activeFile, candidates).open();
  }

  async scanVaultDryRun(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const notice = new Notice(this.t("scanningVault", { current: 0, total: files.length }), 0);
    const plan = await this.scanVaultPlan((state) => {
      notice.setMessage(this.t("scanningVault", { current: state.current, total: state.total }));
    });
    notice.hide();
    new DryRunModal(this.app, this, plan).open();
  }

  async openVaultBatch(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice(this.t("disabled"));
      return;
    }
    const files = this.app.vault.getMarkdownFiles();
    const notice = new Notice(this.t("scanningVault", { current: 0, total: files.length }), 0);
    try {
      const plan = await this.scanVaultPlan((state) => {
        notice.setMessage(this.t("scanningVault", { current: state.current, total: state.total }));
      });
      notice.hide();
      if (!plan.items.length) {
        new Notice(this.t("noVaultCandidates"));
        return;
      }
      new VaultBatchModal(this.app, this, plan).open();
    } catch (error: unknown) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      console.error("Vault scan failed", error);
      new Notice(this.t("vaultScanFailed", { error: message }), 10000);
    }
  }

  async openFilteredVaultBatch(): Promise<void> {
    if (!this.settings.enabled) {
      new Notice(this.t("disabled"));
      return;
    }
    const files = this.app.vault.getMarkdownFiles();
    const notice = new Notice(this.t("scanningVault", { current: 0, total: files.length }), 0);
    try {
      const plan = await this.scanVaultPlan((state) => {
        notice.setMessage(this.t("scanningVault", { current: state.current, total: state.total }));
      });
      notice.hide();
      if (!plan.items.length) {
        new Notice(this.t("noVaultCandidates"));
        return;
      }
      new VaultBatchFilterModal(this.app, this, plan).open();
    } catch (error: unknown) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      console.error("Filtered vault scan failed", error);
      new Notice(this.t("vaultScanFailed", { error: message }), 10000);
    }
  }

  async scanVaultPlan(
    onProgress?: (state: VaultBatchProgress) => void
  ): Promise<VaultBatchPlan> {
    const files = this.app.vault.getMarkdownFiles();
    const items: VaultBatchPlan["items"] = [];
    const uniqueFiles = new Map<string, TFile>();
    const referencesBySource = new Map<string, Set<string>>();
    const scanFailures: VaultBatchFailure[] = [];
    let totalReferences = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.({
        phase: "scanning",
        current: i + 1,
        total: files.length,
        notePath: file.path,
        label: file.name,
      });
      try {
        const candidates = await this.findCandidatesInNote(file, {
          requireAutoCandidate: false,
          enforceAttachmentRoot: false,
          enforceSizeRule: false,
          skipExtensionFilter: true,
          includeCoverReferences: true,
        });
        if (!candidates.length) continue;
        items.push({ noteFile: file, candidates });
        for (const candidate of candidates) {
          uniqueFiles.set(candidate.file.path, candidate.file);
          const notePaths = referencesBySource.get(candidate.file.path) || new Set<string>();
          notePaths.add(file.path);
          referencesBySource.set(candidate.file.path, notePaths);
          totalReferences += candidate.refs.length;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        scanFailures.push({ notePath: file.path, error: message });
        console.error(`Vault scan error for ${file.path}:`, error);
      }
    }

    return {
      items,
      noteCount: items.length,
      uniqueFileCount: uniqueFiles.size,
      totalBytes: Array.from(uniqueFiles.values()).reduce((sum, file) => sum + file.stat.size, 0),
      totalReferences,
      scanFailures,
      referencesBySource: Object.fromEntries(
        Array.from(referencesBySource.entries()).map(([path, notePaths]) => [path, Array.from(notePaths)])
      ),
    };
  }

  async runVaultBatch(
    plan: VaultBatchPlan,
    onProgress?: (state: VaultBatchProgress) => void
  ): Promise<VaultBatchResult> {
    this.ensureS3Settings();
    const deleteMode = this.getEffectiveDeleteMode();
    const uploadCache = new Map<string, UploadResult>();
    const successfulNotes = new Set<string>();
    const localRecords = new Map<string, LocalFileRecord>();
    const failures: VaultBatchFailure[] = plan.scanFailures ? [...plan.scanFailures] : [];
    let replacedLinks = 0;
    let notesChanged = 0;

    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i];
      onProgress?.({
        phase: "rewriting",
        current: i,
        total: plan.items.length,
        notePath: item.noteFile.path,
        label: item.noteFile.name,
      });
      try {
        const result = await this.replaceCandidates(item.noteFile, item.candidates, (state) => {
          onProgress?.({
            phase: state.phase === "trashing" ? "trashing" : state.phase === "scheduling" ? "scheduling" : state.phase === "uploading" || state.phase === "uploaded" ? "uploading" : "rewriting",
            current: i,
            total: plan.items.length,
            notePath: item.noteFile.path,
            label: state.label,
          });
        }, {
          deleteMode,
          deferDeletion: true,
          uploadCache,
        });
        if (result.replaced > 0) {
          successfulNotes.add(item.noteFile.path);
          notesChanged += 1;
          replacedLinks += result.replaced;
          for (const record of result.localFiles || []) localRecords.set(record.path, record);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ notePath: item.noteFile.path, error: message });
        console.error(`Vault batch error for ${item.noteFile.path}:`, error);
      }
    }

    const referencesBySource = new Map<string, Set<string>>();
    if (plan.referencesBySource) {
      for (const [sourcePath, notePaths] of Object.entries(plan.referencesBySource)) {
        referencesBySource.set(sourcePath, new Set(notePaths));
      }
    } else {
      for (const item of plan.items) {
        for (const candidate of item.candidates) {
          const refs = referencesBySource.get(candidate.file.path) || new Set<string>();
          refs.add(item.noteFile.path);
          referencesBySource.set(candidate.file.path, refs);
        }
      }
    }
    const deletable = Array.from(localRecords.values()).filter((record) => {
      const refs = referencesBySource.get(record.path);
      return !!refs && Array.from(refs).every((notePath) => successfulNotes.has(notePath));
    });
    const protectedFiles = localRecords.size - deletable.length;
    let deletedFiles = 0;
    let scheduledFiles = 0;

    if (deleteMode === "immediate") {
      onProgress?.({
        phase: "trashing",
        current: 0,
        total: deletable.length,
        notePath: "",
        label: this.t("phaseTrashing"),
      });
      for (let i = 0; i < deletable.length; i++) {
        const record = deletable[i];
        const notePath = this.firstReferencingNote(record.path, plan) || "vault-batch";
        const file = this.app.vault.getAbstractFileByPath(record.path);
        if (!(file instanceof TFile)) continue;
        try {
          await this.deleteLocalFileRecords({ path: notePath }, [record], "manual-delete");
          deletedFiles += 1;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ notePath, error: `${record.path}: ${message}` });
          console.error(`Vault batch delete error for ${record.path}:`, error);
        }
        onProgress?.({ phase: "trashing", current: i + 1, total: deletable.length, notePath, label: record.name });
      }
    } else if (deleteMode === "delayed") {
      for (let i = 0; i < deletable.length; i++) {
        const record = deletable[i];
        const notePath = this.firstReferencingNote(record.path, plan) || "vault-batch";
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);
        this.scheduleDelayedDeletes(noteFile instanceof TFile ? noteFile : { path: notePath }, [record]);
        scheduledFiles += 1;
        onProgress?.({ phase: "scheduling", current: i + 1, total: deletable.length, notePath, label: record.name });
      }
      await this.saveSettings();
    }

    onProgress?.({
      phase: "done",
      current: plan.items.length,
      total: plan.items.length,
      notePath: "",
      label: this.t("phaseDone"),
    });
    return {
      notesScanned: plan.items.length + (plan.scanFailures?.length || 0),
      notesChanged,
      uniqueFiles: plan.uniqueFileCount,
      uploadedFiles: uploadCache.size,
      replacedLinks,
      deletedFiles,
      scheduledFiles,
      protectedFiles,
      pendingLocalFiles: deleteMode === "confirm" ? deletable : [],
      failures,
    };
  }

  firstReferencingNote(sourcePath: string, plan: VaultBatchPlan): string | null {
    for (const item of plan.items) {
      if (item.candidates.some((candidate) => candidate.file.path === sourcePath)) return item.noteFile.path;
    }
    return null;
  }

  async runAutoScan(): Promise<void> {
    if (!shouldScheduleAutoScan({
      isMobile: this.isMobile,
      enabled: this.settings.enabled,
      autoScanEnabled: this.settings.autoScanEnabled,
      running: this.autoScanRunning,
    })) return;
    this.autoScanRunning = true;
    try {
      this.ensureS3Settings();
    } catch {
      // S3 not configured, skip this run silently.
      this.autoScanRunning = false;
      return;
    }
    try {
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
            if (!meetsAutoScanSize(c.sizeBytes, this.settings.autoScanMinSizeMiB)) return false;
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
    } finally {
      this.autoScanRunning = false;
    }
  }

  isQuiet(file: TFile): boolean {
    return isFileQuiet(file.stat.mtime, this.settings.quietSeconds);
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
      if (!options.includeCoverReferences && this.isCoverReference(text, ref)) continue;

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
    options: ReplaceOptions = {}
  ): Promise<ReplaceResult> {
    const deleteMode = this.getEffectiveDeleteMode(options.deleteMode);
    const deferDeletion = options.deferDeletion === true;
    this.ensureS3Settings();
    const originalText = await this.app.vault.read(noteFile);
    let noteChanged = false;
    let replaced = 0;
    const replacementMap = new Map<string, string>();
    const uploaded = new Map<string, UploadResult>();
    const uploadedKeys: string[] = [];
    const newlyCachedPaths: string[] = [];
    const uniqueFiles = new Set(candidates.map((c) => c.file.path)).size;
    let completedUploads = 0;

    try {
      for (const candidate of candidates) {
        let upload = uploaded.get(candidate.file.path) || options.uploadCache?.get(candidate.file.path);
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
          if (options.uploadCache) {
            options.uploadCache.set(candidate.file.path, upload);
            newlyCachedPaths.push(candidate.file.path);
          }
          completedUploads += 1;
          progress?.({
            phase: "uploaded",
            current: completedUploads,
            total: uniqueFiles,
            label: candidate.file.name,
          });
        }
        uploaded.set(candidate.file.path, upload);
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
      for (const path of newlyCachedPaths) {
        const cache = options.uploadCache;
        if (cache && cache.get(path)?.key === uploaded.get(path)?.key) cache.delete(path);
      }
      throw error;
    }

    if (!noteChanged) {
      return { replaced: 0, deleteMode, deletionStatus: "kept" };
    }

    const localFiles = this.buildLocalFileRecords(candidates, uploaded);
    for (const candidate of candidates) replaced += candidate.refs.length;

    let deletionStatus: ReplaceResult["deletionStatus"] = "kept";
    if (deferDeletion) {
      deletionStatus = "deferred";
      for (const fileRecord of localFiles) {
        this.addLog({
          status: "replaced-awaiting-batch-delete",
          notePath: noteFile.path,
          sourcePath: fileRecord.path,
          remoteUrl: fileRecord.remoteUrl,
          trashed: false,
        });
      }
    } else if (deleteMode === "delayed") {
      progress?.({
        phase: "scheduling",
        current: completedUploads,
        total: uniqueFiles,
        label: this.t("phaseScheduling"),
      });
      this.scheduleDelayedDeletes(noteFile, localFiles);
      deletionStatus = "scheduled";
    } else if (deleteMode === "immediate") {
      progress?.({
        phase: "trashing",
        current: completedUploads,
        total: uniqueFiles,
        label: this.t("phaseTrashing"),
      });
      await this.deleteLocalFileRecords(noteFile, localFiles, "manual-delete");
      deletionStatus = "trashed";
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
    return { replaced, localFiles, deleteMode, deletionStatus };
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

  getEffectiveDeleteMode(requested?: DeletePolicy): DeletePolicy {
    const mode = requested || this.settings.deletePolicy || "confirm";
    return this.isMobile && mode === "delayed" ? "confirm" : mode;
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

  scheduleDelayedDeletes(noteFile: { path: string }, localFiles: LocalFileRecord[]): void {
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
    const retryDelayMs = Math.max(1, Number(this.settings.autoDeleteDelayHours) || 24) * 60 * 60 * 1000;
    for (const entry of due) {
      try {
        if (await this.isLocalFileReferenced(entry.sourcePath)) {
          const retryAt = Date.now() + retryDelayMs;
          remaining.push({ ...entry, dueAt: retryAt });
          this.addLog({
            status: "delayed-delete-protected-still-referenced",
            notePath: entry.notePath,
            sourcePath: entry.sourcePath,
            remoteUrl: entry.remoteUrl,
            trashed: false,
            dueAt: new Date(retryAt).toISOString(),
          });
          continue;
        }
        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        await this.deleteLocalFileRecords(
          noteFile instanceof TFile ? noteFile : { path: entry.notePath },
          [{ path: entry.sourcePath, name: basename(entry.sourcePath), remoteUrl: entry.remoteUrl }],
          "delayed-delete"
        );
      } catch (error) {
        remaining.push(entry);
        console.error(`Delayed delete failed for ${entry.sourcePath}:`, error);
      }
    }
    this.settings.pendingDeletes = remaining;
    await this.saveSettings();
  }

  async isLocalFileReferenced(sourcePath: string): Promise<boolean> {
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!source || typeof source.path !== "string") return false;
    for (const noteFile of this.app.vault.getMarkdownFiles()) {
      try {
        const text = await this.app.vault.read(noteFile);
        for (const ref of extractLocalRefs(text)) {
          const target = this.resolveLinkedFile(ref.target, noteFile);
          if (target?.path === sourcePath) return true;
        }
      } catch (error) {
        console.error(`Unable to verify references before deleting ${sourcePath} in ${noteFile.path}:`, error);
        return true;
      }
    }
    return false;
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
