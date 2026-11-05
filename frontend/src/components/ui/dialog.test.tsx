import { useState, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "./dropdown";
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

function MenuDialog() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Dropdown>
        <DropdownTrigger asChild>
          <button type="button">More</button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem onSelect={() => setOpen(true)}>Move</DropdownItem>
        </DropdownContent>
      </Dropdown>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Move</DialogTitle>
          <button type="button">Move here</button>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

describe("a dialog that a menu item opens", () => {
  it.each(["pointer", "keyboard"])(
    "gives the focus back to the menu button, with the %s",
    async (way) => {
      const user = userEvent.setup();
      render(<MenuDialog />);
      const more = screen.getByRole("button", { name: "More" });
      if (way === "pointer") {
        await user.click(more);
        await user.click(await screen.findByRole("menuitem", { name: "Move" }));
      } else {
        more.focus();
        await user.keyboard("{Enter}");
        await screen.findByRole("menuitem", { name: "Move" });
        await user.keyboard("{Enter}");
      }
      await screen.findByRole("dialog", { name: "Move" });
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(more).toHaveFocus();
    },
  );
});

it("closes only the menu on Escape, not a layer around its button", async () => {
  const user = userEvent.setup();
  const onOuterEscape = vi.fn();
  render(
    <div onKeyDown={(e) => e.key === "Escape" && onOuterEscape()}>
      <Dropdown>
        <DropdownTrigger asChild>
          <button type="button">More</button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem>Edit</DropdownItem>
        </DropdownContent>
      </Dropdown>
    </div>,
  );
  await user.click(screen.getByRole("button", { name: "More" }));
  await screen.findByRole("menuitem", { name: "Edit" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(onOuterEscape).not.toHaveBeenCalled();
});
