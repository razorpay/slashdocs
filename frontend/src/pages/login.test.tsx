import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { LoginPage } from "./login";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="Path">{pathname + search}</output>;
}

function renderSignedIn(next: string) {
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never;
  vi.spyOn(api, "me").mockResolvedValue({
    principal: { type: "user", id: "usr_1" },
  } as Awaited<ReturnType<typeof api.me>>);
  vi.spyOn(api, "getConfig").mockResolvedValue({} as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/login?next=${encodeURIComponent(next)}`]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("sends a signed-in reader on to the page that they asked for", async () => {
  renderSignedIn("/app/d/doc_1?version=v2");
  expect(await screen.findByLabelText("Path")).toHaveTextContent(
    "/app/d/doc_1?version=v2",
  );
});

it.each(["//evil.example", "/\\evil.example", "https://evil.example"])(
  "sends a signed-in reader to Documents, not to %s",
  async (next) => {
    renderSignedIn(next);
    expect(await screen.findByLabelText("Path")).toHaveTextContent(
      /^\/app\/documents$/,
    );
  },
);
