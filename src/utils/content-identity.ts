import { hash64 } from "./hash";
import {
  activeMaskIdForCard,
  occlusionImageName,
  parseOcclusionBack,
} from "../services/occlusion/OcclusionV2";

/** The card fields a content id is derived from; the rest may be left out. */
export interface IdentityFields {
  front?: string;
  back?: string;
  breadcrumb?: string;
  clozeText?: string | null;
  clozeOrder?: number | null;
  sourceNodeId?: string | null;
  edgeId?: string | null;
}

/** What a card's content id is derived from, by id kind; equal means one card written twice. */
export function identityOf(id: string, card: IdentityFields): string {
  const kind = id.slice(0, id.indexOf("_"));
  const front = card.front ?? "";
  const node = card.sourceNodeId ?? "";
  const order = String(card.clozeOrder ?? "");
  const parts =
    kind === "ocard"
      ? [
          card.breadcrumb ?? "",
          occlusionImageName(parseOcclusionBack(card.back ?? "")?.image ?? ""),
          activeMaskIdForCard({ back: card.back ?? "", clozeOrder: card.clozeOrder ?? null }) ?? "",
        ]
      : kind === "sccard"
      ? [front, card.edgeId ?? "", order, card.clozeText ?? ""]
      : kind === "scard"
      ? [front, card.edgeId ?? ""]
      : kind === "rcard"
      ? [card.back ?? "", node]
      : kind === "ccard"
      ? [front, order, card.clozeText ?? "", node]
      : [front, node];
  return [kind, ...parts].join("\u0000");
}

/**
 * The 64-bit id a card takes when a different card already holds its content id.
 * Same prefix, same fields, so every device derives the same one.
 */
export function wideContentId(contentId: string, card: IdentityFields): string {
  const prefix = contentId.slice(0, contentId.indexOf("_") + 1);
  return `${prefix}${hash64(`content:${identityOf(contentId, card)}`)}`;
}
