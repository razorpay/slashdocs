import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Segmented, SegmentedNav, tabPanel } from "./segmented";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

function Tabs() {
  const [value, setValue] = useState("a");
  return (
    <>
      <button type="button">Before</button>
      <Segmented
        label="Letters"
        value={value}
        options={OPTIONS}
        onChange={setValue}
        panel="letters"
      />
      <div {...tabPanel("letters")}>{value}</div>
    </>
  );
}

it("is one tab stop, and the arrow keys, Home and End move to a tab and pick it", async () => {
  const user = userEvent.setup();
  render(<Tabs />);
  const tab = (name: string) => screen.getByRole("tab", { name });
  expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);

  await user.click(screen.getByRole("button", { name: "Before" }));
  await user.tab();
  expect(tab("Alpha")).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(tab("Beta")).toHaveFocus();
  expect(tab("Beta")).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  await user.keyboard("{End}");
  expect(tab("Gamma")).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(tab("Alpha")).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(tab("Gamma")).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Home}");
  expect(tab("Alpha")).toHaveAttribute("aria-selected", "true");

  // The selected tab names its panel, and the panel names the tab.
  const panel = screen.getByRole("tabpanel", { name: "Alpha" });
  expect(tab("Alpha")).toHaveAttribute("aria-controls", panel.id);
  await user.tab();
  expect(tab("Alpha")).not.toHaveFocus();
});

it("as navigation, is a link to each page and marks the current one", () => {
  render(
    <MemoryRouter initialEntries={["/b"]}>
      <Routes>
        <Route
          path="*"
          element={
            <SegmentedNav
              label="Settings"
              value="/b"
              options={OPTIONS.map((o) => ({ ...o, value: `/${o.value}` }))}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  const nav = screen.getByRole("navigation", { name: "Settings" });
  expect(nav.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: "Alpha" })).not.toHaveAttribute(
    "aria-current",
  );
  expect(screen.getByRole("link", { name: "Gamma" })).toHaveAttribute("href", "/c");
});
