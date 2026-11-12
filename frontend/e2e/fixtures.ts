import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type FrameLocator,
  type Page,
  type Route,
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

async function installAppStorage(page: Page) {
  await page.addInitScript(
    ({ appOrigin, onboarding }) => {
      if (window.location.origin !== appOrigin) return;
      window.localStorage.setItem("slashdocs.onboarding", JSON.stringify(onboarding));
      window.localStorage.setItem("slashdocs:view-mode", JSON.stringify("list"));
    },
    { appOrigin: APP_ORIGIN, onboarding: ONBOARDING_STATE },
  );
}

// bridge is the window of the app in the document frame. It draws the pins,
// the cursors and the hints over the document.
export function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

// renderedDocument is the document itself, in the bridge.
export function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

// startEditing turns on Edit mode with Edit in the document bar, as each
// document opens in Comment mode, and waits until its text takes edits.
export async function startEditing(page: Page) {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
}

// notSaved is the chip that shows edits that did not save, with Retry. It
// is the only state of a save that the bar shows.
export const notSaved = (page: Page) =>
  page.getByRole("button", { name: "Not saved · Retry" });

// openHistory opens the history of the document from the More menu.
export async function openHistory(page: Page) {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
}

// openEditable opens a document as an editor, in Edit mode.
export async function openEditable(page: Page, id: string) {
  await page.goto(`/app/d/${id}`);
  await startEditing(page);
}

// latestSource gives the live document on the server.
export async function latestSource(page: Page, id: string): Promise<string> {
  const document = await page.request.get(`/v1/documents/${id}`);
  const { current_version_id } = (await document.json()) as DocumentRecord;
  return (
    await page.request.get(`/v1/documents/${id}/versions/${current_version_id}/html`)
  ).text();
}

// apiPost posts data to an API path as the person of page, and makes sure
// that the server takes it.
export async function apiPost(page: Page, path: string, data: object) {
  const response = await page.request.post(path, {
    headers: { Origin: APP_ORIGIN },
    data,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

// hold keeps each request to a path until the test calls the returned
// release, and then gives the response.
export async function hold(page: Page, url: string, method: string, response?: object) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    await released;
    await (response ? route.fulfill(response) : route.continue());
  });
  return release;
}

// goInApp moves the app to a path without a reload, as a link does.
export async function goInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

export type Box = { x: number; y: number; width: number; height: number };

// overlaps tells whether two boxes share some area.
export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

// toastsOver tells whether a toast covers box, in the app.
export async function toastsOver(page: Page, box: Box): Promise<boolean> {
  const toasts = await page.locator("[data-sonner-toast]").all();
  for (const toast of toasts) {
    const at = await toast.boundingBox();
    if (at && overlaps(at, box)) return true;
  }
  return false;
}

export const QUICK = "The quick brown fox jumps over the lazy dog.";

// paragraphsHTML gives a document of numbered paragraphs, from p0, in a
// centered column with page margins at both sides.
export function paragraphsHTML(
  title: string,
  { paragraphs = 30, width = 480, margin = 40 } = {},
) {
  const numbered = Array.from(
    { length: paragraphs },
    (_, i) => `<p id="p${i}">Paragraph ${i}. ${QUICK} ${QUICK}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:${width}px;margin:${margin}px auto;padding:0 16px;font:16px/1.5 sans-serif}h1{margin-top:12px}</style>
  </head>
  <body><h1 id="top">${title}</h1>${numbered}</body>
</html>`;
}

// signedOutPage opens a page in a new browser context without a session.
export async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await installAppStorage(page);
  return page;
}

// reviewerOn opens path as the reviewer of dev/dex-config.yaml, in a browser
// context of their own.
export async function reviewerOn(browser: Browser, path: string): Promise<Page> {
  const page = await signedOutPage(browser);
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await continueWithDex(page, "reviewer@example.com");
  await expect(page).toHaveURL(`${APP_ORIGIN}${path}`);
  return page;
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

// continueWithDex signs in as a Dex dev user from the slashdocs login page:
// the admin, or another user of dev/dex-config.yaml.
export async function continueWithDex(page: Page, email = "admin@example.com") {
  await page.getByRole("link", { name: "Continue with Dex" }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(new URL(DEX_ORIGIN).origin);

  await page.locator('input[name="login"]').fill(email);
  await page.locator('input[name="password"]').fill("password");
  await page.getByRole("button", { name: /login/i }).click();
}

type DocumentRecord = {
  id: string;
  current_version_id: string;
  seq: number;
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

  // pushVersion pushes html as an agent does. With no base, the agent read
  // the live document just now, which can be an open version at a seq.
  async pushVersion(
    id: string,
    html: string,
    baseVersionID?: string,
  ): Promise<VersionRecord> {
    const live = baseVersionID ? undefined : await this.getDocument(id);
    return responseJSON<VersionRecord>(
      await this.request.post(`/v1/documents/${id}/versions`, {
        headers: this.writeHeaders(),
        multipart: {
          base_version_id: baseVersionID ?? live!.current_version_id,
          ...(live && { base_seq: String(live.seq) }),
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

  async shareWithAnyone(
    id: string,
    role: "viewer" | "commenter" | "editor",
  ): Promise<{ id: string }> {
    return responseJSON(
      await this.request.post(`/v1/documents/${id}/grants`, {
        headers: this.writeHeaders(),
        data: { principal: { type: "anyone" }, role },
      }),
      `share ${id} with anyone`,
    );
  }

  async share(id: string, address: string, role: "viewer" | "commenter" | "editor") {
    await responseJSON(
      await this.request.post(`/v1/documents/${id}/grants`, {
        headers: this.writeHeaders(),
        data: { address, role },
      }),
      `share ${id} with ${address}`,
    );
  }

  // addApprover gives a person view access, and adds them as an approver.
  async addApprover(id: string, address: string) {
    await this.share(id, address, "viewer");
    await responseJSON(
      await this.request.post(`/v1/documents/${id}/approvers`, {
        headers: this.writeHeaders(),
        data: { address },
      }),
      `add approver ${address} to ${id}`,
    );
  }

  async removeGrant(id: string, grantID: string) {
    await expectCleanupResponse(
      await this.request.delete(`/v1/documents/${id}/grants/${grantID}`, {
        headers: this.writeHeaders(),
      }),
      `remove grant ${grantID} of ${id}`,
    );
  }

  async createComment(
    id: string,
    body: string,
    anchor: { quote?: string; point?: Record<string, unknown> },
  ): Promise<{ id: string }> {
    return responseJSON(
      await this.request.post(`/v1/documents/${id}/comments`, {
        headers: this.writeHeaders(),
        data: {
          version_id: (await this.getDocument(id)).current_version_id,
          body,
          anchor: { quote: "", ...anchor },
        },
      }),
      `comment on ${id}`,
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
