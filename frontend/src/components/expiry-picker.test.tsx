import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpiryPicker } from "./expiry-picker";

afterEach(cleanup);

function Picked({
  start,
  onChange = () => {},
}: {
  start: string | null;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(start);
  return (
    <ExpiryPicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("ExpiryPicker", () => {
  it("is a radio group of the periods, with the picked one checked", () => {
    render(<Picked start="7d" />);
    expect(screen.getByRole("radiogroup", { name: "Auto-delete" })).toBeVisible();
    const names = screen.getAllByRole("radio").map((r) => r.textContent);
    expect(names).toEqual(["Keep", "1 day", "3 days", "7 days", "1 month", "3 months"]);
    expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Keep" })).not.toBeChecked();
  });

  it("checks no radio when no value is picked, and takes the tab stop on the first", () => {
    render(<Picked start={null} />);
    expect(screen.queryAllByRole("radio", { checked: true })).toHaveLength(0);
    expect(screen.getByRole("radio", { name: "Keep" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("has one tab stop, on the picked radio", () => {
    render(<Picked start="3d" />);
    const stops = screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops.map((r) => r.textContent)).toEqual(["3 days"]);
  });

  it("moves and picks with the arrow keys, and wraps", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picked start="" onChange={onChange} />);
    screen.getByRole("radio", { name: "Keep" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("1d");
    expect(screen.getByRole("radio", { name: "1 day" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "1 day" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith("3d");

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("radio", { name: "Keep" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("90d");
    expect(screen.getByRole("radio", { name: "3 months" })).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith("30d");
  });

  it("goes to the first and last with Home and End", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picked start="3d" onChange={onChange} />);
    screen.getByRole("radio", { name: "3 days" }).focus();
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("90d");
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("starts from the first radio with an arrow key when none is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picked start={null} onChange={onChange} />);
    screen.getByRole("radio", { name: "Keep" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("1d");
  });

  it("picks with a click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picked start="" onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "1 month" }));
    expect(onChange).toHaveBeenCalledWith("30d");
  });

  it("takes no press while it is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ExpiryPicker value="" onChange={onChange} disabled />);
    await user.click(screen.getByRole("radio", { name: "1 day" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
