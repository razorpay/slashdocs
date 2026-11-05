import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Combobox, type ComboboxOption } from "./combobox";

afterEach(cleanup);

const PEOPLE: ComboboxOption[] = [
  { key: "ann", name: "Ann" },
  { key: "bob", name: "Bob", disabledNote: "Has access" },
  { key: "cy", name: "Cy" },
];

function Field({
  options = PEOPLE,
  onSubmit,
}: {
  options?: ComboboxOption[];
  onSubmit: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Share</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Combobox
            aria-label="Person"
            value={value}
            onValueChange={setValue}
            options={value ? options : []}
            onPick={(o) => setValue(o.name)}
          />
          <button type="submit">Add</button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const active = (input: HTMLElement) =>
  document.getElementById(input.getAttribute("aria-activedescendant") || "");

it("moves over the options that can be picked, stops at both ends, and Enter picks without a submit", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Field onSubmit={onSubmit} />);
  const input = screen.getByRole("combobox", { name: "Person" });
  expect(input).toHaveAttribute("aria-expanded", "false");

  await user.type(input, "a");
  const list = screen.getByRole("listbox");
  expect(input).toHaveAttribute("aria-expanded", "true");
  expect(input).toHaveAttribute("aria-controls", list.id);
  expect(active(input)).toHaveTextContent("Ann");
  await user.keyboard("{ArrowUp}");
  expect(active(input)).toHaveTextContent("Ann");
  await user.keyboard("{ArrowDown}");
  expect(active(input)).toHaveTextContent("Cy");
  await user.keyboard("{ArrowDown}");
  expect(active(input)).toHaveTextContent("Cy");

  await user.keyboard("{Enter}");
  expect(input).toHaveValue("Cy");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(input).not.toHaveAttribute("aria-activedescendant");
  // With the list closed, Enter submits the form.
  await user.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledOnce();
});

it("closes only the list on Escape, opens it again on Down, and Tab leaves", async () => {
  const user = userEvent.setup();
  render(<Field onSubmit={() => {}} />);
  const input = screen.getByRole("combobox", { name: "Person" });
  await user.type(input, "a");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(input).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(input).toHaveAttribute("aria-expanded", "true");
  await user.tab();
  expect(screen.getByRole("button", { name: "Add" })).toHaveFocus();
  expect(input).toHaveAttribute("aria-expanded", "false");
});

it("keeps a valid active option when new options replace the old ones", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Field onSubmit={() => {}} />);
  const input = screen.getByRole("combobox", { name: "Person" });
  await user.type(input, "a");
  await user.keyboard("{ArrowDown}");
  expect(active(input)).toHaveTextContent("Cy");
  rerender(
    <Field
      onSubmit={() => {}}
      options={[
        { key: "dee", name: "Dee" },
        { key: "eve", name: "Eve" },
      ]}
    />,
  );
  expect(active(input)).toHaveTextContent("Dee");
  rerender(<Field onSubmit={() => {}} options={[]} />);
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(input).not.toHaveAttribute("aria-activedescendant");
});
