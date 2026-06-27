/**
 * Converts Anki LaTeX markup to Decks markdown. Anki supports three forms:
 *   [$]…[/$]    inline math   → $…$
 *   [$$]…[/$$]  block math    → $$…$$
 *   [latex]…[/latex]  a LaTeX snippet (compiled to an image by Anki) → markdown
 *
 * A `[latex]` block holds arbitrary LaTeX: tabular truth-tables, enumerate lists,
 * `\textbf`, German accents (`\"a`), etc., interleaved with `$…$` math. We convert
 * the common constructs to markdown while keeping every `$…$`/`$$…$$` span verbatim
 * (MathJax renders those). Unknown commands pass through best-effort.
 *
 * Pure strings — no DOM. MUST run after the HTML→markdown step (turndown collapses
 * whitespace and would destroy generated tables/lists).
 */

export function convertAnkiLatexMarkup(text: string): string {
  if (!text || (!text.includes("[$") && !text.includes("[latex]") && !text.includes("[LATEX]"))) {
    return text;
  }
  let out = text.replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, (_m, body: string) => `$$${body.trim()}$$`);
  out = out.replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, (_m, body: string) => `$${body.trim()}$`);
  out = out.replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_m, body: string) => convertLatexBody(body));
  return out;
}

function convertLatexBody(input: string): string {
  let s = input.replace(/<br\s*\/?>/gi, "\n");
  // Strip layout-only wrappers / preamble.
  s = s.replace(/\\documentclass[^\n]*\n?/gi, "");
  s = s.replace(/\\(?:begin|end)\s*\{(?:center|document)\}/gi, "");
  s = s.replace(/\\hline/g, "");
  // Block environments (may contain $…$ cells/items — kept verbatim).
  s = s.replace(/\\begin\s*\{tabular\}\s*(?:\{[^}]*\})?([\s\S]*?)\\end\s*\{tabular\}/gi, (_m, b: string) =>
    tabularToTable(b)
  );
  s = s.replace(/\\begin\s*\{enumerate\}([\s\S]*?)\\end\s*\{enumerate\}/gi, (_m, b: string) =>
    listFromItems(b, true)
  );
  s = s.replace(/\\begin\s*\{itemize\}([\s\S]*?)\\end\s*\{itemize\}/gi, (_m, b: string) =>
    listFromItems(b, false)
  );
  // Inline conversions, applied only outside $…$ math.
  s = mapOutsideMath(s, convertInline);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function tabularToTable(body: string): string {
  const rows = splitOutsideMath(body, /\\\\/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length === 0) return "";
  const cellsByRow = rows.map((r) => splitOutsideMath(r, /&/).map((c) => c.trim()));
  const ncol = Math.max(...cellsByRow.map((c) => c.length));
  const pad = (cells: string[]): string => {
    const filled = [...cells];
    while (filled.length < ncol) filled.push("");
    return `| ${filled.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  };
  const header = pad(cellsByRow[0]);
  const sep = `| ${Array.from({ length: ncol }, () => "---").join(" | ")} |`;
  const rest = cellsByRow.slice(1).map(pad);
  return `\n${[header, sep, ...rest].join("\n")}\n`;
}

function listFromItems(body: string, ordered: boolean): string {
  const items = body
    .split(/\\item\b/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) return "";
  const lines = items.map((it, i) => `${ordered ? `${i + 1}.` : "-"} ${it.replace(/\n+/g, " ").trim()}`);
  return `\n${lines.join("\n")}\n`;
}

function convertInline(text: string): string {
  let t = applyAccents(text);
  t = applySymbols(t);
  t = t.replace(/\\textbf\s*\{([^}]*)\}/g, "**$1**");
  t = t.replace(/\\(?:textit|emph)\s*\{([^}]*)\}/g, "*$1*");
  // Outside math these are just text wrappers (inside $…$ they stay for MathJax).
  t = t.replace(/\\(?:textrm|textsf|texttt|textnormal|text|mbox)\s*\{([^}]*)\}/g, "$1");
  t = t.replace(/\\\\/g, "\n"); // line break outside math
  t = t.replace(/~/g, " "); // LaTeX nbsp
  return t;
}

// LaTeX text symbols/letters → UTF-8. A command may be terminated by an empty
// group (`\ss{}`) or a space; both are consumed. Unknown commands pass through.
const SYMBOLS: Record<string, string> = {
  ss: "ß",
  glqq: "„", grqq: "“", flqq: "«", frqq: "»", glq: "‚", grq: "‘",
  o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ",
  ldots: "…", dots: "…", textellipsis: "…",
  textendash: "–", textemdash: "—",
  textquotedblleft: "“", textquotedblright: "”", textquoteleft: "‘", textquoteright: "’",
  textbackslash: "\\", textasciitilde: "~", textasciicircum: "^",
  S: "§", P: "¶", copyright: "©", textdegree: "°", pounds: "£", texteuro: "€",
};

function applySymbols(text: string): string {
  // A control word is greedy letters; LaTeX consumes a trailing empty group or a
  // single space. Unknown commands (and their consumed group/space) pass through.
  return text.replace(/\\([a-zA-Z]+)(?:\{\}| )?/g, (m, cmd: string) => SYMBOLS[cmd] ?? m);
}

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: "ä", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü", e: "ë", i: "ï", y: "ÿ" },
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", n: "ń", c: "ć", s: "ś", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", O: "Ò", U: "Ù" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", O: "Ô", U: "Û" },
  "~": { n: "ñ", a: "ã", o: "õ", N: "Ñ", A: "Ã", O: "Õ" },
};

function applyAccents(text: string): string {
  // \"a, \"{a}, \'e, \`a, \^o, \~n …
  let t = text.replace(/\\(["'`^~])\s*\{?\s*([a-zA-Z])\s*\}?/g, (m, acc: string, ch: string) => {
    return ACCENTS[acc]?.[ch] ?? m;
  });
  // Cedilla takes an argument letter (\c{c}); \ss and the rest live in SYMBOLS.
  t = t.replace(/\\c\s*\{?\s*c\s*\}?/g, "ç").replace(/\\c\s*\{?\s*C\s*\}?/g, "Ç");
  return t;
}

// Apply `fn` to every span outside $…$/$$…$$ math, leaving math verbatim.
function mapOutsideMath(s: string, fn: (segment: string) => string): string {
  const re = /\$\$[\s\S]*?\$\$|\$[^$]*\$/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out += fn(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(s.slice(last));
}

// Split `s` on `sep`, but only where the separator sits outside $…$ math.
function splitOutsideMath(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let buf = "";
  const tokenizer = new RegExp(`\\$\\$[\\s\\S]*?\\$\\$|\\$[^$]*\\$|${sep.source}`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenizer.exec(s)) !== null) {
    const token = m[0];
    buf += s.slice(last, m.index);
    last = m.index + token.length;
    if (token.startsWith("$")) {
      buf += token; // math span — keep, don't split
    } else {
      parts.push(buf); // separator outside math
      buf = "";
    }
  }
  parts.push(buf + s.slice(last));
  return parts;
}
