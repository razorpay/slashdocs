import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE_PATH, loginThroughDex } from "./fixtures";

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
