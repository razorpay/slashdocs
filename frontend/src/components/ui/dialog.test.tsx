import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { TooltipProvider } from "./tooltip";

function renderDialog(children?: ReactNode) {
  render(
    <TooltipProvider>
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          {children}
        </DialogContent>
      </Dialog>
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe("DialogContent", () => {
  it("takes the focus itself when Close is its only control", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  });

  it("focuses its first control otherwise", async () => {
    renderDialog(<button type="button">Save</button>);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toHaveFocus(),
    );
  });
});
