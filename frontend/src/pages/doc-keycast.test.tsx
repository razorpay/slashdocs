import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Keycast } from "./doc-keycast";

afterEach(cleanup);

describe("Keycast", () => {
  it("shows each letter as a key before its word, and the time left to press one", () => {
    const { container } = render(
      <Keycast state={{ phase: "armed" }} available={["t", "c"]} />,
    );
    const keys = [...container.querySelectorAll("kbd")].map((kbd) => kbd.textContent);
    expect(keys).toEqual(["T", "C"]);
    expect(container.textContent).toContain("Ccomments");
    expect(screen.getByRole("progressbar", { hidden: true })).toBeInTheDocument();
  });

  it("puts the legend on the dark surface of the keys, so it reads over any document", () => {
    const { container } = render(
      <Keycast state={{ phase: "armed" }} available={["c"]} />,
    );
    const esc = screen.getByText("ESC").parentElement!;
    const legend = container.querySelector("kbd")!.closest("div")!;
    for (const surface of ["bg-neutral-700/95", "dark:bg-neutral-800/95"]) {
      expect(esc).toHaveClass(surface);
      expect(legend).toHaveClass(surface);
    }
  });

  it("names the chord that ran, without the letters or the time", () => {
    const { container } = render(
      <Keycast
        state={{ phase: "resolved", key: "c" }}
        available={["c"]}
        label="Comments"
      />,
    );
    expect(container.textContent).toBe("ESC+CComments");
    expect(screen.queryByRole("progressbar", { hidden: true })).toBeNull();
  });
});
