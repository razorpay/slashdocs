import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Button } from "./button";

it("takes no second press while busy, and keeps its label for its name and width", () => {
  const { rerender } = render(<Button>Create bot</Button>);
  const button = screen.getByRole("button", { name: "Create bot" });
  expect(button).toBeEnabled();
  rerender(<Button busy>Create bot</Button>);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Create bot" })).toBe(button);
  expect(button.querySelector(".busy-spinner")).not.toBeNull();
});
