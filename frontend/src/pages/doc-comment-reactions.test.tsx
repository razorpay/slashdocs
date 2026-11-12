import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReactionTooltip } from "./doc-comment-reactions";

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
