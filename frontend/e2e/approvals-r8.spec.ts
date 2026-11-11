import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// In the Approvals dialog, the search shows a person who cannot edit the
// document. A pick asks to give them editor access, and then adds them.

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Review</title></head>
<body><h1>Review</h1><p>Please approve.</p></body></html>`;

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`a pick of a person without access asks, and gives them editor access (${viewport.width} px)`, async ({
    page,
    slashdocs,
  }) => {
    await page.setViewportSize(viewport);
    const document = await slashdocs.createDocument(uniqueName("Approvals R8"), HTML);
    await page.goto(`/app/d/${document.id}?approvals=1`);
    const dialog = page.getByRole("dialog", { name: "Approvals" });
    const field = dialog.getByRole("combobox", { name: "Approver" });
    await expect(field).toBeFocused();

    await field.fill("rev");
    const option = dialog.getByRole("option", { name: /reviewer/i });
    await expect(option).toContainText("No access");
    await option.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(
      "can't open this document. Give them editor access and add them as an approver?",
    );
    // The confirmation fits on the screen, over the approvals.
    const box = (await confirm.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

    // Cancel gives nothing, and the focus goes back to the search.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(field).toBeFocused();
    await expect(dialog).toBeVisible();

    await field.press("Enter");
    await page.getByRole("button", { name: "Give access and add" }).click();
    await expect(
      page.getByText(/^Gave .+ editor access and added them as approver\.$/),
    ).toBeVisible();
    await expect(dialog.getByText("Pending", { exact: true })).toBeVisible();
    await expect(field).toBeFocused();

    const access = await page.request.get(`/v1/documents/${document.id}/access`, {
      headers: { Origin: APP_ORIGIN },
    });
    const { items } = (await access.json()) as {
      items: { principal: { email?: string }; effective_role: string }[];
    };
    expect(
      items.find((i) => i.principal.email === "reviewer@example.com")?.effective_role,
    ).toBe("editor");
  });
}
