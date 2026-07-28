import type { FlashcardType } from "../../database/types";
import {
  OCCLUSION_V2_VERSION,
  type OcclusionDoc,
  type OcclusionMask,
} from "./OcclusionV2.types";

/** True for cards produced by the V2 codeblock occlusion path. */
export function isOcclusionV2(card: { type: FlashcardType }): boolean {
  return card.type === "image-occlusion-v2";
}

/**
 * Extract the bare link path from an image reference (`[[path]]`, `![[path|x]]`,
 * `![alt](path)`, or a bare path) for resolving the vault resource.
 */
export function occlusionImageLinkpath(image: string): string {
  const trimmed = image.trim();
  const wiki = /\[\[([^\]|#]+)/.exec(trimmed);
  if (wiki) return wiki[1].trim();
  const md = /\]\(([^)\s]+)/.exec(trimmed);
  if (md) return md[1].trim();
  return trimmed.replace(/^!/, "");
}

/**
 * The bare file name of an occlusion image (e.g. `heart.png`), used as a stable
 * tiebreaker in the card id. Accepts a raw reference or an already-resolved
 * path; the folder is dropped so relocating the image doesn't change the id.
 */
export function occlusionImageName(image: string): string {
  const linkpath = occlusionImageLinkpath(image);
  return (linkpath.split(/[\\/]/).pop() ?? linkpath).trim();
}

/** Serialize the full occlusion model into a flashcard `back` payload. */
export function serializeOcclusionBack(doc: OcclusionDoc): string {
  return JSON.stringify(doc);
}

/**
 * Parse a flashcard `back` payload produced by {@link serializeOcclusionBack}.
 * Returns null if the back is not a valid V2 occlusion document (never throws).
 */
export function parseOcclusionBack(back: string): OcclusionDoc | null {
  try {
    const raw: unknown = JSON.parse(back);
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.__v !== OCCLUSION_V2_VERSION) return null;
    if (typeof obj.image !== "string" || !Array.isArray(obj.masks)) return null;
    const masks: OcclusionMask[] = [];
    for (const m of obj.masks) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Record<string, unknown>;
      if (typeof mm.id !== "string") continue;
      masks.push({
        id: mm.id,
        x: Number(mm.x) || 0,
        y: Number(mm.y) || 0,
        w: Number(mm.w) || 0,
        h: Number(mm.h) || 0,
        answer: typeof mm.answer === "string" ? mm.answer : "",
      });
    }
    return { __v: OCCLUSION_V2_VERSION, image: obj.image, masks };
  } catch {
    return null;
  }
}

/**
 * Build the per-card content hash input for a V2 occlusion card from its
 * serialized `back` and active mask id. Only the active mask's geometry and
 * answer are folded in, so editing one mask never churns its siblings (avoids
 * needless `modified` bumps that fight multi-device merge-sync).
 */
export function occlusionV2HashInput(back: string, maskId: string): string {
  const doc = parseOcclusionBack(back);
  const active = doc?.masks.find((m) => m.id === maskId);
  if (!active) {
    return "occ2::" + maskId + "::" + back;
  }
  return ["occ2", active.id, active.x, active.y, active.w, active.h, active.answer].join("::");
}

/** The active mask id for a stored V2 card, resolved via its `clozeOrder`. */
export function activeMaskIdForCard(card: {
  back: string;
  clozeOrder: number | null;
}): string | null {
  const doc = parseOcclusionBack(card.back);
  if (!doc) return null;
  const order = card.clozeOrder;
  if (order === null || order < 0 || order >= doc.masks.length) return null;
  return doc.masks[order]?.id ?? null;
}
