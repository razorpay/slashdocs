import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles.css";
import { APIError } from "@/api";
import { errorMessage } from "@/lib/errors";
import { ThemeProvider } from "@/lib/theme";
import { AppShell } from "@/components/layout/app-shell";
import { LandingPage } from "@/pages/landing";
import { LoginPage } from "@/pages/login";
import { DocumentsPage } from "@/pages/documents";
import { DocumentPage } from "@/pages/document";
import { FolderPage } from "@/pages/folder";
import { ServiceAccountsPage } from "@/pages/service-accounts";
import { DevelopersPage } from "@/pages/developers";
import { ProfilePage } from "@/pages/profile";
import { StartPage } from "@/pages/start";
import { migrateLegacyStorage } from "@/lib/legacy-storage";
import { finishLegacySignOut } from "@/lib/auth-state";

// Query failures (other than auth, handled by route guards) and any mutation
// without its own onError surface as a toast.
const qc = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false },
    mutations: {
      onError: (e) => toast.error(errorMessage(e)),
    },
  },
  queryCache: new QueryCache({
    onError: (e, query) => {
      if (query.meta?.suppressGlobalError) return;
      if (e instanceof APIError && e.status === 401) return;
      toast.error(errorMessage(e));
    },
  }),
});

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/app" element={<AppShell />}>
                <Route index element={<Navigate to="documents" replace />} />
                <Route path="start" element={<StartPage />} />
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="d/:id" element={<DocumentPage />} />
                <Route path="folders/:id" element={<FolderPage />} />
                <Route
                  path="settings/service-accounts"
                  element={<ServiceAccountsPage />}
                />
                <Route path="settings/profile" element={<ProfilePage />} />
                <Route path="developers" element={<DevelopersPage />} />
              </Route>
              {/* legacy redirects */}
              <Route path="/documents/:id" element={<LegacyDocRedirect />} />
              <Route
                path="/service-accounts"
                element={<Navigate to="/app/settings/service-accounts" replace />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <Toaster position="bottom-right" theme="system" richColors />
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function LegacyDocRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/app/d/${id}`} replace />;
}

migrateLegacyStorage();

void finishLegacySignOut().then(() =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
