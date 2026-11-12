import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, loginThroughDex, reviewerOn } from "./fixtures";

setup("authenticate through the real Dex browser flow", async ({ page }) => {
  await loginThroughDex(page);

  const response = await page.request.get("/v1/me");
  expect(response.ok()).toBeTruthy();
  const me = (await response.json()) as {
    principal: { email?: string };
    user?: { email?: string };
  };
  expect(me.user?.email ?? me.principal.email).toBe("admin@example.com");

  await mkdir(dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
});

// A person can share a document with a user only after the first sign-in of
// that user. A new database has no reviewer until they sign in once.
setup("the reviewer signs in once, so that they are a user", async ({ browser }) => {
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.context().close();
});
