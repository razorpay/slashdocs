import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
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

it("stays for a reader whose session ended, though the page still knows who they were", async () => {
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as never;
  vi.spyOn(api, "getConfig").mockResolvedValue({} as never);
  vi.spyOn(api, "me").mockRejectedValue(new APIError(401, "unauthorized", "sign in"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.me(), { principal: { type: "user", id: "usr_1" } });
  await client
    .fetchQuery({ queryKey: queryKeys.me(), queryFn: api.me })
    .catch(() => {});
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/login?next=%2Fapp%2Fd%2Fdoc_1"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // The page asks who the reader is again, and stays.
  await waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("link", { name: /Continue with/ })).toBeInTheDocument();
  expect(screen.queryByLabelText("Path")).toBeNull();
});
