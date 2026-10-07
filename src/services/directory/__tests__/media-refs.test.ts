import { directoryCardMarkdown, listDirectoryMediaRefs, parseDirectoryMediaPath, rewriteDirectoryMediaRefs } from "../media-refs";

const IMG = "a".repeat(64);
const MP3 = "b".repeat(64);
const url = (ref: { sha256: string; ext: string }) => `blob:${ref.sha256.slice(0, 4)}.${ref.ext}`;

describe("directory media references", () => {
  const text = `Flag ![[media/${IMG}.png|300]] and ![Map](media/${IMG}.png)\n![[media/${MP3}.mp3]]`;

  it("lists each referenced file once", () => {
    expect(listDirectoryMediaRefs(text)).toEqual([
      { sha256: IMG, ext: "png" },
      { sha256: MP3, ext: "mp3" },
    ]);
  });

  it("points embeds at loadable URLs, keeping size and alt text", () => {
    expect(rewriteDirectoryMediaRefs(text, url)).toBe(
      `Flag <img src="blob:aaaa.png" alt="" width="300"> and ![Map](blob:aaaa.png)\n<audio controls src="blob:bbbb.mp3"></audio>`
    );
  });

  it("leaves an embed alone when its file is unavailable", () => {
    expect(rewriteDirectoryMediaRefs(text, () => null)).toBe(text);
  });

  it("parses a bare package media path", () => {
    expect(parseDirectoryMediaPath(`media/${IMG}.png`)).toEqual({ sha256: IMG, ext: "png" });
    expect(parseDirectoryMediaPath("Images/flag.png")).toBeNull();
  });
});

describe("directoryCardMarkdown", () => {
  it("turns internal links into plain text and keeps media", () => {
    const text = `See [[Paris]] and [[Rome|the capital]]. ![[media/${IMG}.png]]`;
    expect(directoryCardMarkdown(text, url)).toBe("See Paris and the capital. ![](blob:aaaa.png)");
  });
});
