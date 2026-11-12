import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/misc";
import { BrandMark, type Brand } from "@/components/brand-mark";
import { publicURL } from "@/lib/config";
import { mcpApps } from "@/lib/mcp-apps";
import { cn } from "@/lib/cn";

// Each button takes its provider's colors, so people find their app by sight.
const THEME: Record<Brand, string> = {
  claude: "bg-[#D97757] text-white hover:bg-[#C6613F]",
  "claude-code": "bg-[#1F1E1D] text-[#D97757] hover:bg-[#2B2A28]",
  codex: "bg-white text-black hover:bg-neutral-200",
  cursor: "bg-black text-white hover:bg-neutral-800",
  vscode: "bg-[#007ACC] text-white hover:bg-[#0065A9]",
};

export function McpConnect() {
  const url = `${publicURL()}/mcp`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {mcpApps(url).map((app) => (
          <Button
            key={app.id}
            asChild
            className={cn("h-11 shadow-[var(--shadow-border)]", THEME[app.id])}
          >
            {/* An app link (cursor:, vscode:, ...) opens the app, not a page. */}
            <a
              href={app.href}
              {...(app.href.startsWith("https:") && {
                target: "_blank",
                rel: "noreferrer",
              })}
            >
              <BrandMark brand={app.id} className="h-5 w-5 shrink-0" />
              <span className={cn(app.id === "claude-code" && "text-white")}>
                {app.label}
              </span>
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
