import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment } from "@/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocProvider, type DocContextValue } from "./doc-context";
import { ReactionBar, ReactionTooltip } from "./doc-comment-reactions";

afterEach(cleanup);

it("lists only names or emails for users and service accounts, even with a shared id", () => {
  render(
    <ReactionTooltip
      reactors={[
        { type: "user", id: "shared", name: "  Alex  ", email: "alex@example.com" },
        { type: "user", id: "nameless", name: " ", email: "reviewer@example.com" },
        { type: "service_account", id: "shared", name: "Review bot" },
        {
          type: "service_account",
          id: "email-bot",
          email: "review@friendly.otter.bot",
        },
      ]}
    />,
  );
  const rows = within(screen.getByRole("list", { name: "Reacted by" })).getAllByRole(
    "listitem",
  );
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveTextContent(/^Alex$/);
  expect(screen.queryByText("alex@example.com")).not.toBeInTheDocument();
  expect(rows[1]).toHaveTextContent("reviewer@example.com");
  expect(rows[2]).toHaveTextContent(/^Review bot$/);
  expect(rows[3]).toHaveTextContent(/^review@friendly\.otter\.bot$/);
});

const onOuterEscape = vi.fn();

function renderBar(reactions: Comment["reactions"] = []) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={{ principal: undefined } as unknown as DocContextValue}>
        <TooltipProvider>
          {/* The thread around the bar closes on an Escape that reaches it. */}
          <div onKeyDown={(e) => e.key === "Escape" && onOuterEscape()}>
            <ReactionBar c={{ id: "c1", reactions } as Comment} docId="doc_1" />
          </div>
        </TooltipProvider>
      </DocProvider>
    </QueryClientProvider>,
  );
}

it("moves over the nine reactions as a 3x3 grid that wraps, and Escape gives the focus back", async () => {
  const user = userEvent.setup();
  renderBar([{ emoji: "heart", count: 2, reacted: true }]);
  const trigger = screen.getByRole("button", { name: "Add reaction" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "Add reaction" });
  const items = within(menu).getAllByRole("menuitemcheckbox");
  expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
    "Thumbs up",
    "Thumbs down",
    "Laugh",
    "Celebrate",
    "Confused",
    "Love",
    "Rocket",
    "Eyes",
    "Plus one",
  ]);
  expect(items[5]).toHaveAttribute("aria-checked", "true");
  expect(items[0]).toHaveFocus();
  const path: [string, number][] = [
    ["{ArrowDown}", 3],
    ["{ArrowDown}", 6],
    ["{ArrowDown}", 0],
    ["{ArrowUp}", 6],
    ["{ArrowRight}", 7],
    ["{ArrowRight}", 8],
    ["{ArrowRight}", 0],
    ["{ArrowLeft}", 8],
    ["{ArrowUp}", 5],
  ];
  for (const [key, index] of path) {
    await user.keyboard(key);
    expect(items[index], key).toHaveFocus();
  }
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(onOuterEscape).not.toHaveBeenCalled();
});
