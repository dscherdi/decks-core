import type { OcclusionMask } from "../../occlusion/OcclusionV2.types";

/**
 * Extracts occlusion masks from an Anki Image Occlusion SVG. Anki stores masks
 * as `<rect x y width height id>` in a coordinate space matching the base image
 * (`<svg width=W height=H>`); Decks uses percentages (0–100), so each rect is
 * converted relative to the SVG dimensions. Pure string parsing — no DOM.
 */

export interface AnkiOcclusionResult {
  width: number;
  height: number;
  masks: OcclusionMask[];
}

const SVG_TAG = /<svg\b[^>]*>/i;
const RECT_TAG = /<rect\b[^>]*\/?>/gi;

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return match ? match[1] : null;
}

function num(value: string | null): number {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// SVG canvas dimensions, from width/height or the viewBox, else null.
function svgDimensions(svg: string): { width: number; height: number } | null {
  const open = SVG_TAG.exec(svg);
  if (!open) return null;
  const tag = open[0];
  let width = num(attr(tag, "width"));
  let height = num(attr(tag, "height"));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    const viewBox = attr(tag, "viewBox");
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        width = parts[2];
        height = parts[3];
      }
    }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export class AnkiOcclusionExtractor {
  /**
   * Parse a mask SVG into Decks occlusion masks (percent coordinates). Returns
   * null when the SVG has no usable dimensions or rects.
   */
  static extract(svg: string): AnkiOcclusionResult | null {
    if (!svg) return null;
    const dims = svgDimensions(svg);
    if (!dims) return null;

    const masks: OcclusionMask[] = [];
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = RECT_TAG.exec(svg)) !== null) {
      const tag = match[0];
      const x = num(attr(tag, "x"));
      const y = num(attr(tag, "y"));
      const w = num(attr(tag, "width"));
      const h = num(attr(tag, "height"));
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const id = attr(tag, "id")?.trim() || `m${index + 1}`;
      masks.push({
        id,
        x: clampPct((x / dims.width) * 100),
        y: clampPct((y / dims.height) * 100),
        w: clampPct((w / dims.width) * 100),
        h: clampPct((h / dims.height) * 100),
        answer: "",
      });
      index++;
    }

    if (masks.length === 0) return null;
    return { width: dims.width, height: dims.height, masks };
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n * 1000) / 1000));
}
