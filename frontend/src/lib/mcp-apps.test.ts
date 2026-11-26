import { afterEach, expect, it } from "vitest";
import { mcpApps } from "./mcp-apps";

const URL = "https://docs.example/mcp";

afterEach(() => {
  delete window.__SLASHDOCS_BRAND__;
});

function href(id: string) {
  return decodeURIComponent(mcpApps(URL).find((app) => app.id === id)!.href);
}

it("names the server slashdocs without a brand", () => {
  expect(href("claude")).toContain("connectorName=slashdocs");
  expect(href("claude-code")).toContain(
    `claude mcp add --transport http --scope user slashdocs ${URL}`,
  );
});

it("names the server after the brand", () => {
  window.__SLASHDOCS_BRAND__ = { name: "Acme Artifacts" };
  // The display name where the app shows it, and a slug in commands and configs.
  expect(href("claude")).toContain("connectorName=Acme+Artifacts");
  expect(href("claude-code")).toContain("Add the Acme Artifacts MCP server.");
  expect(href("claude-code")).toContain(
    `--scope user acme-artifacts ${URL} && claude mcp login acme-artifacts`,
  );
  expect(href("codex")).toContain(`codex mcp add acme-artifacts --url ${URL}`);
  expect(href("vscode")).toContain(`"name":"acme-artifacts"`);
});
