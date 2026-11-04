import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/misc";
import { BrandMark, type Brand } from "@/components/brand-mark";
import { publicURL } from "@/lib/config";
import { mcpApps } from "@/lib/mcp-apps";
import { cn } from "@/lib/cn";

// The buttons are neutral, so they read in both themes. Each logo takes its
// provider's color, so people find their app by sight. Monochrome logos keep
// the text color.
const MARK_COLOR: Partial<Record<Brand, string>> = {
  claude: "text-[#D97757]",
  "claude-code": "text-[#D97757]",
  vscode: "text-[#007ACC]",
};

export function McpConnect() {
  const url = `${publicURL()}/mcp`;
  // The columns follow the width of the step or card, not of the screen.
  return (
    <div className="@container space-y-4">
      <div className="grid gap-2 @sm:grid-cols-2 @xl:grid-cols-3">
        {mcpApps(url).map((app) => (
          <Button key={app.id} asChild variant="secondary" className="h-11">
            {/* An app link (cursor:, vscode:, ...) opens the app, not a page. */}
            <a
              href={app.href}
              {...(app.href.startsWith("https:") && {
                target: "_blank",
                rel: "noreferrer",
              })}
            >
              <BrandMark
                brand={app.id}
                className={cn("h-5 w-5 shrink-0", MARK_COLOR[app.id])}
              />
              {app.label}
            </a>
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <p className="text-xs text-[var(--color-fg-muted)]">
          Another app? Add a remote MCP server with this URL.
        </p>
        <CodeBlock>{url}</CodeBlock>
      </div>
    </div>
  );
}
