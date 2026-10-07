export interface DirectoryMediaRef {
  sha256: string;
  ext: string;
}

export type DirectoryMediaKind = "image" | "audio" | "video" | "other";

const MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
};
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "ogg", "oga", "wav", "flac", "aac", "opus"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);

/** The MIME type of a file a package can carry; null for anything else. */
export function directoryMediaMime(ext: string): string | null {
  return MEDIA_MIME[ext.toLowerCase()] ?? null;
}

const MEDIA_PATH = /^media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/;
const MEDIA_EMBED = /!\[\[media\/([0-9a-f]{64})\.([a-z0-9]{1,8})(?:\|([^\]\n]*))?\]\]/g;
const MEDIA_LINK = /!\[([^\]\n]*)\]\(media\/([0-9a-f]{64})\.([a-z0-9]{1,8})\)/g;
const MEDIA_SRC = /(\bsrc\s*=\s*["'])media\/([0-9a-f]{64})\.([a-z0-9]{1,8})(["'])/gi;
const SIZE_HINT = /^(\d{1,5})(?:x(\d{1,5}))?$/;

export function directoryMediaKind(ext: string): DirectoryMediaKind {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTS.has(lower)) return "image";
  if (AUDIO_EXTS.has(lower)) return "audio";
  if (VIDEO_EXTS.has(lower)) return "video";
  return "other";
}

/** `media/<sha256>.<ext>` as written inside a package, e.g. an occlusion image field. */
export function parseDirectoryMediaPath(path: string): DirectoryMediaRef | null {
  const match = MEDIA_PATH.exec(path);
  return match ? { sha256: match[1], ext: match[2] } : null;
}

export function directoryMediaPath(ref: DirectoryMediaRef): string {
  return `media/${ref.sha256}.${ref.ext}`;
}

/** Every packaged media file a card's text embeds. */
export function listDirectoryMediaRefs(text: string): DirectoryMediaRef[] {
  const out = new Map<string, DirectoryMediaRef>();
  for (const match of text.matchAll(MEDIA_EMBED)) out.set(match[1], { sha256: match[1], ext: match[2] });
  for (const match of text.matchAll(MEDIA_LINK)) out.set(match[2], { sha256: match[2], ext: match[3] });
  for (const match of text.matchAll(MEDIA_SRC)) out.set(match[2], { sha256: match[2], ext: match[3] });
  return [...out.values()];
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function render(url: string, ext: string, alt: string, size: string | undefined): string {
  const kind = directoryMediaKind(ext);
  if (kind === "audio") return `<audio controls src="${attr(url)}"></audio>`;
  if (kind === "video") return `<video controls src="${attr(url)}"></video>`;
  if (kind === "other") return `[${alt || "file"}](${url})`;
  const dims = size ? SIZE_HINT.exec(size.trim()) : null;
  if (dims) {
    const height = dims[2] ? ` height="${dims[2]}"` : "";
    return `<img src="${attr(url)}" alt="${attr(alt)}" width="${dims[1]}"${height}>`;
  }
  return `![${alt}](${url})`;
}

/**
 * Point a card's packaged media embeds at URLs the renderer can load. An embed
 * whose file is unavailable is left as written.
 */
export function rewriteDirectoryMediaRefs(text: string, urlFor: (ref: DirectoryMediaRef) => string | null): string {
  return text
    .replace(MEDIA_EMBED, (whole, sha256: string, ext: string, hint: string | undefined) => {
      const url = urlFor({ sha256, ext });
      if (!url) return whole;
      const isSize = hint !== undefined && SIZE_HINT.test(hint.trim());
      return render(url, ext, isSize ? "" : hint ?? "", isSize ? hint : undefined);
    })
    .replace(MEDIA_LINK, (whole, alt: string, sha256: string, ext: string) => {
      const url = urlFor({ sha256, ext });
      return url ? render(url, ext, alt, undefined) : whole;
    })
    .replace(MEDIA_SRC, (whole, open: string, sha256: string, ext: string, close: string) => {
      const url = urlFor({ sha256, ext });
      return url ? `${open}${attr(url)}${close}` : whole;
    });
}

// No lookbehind: older iOS WebKit rejects it when the bundle is parsed.
const INTERNAL_LINK = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

/**
 * Prepare a directory card's markdown for rendering: media points at loadable
 * URLs and internal links become plain text, since no note backs them.
 */
export function directoryCardMarkdown(text: string, urlFor: (ref: DirectoryMediaRef) => string | null): string {
  return rewriteDirectoryMediaRefs(text, urlFor).replace(
    INTERNAL_LINK,
    (whole, bang: string, target: string, alias?: string) => (bang ? whole : (alias ?? target).trim())
  );
}
