import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Version } from "@/api";
import { OlderVersionBanner } from "./doc-older-version-banner";

afterEach(cleanup);

const versions = [
  { id: "v7", number: 7, created_at: "2026-10-10T10:00:00Z" },
  { id: "v3", number: 3, created_at: "2026-09-01T10:00:00Z" },
] as Version[];

it("tells the reader they are on an older version and links back to latest", () => {
  const onViewLatest = vi.fn();
  render(
    <OlderVersionBanner
      current="v3"
      latest="v7"
      versions={versions}
      onViewLatest={onViewLatest}
    />,
  );
  const banner = screen.getByRole("status");
  expect(banner).toHaveTextContent("You're viewing an older version (v3");
  expect(banner).toHaveTextContent("The latest is v7.");
  fireEvent.click(screen.getByRole("button", { name: "View latest" }));
  expect(onViewLatest).toHaveBeenCalledOnce();
});

it("renders nothing on the latest version", () => {
  const { container } = render(
    <OlderVersionBanner
      current="v7"
      latest="v7"
      versions={versions}
      onViewLatest={() => {}}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("still warns when version numbers have not loaded", () => {
  render(
    <OlderVersionBanner
      current="v3"
      latest="v7"
      versions={[]}
      onViewLatest={() => {}}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "You're viewing an older version of this document.",
  );
});
