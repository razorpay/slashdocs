import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// A reviewer gives the open threads of a document to an agent in one paste.

test("Copy for an agent copies the open threads, in document order, with their replies", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Handoff");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>First words.</p><p>Second words.</p></body></html>`,
  );
  const second = await slashdocs.createComment(document.id, "Say more.", {
    quote: "Second words.",
  });
  const first = await slashdocs.createComment(document.id, "Too short.", {
    quote: "First words.",
  });
  const reply = await page.request.post(
    `/v1/documents/${document.id}/comments/${first.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "Agreed." } },
  );
  expect(reply.status()).toBe(201);
  const done = await slashdocs.createComment(document.id, "Done already.", {
    quote: "First words.",
  });
  const resolve = await page.request.patch(
    `/v1/documents/${document.id}/comments/${done.id}`,
    { headers: { Origin: APP_ORIGIN }, data: { status: "resolved" } },
  );
  expect(resolve.ok()).toBe(true);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Copy for an agent" }).click();
  await expect(
    page.getByText("Open threads copied. Paste them to your agent."),
  ).toBeVisible();

  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toBe(
    [
      `Review comments on the slashdocs document “${title}” (${document.id}): ${APP_ORIGIN}/app/d/${document.id}`,
      `1. Thread ${first.id} on “First words.”\n   admin: Too short.\n   admin: Agreed.`,
      `2. Thread ${second.id} on “Second words.”\n   admin: Say more.`,
      "Address each thread: change the document, or answer in the thread. Then reply in each thread with what you did. With the slashdocs CLI, read `slashdocs guidelines review` first.",
    ].join("\n\n"),
  );
});
