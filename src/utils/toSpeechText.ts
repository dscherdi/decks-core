// Convert a card's raw markdown into plain text suitable for text-to-speech.
// Platform-agnostic and pure so it can be unit-tested and reused outside the
// plugin. Strips markdown syntax, links/embeds, and HTML, and either keeps or
// masks cloze deletions (==answer==) depending on the caller.

export interface ToSpeechOptions {
  // When true, cloze deletions are replaced with a spoken placeholder so the
  // answer is not read aloud (used while the card front is shown). When false,
  // the delimiters are stripped and the answer text is kept (answer shown).
  maskCloze?: boolean;
  // Word spoken in place of a masked cloze deletion. Default "blank".
  clozePlaceholder?: string;
}

const CLOZE_RE = /==((?:(?!==).)+)==/g;

export function toSpeechText(markdown: string, options: ToSpeechOptions = {}): string {
  if (!markdown) return "";
  const { maskCloze = false, clozePlaceholder = "blank" } = options;

  let text = markdown;

  // Cloze deletions first, before emphasis stripping touches the delimiters.
  text = text.replace(CLOZE_RE, (_m, inner: string) =>
    maskCloze ? ` ${clozePlaceholder} ` : inner
  );

  // Embeds (images, audio, transcluded notes) carry no spoken text.
  text = text.replace(/!\[\[[^\]]*\]\]/g, " ");
  // Wikilinks: [[target|label]] -> label, [[target]] -> last path segment.
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, body: string) => {
    const parts = body.split("|");
    const shown = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const segments = shown.split("/");
    return segments[segments.length - 1];
  });
  // Markdown images drop; markdown links keep their label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Code: drop fence lines, keep inline code contents.
  text = text.replace(/```[^\n]*\n?/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");

  // Inline HTML tags.
  text = text.replace(/<[^>]+>/g, " ");

  // Emphasis / strikethrough markers.
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // Line-level markers (headings, blockquotes, list bullets, table pipes).
  text = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*([-*+]|\d+\.)\s+/, "")
        .replace(/\|/g, " ")
    )
    .join("\n");

  return text.replace(/\s+/g, " ").trim();
}
