import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { fileURLToPath } from "node:url";

export const APP_ORIGIN = new URL(
  process.env.SLASHDOCS_E2E_BASE_URL ?? "http://localhost:8080",
).origin;
export const RENDER_ORIGIN =
  process.env.SLASHDOCS_E2E_RENDER_ORIGIN ?? "http://127.0.0.1:8080";
export const AUTH_STATE_PATH = fileURLToPath(
  new URL("./.auth/user.json", import.meta.url),
);

const DEX_ORIGIN = process.env.SLASHDOCS_E2E_DEX_ORIGIN ?? "http://localhost:5556";
const ONBOARDING_STATE = {
  status: "skipped",
  steps: {
    cli_installed: false,
    cli_authed: false,
    agent_configured: false,
    first_doc_seen: false,
  },
};

export async function installAppStorage(page: Page) {
  await page.addInitScript(
    ({ appOrigin, onboarding }) => {
      if (window.location.origin !== appOrigin) return;
      window.localStorage.setItem("slashdocs.onboarding", JSON.stringify(onboarding));
      window.localStorage.setItem("slashdocs:view-mode", JSON.stringify("list"));
    },
    { appOrigin: APP_ORIGIN, onboarding: ONBOARDING_STATE },
  );
}

export async function loginThroughDex(page: Page) {
  await installAppStorage(page);
  await page.goto("/login?next=%2Fapp%2Fdocuments");
  await expect(
    page.getByRole("heading", { name: "Sign in to slashdocs" }),
  ).toBeVisible();

  await continueWithDex(page);

  await expect(page).toHaveURL(`${APP_ORIGIN}/app/documents`);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
}

// continueWithDex signs in as the Dex dev user from the slashdocs login page.
export async function continueWithDex(page: Page) {
  await page.getByRole("link", { name: "Continue with Dex" }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(new URL(DEX_ORIGIN).origin);

  await page.locator('input[name="login"]').fill("admin@example.com");
  await page.locator('input[name="password"]').fill("password");
  await page.getByRole("button", { name: /login/i }).click();
}

type DocumentRecord = {
  id: string;
  current_version_id: string;
  title?: string;
  parent_folder_id?: string;
};

type VersionRecord = {
  id: string;
  number: number;
  sha256: string;
  change_summary?: string;
};

type AccessItem = {
  principal: { type: string; id: string; name?: string };
  effective_role: string;
};

async function responseJSON<T>(response: APIResponse, operation: string): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${operation} failed (${response.status()}): ${body}`);
  }
  return JSON.parse(body) as T;
}

async function expectCleanupResponse(response: APIResponse, operation: string) {
  if (response.ok() || response.status() === 404) return;
  throw new Error(
    `${operation} failed (${response.status()}): ${await response.text()}`,
  );
}

export class SlashdocsAPI {
  private readonly documentIDs = new Set<string>();
  private readonly folderIDs = new Set<string>();

  constructor(private readonly request: APIRequestContext) {}

  private writeHeaders() {
    return { Origin: APP_ORIGIN };
  }

  trackDocument(id: string) {
    this.documentIDs.add(id);
  }

  trackFolder(id: string) {
    this.folderIDs.add(id);
  }

  untrackFolder(id: string) {
    this.folderIDs.delete(id);
  }

  async createDocument(title: string, html: string): Promise<DocumentRecord> {
    const result = await responseJSON<DocumentRecord>(
      await this.request.post("/v1/documents", {
        headers: this.writeHeaders(),
        multipart: {
          title,
          file: {
            name: "browser-e2e.html",
            mimeType: "text/html",
            buffer: Buffer.from(html),
          },
        },
      }),
      `create document ${title}`,
    );
    this.trackDocument(result.id);
    return result;
  }

  async getDocument(id: string): Promise<DocumentRecord> {
    return responseJSON<DocumentRecord>(
      await this.request.get(`/v1/documents/${id}`),
      `get document ${id}`,
    );
  }

  async pushVersion(
    id: string,
    html: string,
    baseVersionID?: string,
  ): Promise<VersionRecord> {
    const base = baseVersionID ?? (await this.getDocument(id)).current_version_id;
    return responseJSON<VersionRecord>(
      await this.request.post(`/v1/documents/${id}/versions`, {
        headers: this.writeHeaders(),
        multipart: {
          base_version_id: base,
          file: {
            name: "browser-e2e-v2.html",
            mimeType: "text/html",
            buffer: Buffer.from(html),
          },
        },
      }),
      `push version for ${id}`,
    );
  }

  async documentAccess(id: string): Promise<AccessItem[]> {
    const result = await responseJSON<{ items: AccessItem[] }>(
      await this.request.get(`/v1/documents/${id}/access`),
      `get access for ${id}`,
    );
    return result.items;
  }

  async shareWithAnyone(id: string, role: "viewer" | "commenter" | "editor") {
    await responseJSON(
      await this.request.post(`/v1/documents/${id}/grants`, {
        headers: this.writeHeaders(),
        data: { principal: { type: "anyone" }, role },
      }),
      `share ${id} with anyone`,
    );
  }

  async patchKV(id: string, key: string, value: string) {
    await responseJSON(
      await this.request.patch(`/v1/documents/${id}/kv`, {
        headers: this.writeHeaders(),
        data: { set: { [key]: value } },
      }),
      `patch KV for ${id}`,
    );
  }

  async cleanup() {
    for (const id of this.documentIDs) {
      await expectCleanupResponse(
        await this.request.delete(`/v1/documents/${id}`, {
          headers: this.writeHeaders(),
        }),
        `delete document ${id}`,
      );
    }
    for (const id of this.folderIDs) {
      await expectCleanupResponse(
        await this.request.delete(`/v1/folders/${id}`, {
          headers: this.writeHeaders(),
        }),
        `delete folder ${id}`,
      );
    }
  }
}

export const test = base.extend<{ slashdocs: SlashdocsAPI }>({
  slashdocs: async ({ page }, use) => {
    const slashdocs = new SlashdocsAPI(page.request);
    await use(slashdocs);
    await slashdocs.cleanup();
  },
});

export { expect };

export function uniqueName(prefix: string) {
  return `${prefix} ${Date.now().toString(36)} ${crypto.randomUUID().slice(0, 8)}`;
}
