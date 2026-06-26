import { load as loadYaml, dump as dumpYaml, JSON_SCHEMA } from "js-yaml";
import type { ParsedFlashcard } from "../FlashcardParser";
import { serializeOcclusionBack } from "./OcclusionV2";
import {
  OCCLUSION_V2_VERSION,
  type OcclusionDoc,
  type OcclusionMask,
  type OcclusionParseResult,
} from "./OcclusionV2.types";

/** Smallest allowed mask dimension, as a percent of the image. */
const MIN_MASK_SIZE = 1;

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalize an image reference to an embeddable string plus its bare path.
 * Accepts `[[path]]`, `![[path|size]]`, `![alt](path)`, or a bare path.
 */
function normalizeImageRef(raw: string): { embed: string; path: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const embed = trimmed.startsWith("!") ? trimmed : "!" + trimmed;
  let path = trimmed;
  const wiki = /\[\[([^\]|#]+)/.exec(trimmed);
  if (wiki) {
    path = wiki[1].trim();
  } else {
    const md = /\]\(([^)\s]+)/.exec(trimmed);
    if (md) path = md[1].trim();
  }
  return { embed, path };
}

/** Coerce one raw YAML mask entry into a validated {@link OcclusionMask}. */
function normalizeMask(raw: unknown, index: number, usedIds: Set<string>): OcclusionMask {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  let id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `m${index + 1}`;
  // Deterministic de-duplication: keep distinct identities so two masks never
  // collide on the same flashcard id (one would be silently dropped by sync).
  if (usedIds.has(id)) {
    let suffix = 2;
    while (usedIds.has(`${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }
  usedIds.add(id);

  let x = Number(obj.x);
  let y = Number(obj.y);
  let w = Number(obj.w);
  let h = Number(obj.h);

  // Normalize boxes drawn up/left (negative size) into a positive rectangle.
  if (Number.isFinite(w) && w < 0) {
    x = x + w;
    w = -w;
  }
  if (Number.isFinite(h) && h < 0) {
    y = y + h;
    h = -h;
  }

  x = clamp(x, 0, 100);
  y = clamp(y, 0, 100);
  w = clamp(Number.isFinite(w) ? w : 0, MIN_MASK_SIZE, 100 - x);
  h = clamp(Number.isFinite(h) ? h : 0, MIN_MASK_SIZE, 100 - y);

  const answer = typeof obj.answer === "string" ? obj.answer : "";
  return { id, x, y, w, h, answer };
}

export class OcclusionV2Parser {
  /**
   * Parse the YAML body of a `decks-occlusion` codeblock. Never throws — YAML
   * errors and shape problems return a structured error so callers can degrade
   * gracefully (inline error box, zero cards).
   */
  static parseOcclusionBlock(source: string): OcclusionParseResult {
    let raw: unknown;
    try {
      raw = loadYaml(source);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid YAML";
      return { ok: false, error: msg };
    }
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Occlusion block must be a YAML mapping" };
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.image !== "string" || !obj.image.trim()) {
      return { ok: false, error: "Occlusion block is missing an 'image'" };
    }
    const normalizedImage = normalizeImageRef(obj.image);
    if (!normalizedImage) {
      return { ok: false, error: "Occlusion block has an invalid 'image'" };
    }

    const rawMasks = Array.isArray(obj.masks) ? obj.masks : [];
    const usedIds = new Set<string>();
    const masks = rawMasks.map((m, i) => normalizeMask(m, i, usedIds));

    const doc: OcclusionDoc = {
      __v: OCCLUSION_V2_VERSION,
      image: obj.image.trim(),
      masks,
    };
    return { ok: true, doc };
  }

  /**
   * Serialize an occlusion model to the YAML body of a `decks-occlusion`
   * codeblock (without the fences). Used by the studio's write-back.
   */
  static toYaml(doc: OcclusionDoc): string {
    return dumpYaml(
      {
        image: doc.image,
        version: OCCLUSION_V2_VERSION,
        masks: doc.masks.map((m) => ({
          id: m.id,
          x: m.x,
          y: m.y,
          w: m.w,
          h: m.h,
          answer: m.answer,
        })),
      },
      // JSON schema: only true/false are booleans, so the `y` key isn't quoted
      // to disambiguate it from a YAML 1.1 boolean.
      { lineWidth: -1, schema: JSON_SCHEMA },
    );
  }

  /**
   * Parse a codeblock into one {@link ParsedFlashcard} per mask. Returns an
   * empty array for malformed YAML or a block with zero masks.
   */
  static parse(source: string, breadcrumb: string, tags: string[]): ParsedFlashcard[] {
    const result = OcclusionV2Parser.parseOcclusionBlock(source);
    if (!result.ok) return [];
    const { doc } = result;
    const normalized = normalizeImageRef(doc.image);
    if (!normalized) return [];

    const back = serializeOcclusionBack(doc);
    return doc.masks.map((mask, index): ParsedFlashcard => ({
      front: normalized.embed,
      back,
      notes: "",
      type: "image-occlusion-v2" as const,
      breadcrumb,
      tags: [...tags],
      clozeText: mask.answer,
      clozeOrder: index,
      maskId: mask.id,
      imagePath: normalized.path,
    }));
  }
}
