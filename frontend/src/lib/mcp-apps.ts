import type { Brand } from "@/components/brand-mark";
import { productName, productSlug } from "@/lib/brand";

// One link per agent app that adds the slashdocs remote MCP server. Each app
// discovers the OAuth metadata from the URL, so no key changes hands. The
// server is named after the deployment's brand, when it has one: the display
// name where an app shows it, and a slug where it becomes a command argument.
export function mcpApps(url: string): { id: Brand; label: string; href: string }[] {
  const displayName = productName();
  const serverName = productSlug();
  // Claude Code and Codex have no install link, but each opens a new session
  // with a typed prompt. Nothing runs until the user sends it and allows it.
  const ask = (command: string) =>
    encodeURIComponent(
      `Add the ${displayName} MCP server. Run this command:\n${command}`,
    );
  return [
    {
      // Opens the add-connector dialog with the fields filled in. The
      // connector then syncs to the Claude desktop app and to Claude Code.
      // claude.ai owns these parameter names. When it renames them, it opens
      // a page without the dialog. To test the link, open it while logged in.
      id: "claude",
      label: "Claude",
      href: `https://claude.ai/customize/connectors?${new URLSearchParams({
        modal: "add-custom-connector",
        connectorName: displayName,
        connectorUrl: url,
      })}`,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      href: `claude-cli://open?q=${ask(
        `claude mcp add --transport http --scope user ${serverName} ${url} && claude mcp login ${serverName}`,
      )}`,
    },
    {
      // The ChatGPT desktop app, the Codex CLI, and the Codex IDE extension
      // share this setup.
      id: "codex",
      label: "ChatGPT / Codex",
      href: `codex://new?prompt=${ask(`codex mcp add ${serverName} --url ${url}`)}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${serverName}&config=${btoa(JSON.stringify({ url }))}`,
    },
    {
      id: "vscode",
      label: "VS Code",
      href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: serverName, type: "http", url }))}`,
    },
  ];
}
