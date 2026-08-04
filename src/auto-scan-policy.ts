export interface AutoScanScheduleInput {
  isMobile: boolean;
  enabled: boolean;
  autoScanEnabled: boolean;
  running?: boolean;
}

export function shouldScheduleAutoScan(input: AutoScanScheduleInput): boolean {
  return !input.isMobile && input.enabled && input.autoScanEnabled && !input.running;
}

export function normalizeScanIntervalMinutes(value: unknown): number {
  const parsed = Number(value);
  return Math.max(1, parsed || 30);
}

export function isFileQuiet(
  modifiedAt: number,
  quietSeconds: unknown,
  now = Date.now()
): boolean {
  const quietMs = Math.max(0, Number(quietSeconds) || 0) * 1000;
  if (!quietMs) return true;
  return now - modifiedAt >= quietMs;
}

export function meetsAutoScanSize(sizeBytes: number, minMiB: unknown): boolean {
  const minBytes = Math.max(0, Number(minMiB) || 0) * 1024 * 1024;
  return sizeBytes >= minBytes;
}
