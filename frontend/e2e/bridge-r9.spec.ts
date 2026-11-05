import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

const SENTENCE = "Clients retry twice before giving up, and the notes say why. ";

// Paragraphs of text from the top to below the bottom of the viewport, with
// no clear room under or over a word.
function denseHTML(title: string) {
  const paragraphs = Array.from(
    { length: 14 },
    (_, i) => `<p id="p${i}">${SENTENCE.repeat(4)}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}
    p{margin:8px 0}.badge{padding:1px 6px;border-radius:4px;background:#fef3c7}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <h2 id="steps">Steps</h2>
    <p id="status">Status <span class="badge" id="badge">Pending</span> for review.</p>
    ${paragraphs}
  </body>
</html>`;
}

test.describe("at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // The link field opens at its words, also where text is all around them,
  // and its note grows with no move of the field.
  test("the link field opens next to its words in a dense paragraph", async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Link place");
    const document = await slashdocs.createDocument(title, denseHTML(title));
    await page.goto(`/app/d/${document.id}`);
    const doc = renderedDocument(page);
    await expect(doc.locator("body")).toHaveAttribute("contenteditable", "true");
    const card = doc.locator(".slashdocs-link-input > div");
    const field = doc.getByRole("textbox", { name: "Link address" });
    // The card holds its top, or its bottom when it grows up.
    const rect = () =>
      card.evaluate((el) => {
        const { left, right, top, bottom, width } = el.getBoundingClientRect();
        const edge = el.style.top === "auto" ? bottom : top;
        return { left, right, top, bottom, width, edge };
      });

    // The heading, then the first "twice" past a share of the viewport:
    // words high and low in the page, and words near its bottom.
    for (const at of ["steps", 0.2, 0.5, 0.85, 0.88, 0.91, 0.94]) {
      const word = await doc.locator("body").evaluate((body, at) => {
        const d = body.ownerDocument;
        const range = d.createRange();
        const select = (text: Text, start: number, length: number) => {
          range.setStart(text, start);
          range.setEnd(text, start + length);
        };
        // The heading's link sits before or after its words.
        const steps = [...d.getElementById("steps")!.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE,
        ) as Text;
        if (at === "steps") select(steps, 0, 5);
        else {
          const texts = [...d.querySelectorAll("p[id^=p]")].map(
            (p) => p.firstChild as Text,
          );
          found: for (const text of texts)
            for (let i = 0; (i = text.data.indexOf("twice", i + 1)) > 0;) {
              select(text, i, 5);
              if (range.getBoundingClientRect().top > innerHeight * Number(at))
                break found;
            }
        }
        body.focus();
        d.getSelection()!.removeAllRanges();
        d.getSelection()!.addRange(range);
        const { left, right, top, bottom } = range.getBoundingClientRect();
        return { left, right, top, bottom };
      }, at);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(field).toBeFocused();
      // The card waits out its entrance before it is measured.
      await page.waitForTimeout(300);
      const box = await rect();
      // Below, above or beside the word, and clear of it.
      const gaps = [
        Math.max(box.left - word.right, word.left - box.right),
        Math.max(box.top - word.bottom, word.top - box.bottom),
      ];
      expect(
        Math.max(...gaps),
        `the field is clear of the word (${at})`,
      ).toBeGreaterThan(0);
      expect(gaps[1], `the field is next to the word (${at})`).toBeLessThan(60);

      // The note grows away from the words, in the viewport, and the field
      // stays still.
      await field.fill("exa mple");
      await field.press("Enter");
      await expect(card.locator("p")).toHaveText("This is not a link.");
      const noted = await rect();
      expect([noted.left, noted.width, noted.edge]).toEqual([
        box.left,
        box.width,
        box.edge,
      ]);
      expect(noted.bottom, `the note is in the viewport (${at})`).toBeLessThanOrEqual(
        await card.evaluate((el) => el.ownerDocument.documentElement.clientHeight),
      );
      await field.press("Escape");
      await expect(card).toHaveCount(0);
    }
  });
});

// The keycast is hidden from screen readers. Its line runs out with the time.
const keycast = (page: Page) => page.locator('[aria-label="Time to press a letter"]');
const placeHint = (page: Page) => bridge(page).locator(".sd-place-hint");

// An Esc that leaves the text is the text's: Esc, then C, as the empty
// Comments list says, places a pin at any speed. A second Esc arms the chord.
test("Esc that leaves the text arms no chord", async ({ page, slashdocs }) => {
  const title = uniqueName("Esc text");
  const document = await slashdocs.createDocument(title, denseHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("body")).toHaveAttribute("contenteditable", "true");
  await doc.locator("#p0").click();

  await page.keyboard.press("Escape");
  await expect(keycast(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.keyboard.press("c");
  await expect(placeHint(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(placeHint(page)).toBeHidden();

  // With no caret in the text, Esc, then C opens the comments.
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape");
  await expect(keycast(page)).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();
  await expect(placeHint(page)).toBeHidden();
});

// The bridge's controls in the document are not its text: Cmd+A does not
// select the actions at the selection.
test("select all leaves the selection actions out", async ({ page, slashdocs }) => {
  const title = uniqueName("Select all");
  const document = await slashdocs.createDocument(title, denseHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("body")).toHaveAttribute("contenteditable", "true");
  await doc.locator("#p0").click();
  await page.keyboard.press("ControlOrMeta+a");
  const actions = doc.locator(".slashdocs-selection-action");
  await expect(actions).toBeVisible();
  const selected = await actions.evaluate((el) => ({
    held: el.ownerDocument.getSelection()!.containsNode(el, true),
    styles: [
      ...new Set(
        [el, ...el.querySelectorAll("*")].map(
          (each) => getComputedStyle(each).userSelect,
        ),
      ),
    ],
  }));
  expect(selected).toEqual({ held: false, styles: ["none"] });
});

// The tip of a pin whose face is away from it is an open ring, so the
// letter under it shows, and the pointer line stops at the ring.
test("the tip of a pin on a short word leaves the word readable", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Pin tip");
  const document = await slashdocs.createDocument(title, denseHTML(title));
  await slashdocs.createComment(document.id, "On the badge", {
    point: { target: "badge", x: 0.5, y: 0.5 },
  });
  await page.goto(`/app/d/${document.id}`);
  // The face goes beside the badge, and its pointer shows.
  const line = bridge(page).locator(".sd-pin s");
  await expect(line).toBeVisible();
  const tip = await line.evaluate((s) => {
    const ring = getComputedStyle(s, "::after");
    const style = getComputedStyle(s);
    return {
      center: ring.backgroundColor,
      border: parseFloat(ring.borderTopWidth) > 0,
      stop: parseFloat(style.getPropertyValue("--len")) - parseFloat(style.width),
    };
  });
  expect(tip).toMatchObject({ center: "rgba(0, 0, 0, 0)", border: true });
  expect(tip.stop).toBeCloseTo(3.5, 1);
});
