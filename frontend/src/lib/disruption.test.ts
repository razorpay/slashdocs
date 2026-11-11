import { describe, expect, test } from "vitest";
import { disruption, QUIET_MAX_PLACES, QUIET_MAX_WORDS } from "./disruption";
import { parseSource } from "./source-edits";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const score = async (body: string, next: string) =>
  disruption(await parseSource(page(body)), page(next));
const words = (count: number) =>
  Array.from({ length: count }, (_, i) => `w${i}`).join(" ");

describe("disruption", () => {
  test("gives zero for the same source", async () => {
    expect(await score("<p>one</p>", "<p>one</p>")).toEqual({
      words: 0,
      places: 0,
      reload: false,
      disruptive: false,
    });
  });

  test("counts the words that a change adds and removes", async () => {
    expect(await score("<p>one two three</p>", "<p>one 2 three four</p>")).toEqual({
      words: 3,
      places: 1,
      reload: false,
      disruptive: false,
    });
  });

  test("counts the text that a reader sees, not the tags", async () => {
    expect(
      await score(
        `<p>one two</p><p>three</p>`,
        `<p>one <a href="https://example.com/a/long/link" class="link">two</a></p><p>three</p>`,
      ),
    ).toMatchObject({ words: 0, places: 1, disruptive: false });
    expect(
      await score(
        "<p>Tom&nbsp;&amp;&nbsp;Jerry</p>",
        "<p>Tom&nbsp;&amp;&nbsp;Jerry run</p>",
      ),
    ).toMatchObject({ words: 1 });
    // A non-breaking space divides words, as a space does.
    expect(await score("<p>a</p>", "<p>a&nbsp;b&#160;c d</p>")).toMatchObject({
      words: 3,
    });
  });

  test("counts a new paragraph and a removed one", async () => {
    expect(
      await score("<p>one</p><p>two</p>", "<p>one</p><p>three four</p><p>two</p>"),
    ).toMatchObject({ words: 2, places: 1 });
    expect(
      await score("<p>one</p><p>three four</p><p>two</p>", "<p>one</p><p>two</p>"),
    ).toMatchObject({ words: 2, places: 1 });
  });

  test("counts each run that changes as a place", async () => {
    expect(
      await score(
        "<p>one</p><p>two</p><p>three</p>",
        "<p>one!</p><p>two</p><p>three!</p>",
      ),
    ).toMatchObject({ words: 4, places: 2, disruptive: false });
  });

  test("is disruptive above the limit of words", async () => {
    const most = await score("<p>start</p>", `<p>start ${words(QUIET_MAX_WORDS)}</p>`);
    expect(most).toMatchObject({ words: QUIET_MAX_WORDS, disruptive: false });
    const more = await score(
      "<p>start</p>",
      `<p>start ${words(QUIET_MAX_WORDS + 1)}</p>`,
    );
    expect(more).toMatchObject({ words: QUIET_MAX_WORDS + 1, disruptive: true });
  });

  test("is disruptive above the limit of places", async () => {
    // Eight paragraphs, with a change in the first ones.
    const paragraphs = (changed: number) =>
      Array.from(
        { length: 8 },
        (_, i) => `<p>text ${i}${i < changed ? "!" : ""}</p><hr>`,
      ).join("");
    const most = await score(paragraphs(0), paragraphs(QUIET_MAX_PLACES));
    expect(most).toMatchObject({ places: QUIET_MAX_PLACES, disruptive: false });
    const more = await score(paragraphs(0), paragraphs(QUIET_MAX_PLACES + 1));
    expect(more).toMatchObject({ places: QUIET_MAX_PLACES + 1, disruptive: true });
  });

  test("is disruptive with no counts when the change cannot apply in place", async () => {
    expect(
      await score(
        "<p>a</p><script>let a = 1;</script>",
        "<p>a</p><script>let a = 2;</script>",
      ),
    ).toEqual({ words: 0, places: 0, reload: true, disruptive: true });
  });
});
