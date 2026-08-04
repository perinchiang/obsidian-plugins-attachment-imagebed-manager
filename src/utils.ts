export function basename(path: string): string {
  return String(path || "").split("/").pop() || path;
}

export function trimSlashes(path: string): string {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

export function safeFilename(name: string): string {
  return String(name || "attachment").replace(/[\\/:*?"<>|#%]+/g, "-");
}

export function renderPathTemplate(
  template: string,
  values: { ext: string; hash: string; hash2: string; filename: string }
): string {
  return String(template || "attachments/{ext}/{hash2}/{hash}.{ext}")
    .replace(/\{ext\}/g, values.ext)
    .replace(/\{hash\}/g, values.hash)
    .replace(/\{hash2\}/g, values.hash2)
    .replace(/\{filename\}/g, values.filename)
    .replace(/^\/+/, "");
}

export function buildPublicUrl(domain: string, key: string): string {
  let cleanDomain = String(domain || "").replace(/\/+$/, "");
  if (cleanDomain && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleanDomain)) {
    cleanDomain = `https://${cleanDomain}`;
  }
  return `${cleanDomain}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function replaceAllLiteral(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement);
}

export function escapeMarkdownLabel(label: string): string {
  return String(label || "attachment").replace(/\]/g, "\\]");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function contentTypeForExt(ext: string): string {
  const map: Record<string, string> = {
    pdf: "application/pdf",
    epub: "application/epub+zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    heic: "image/heic",
    bmp: "image/bmp",
    tiff: "image/tiff",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    aac: "audio/aac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
    flv: "video/x-flv",
  };
  return map[ext] || "application/octet-stream";
}

export function isPreviewableImage(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(
    String(ext || "").toLowerCase()
  );
}

export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: Parameters<T>) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}
