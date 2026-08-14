import { I18n } from "../i18n/I18n";

/**
 * The getting-started files a fresh install writes into an empty vault.
 *
 * Shared vocabulary: both surfaces write the same note, at the same path, in
 * the user's own language. The strings already live in this package, so the
 * builder that turns them into a file belongs here too — a surface only has to
 * supply its own way of creating a file.
 */

/** Vault-relative path of the getting-started deck. */
export function getTestDeckPath(folderPath?: string): string {
  const filename = I18n.t.testDeck.filename;
  const folder = folderPath?.trim().replace(/\/$/, "") ?? "";
  return folder ? `${folder}/${filename}` : filename;
}

/**
 * Folder the sample template belongs in: the configured one, or the localized
 * default when nothing is configured yet.
 */
export function getTemplateShowcaseFolder(currentTemplateFolder: string): string {
  const configured = currentTemplateFolder.trim().replace(/\/$/, "");
  return configured !== "" ? configured : I18n.t.testDeck.templateFolderName;
}

/** Vault-relative path of the sample template file inside `folder`. */
export function getTemplateShowcasePath(folder: string): string {
  return `${folder.replace(/\/$/, "")}/${I18n.t.testDeck.templateFileName}`;
}

/** Vault-relative path of the demo exam deck. */
export function getExamDeckPath(folderPath?: string): string {
  const filename = I18n.t.examDeck.filename;
  const folder = folderPath?.trim().replace(/\/$/, "") ?? "";
  return folder ? `${folder}/${filename}` : filename;
}

/**
 * Tag the demo exam deck carries: a child of the configured deck tag, so it is
 * found by the same scan and resolves to the Exams preset through the tag
 * mapping without touching how the base tag itself is bound.
 *
 * Two forms, and they are not interchangeable: a frontmatter `tags:` entry is
 * written bare, while a deck is identified — and a profile tag mapping matched
 * — by the `#`-prefixed form.
 */
export function getExamDeckFrontmatterTag(deckTag: string): string {
  return `${deckTag.replace(/^#/, "")}/exams`;
}

/** The demo exam deck's tag as a deck carries it, always `#`-prefixed. */
export function getExamDeckTag(deckTag: string): string {
  return `#${getExamDeckFrontmatterTag(deckTag)}`;
}

export function getTestDeckContent(deckTag: string): string {
  const tag = deckTag.replace("#", "");
  const t = I18n.t.testDeck;
  const tagBacktick = `\`${deckTag}\``;

  return `---
tags:
  - ${tag}
---
# ${t.title}

${I18n.format(t.intro, { tag: tagBacktick })}

${t.formatsHint}

---

## ${t.section1}

${t.section1Body}

## ${t.q1}

${t.a1}

## ${t.q2}

${I18n.format(t.a2, { tag: tagBacktick })}

---

## ${t.section2}

${t.section2Body}

${t.tableNote}

## ${t.fsrsConceptsHeading}

| ${t.colFront} | ${t.colBack} | ${t.colNotes} |
| --- | --- | --- |
| ${t.row1Front} | ${t.row1Back} | ${t.row1Notes} |
| ${t.row2Front} | ${t.row2Back} | ${t.row2Notes} |

---

## ${t.section3}

${t.section3Body}

## ${t.solarHeading}

${t.solarBody}

---

## ${t.section4}

${t.section4Body}

## ${t.bonesHeading}

![[arm_bones.png]]

1. ==${t.bone1}==
2. ==${t.bone2}==
3. ==${t.bone3}==

---

## ${t.section5}

${I18n.format(t.section5Body, { tag: t.templateTag })}

## ${t.templatesTableHeading} #${t.templateTag}

| ${t.tplColWord} | ${t.tplColReading} | ${t.tplColMeaning} |
| --- | --- | --- |
| ${t.tplRow1Word} | ${t.tplRow1Reading} | ${t.tplRow1Meaning} |
| ${t.tplRow2Word} | ${t.tplRow2Reading} | ${t.tplRow2Meaning} |

---
`;
}

/**
 * The demo exam deck.
 *
 * All prose lives under the H1 (never a card); every H2 is a question. No
 * scaffolding headings between cards — a heading at the parsed level IS a card
 * front, and deeper levels would nest under the preceding question.
 */
export function getExamDeckContent(deckTag: string): string {
  const examTag = getExamDeckFrontmatterTag(deckTag);
  const t = I18n.t.examDeck;
  const tagBacktick = `\`#${examTag}\``;

  return `---
tags:
  - ${examTag}
---
# ${t.title}

${I18n.format(t.intro, { tag: tagBacktick })}

${t.formatsHint}

${t.outro}

## ${t.mcq1Front}

- [ ] ${t.mcq1OptA}
- [x] ${t.mcq1OptB}
- [ ] ${t.mcq1OptC}
- [ ] ${t.mcq1OptD}

%%${t.mcq1Note}%%

## ${t.mcq2Front}

- [x] ${t.mcq2OptA}
- [ ] ${t.mcq2OptB}
- [x] ${t.mcq2OptC}
- [x] ${t.mcq2OptD}

## ${t.tfFront}

- [x] ${t.tfTrue}
- [ ] ${t.tfFalse}

## ${t.saFront}

${t.saBack}

## ${t.tableHeading}

| ${t.tColFront} | ${t.tColBack} | ${t.tColNotes} |
| --- | --- | --- |
| ${t.tRow1Front} | ${t.tRow1Back} | ${t.tRow1Notes} |
| ${t.tRow2Front} | ${t.tRow2Back} | ${t.tRow2Notes} |

## ${t.clozeHeading}

${t.clozeBody}
`;
}

/**
 * Sample template file for the getting-started "Templates" section. Bound by
 * the `templateTag` to the tagged table heading; uses positional variables
 * ({{1}}/{{2}}/{{3}}) so it works regardless of the localized column headers.
 */
export function getTemplateShowcaseContent(): string {
  const t = I18n.t.testDeck;
  return [
    "---",
    "tags:",
    `  - ${t.templateTag}`,
    "---",
    "",
    "```decks-html-front",
    '<div class="decks-vocab-card">',
    "  <ruby>{{1}}<rt>{{2}}</rt></ruby>",
    "</div>",
    "<style>",
    "  .decks-vocab-card { font-size: 2.6em; text-align: center; padding: 16px; }",
    "  .decks-vocab-card rt { font-size: 0.35em; color: var(--text-muted); }",
    "</style>",
    "```",
    "",
    "```decks-md-back",
    "**{{3}}**",
    "```",
    "",
  ].join("\n");
}
