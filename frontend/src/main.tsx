import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles.css";
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
import { NotFoundPage } from "@/pages/not-found";
import { retryQuery, toastQueryError } from "@/lib/query-retry";
import { migrateLegacyStorage } from "@/lib/legacy-storage";
import { finishLegacySignOut } from "@/lib/auth-state";

// A failed refresh of shown data (other than auth, handled by route guards)
// and any mutation without its own onError surface as a toast.
const qc = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: retryQuery },
    mutations: {
      onError: (e) => toast.error(errorMessage(e)),
    },
  },
  queryCache: new QueryCache({ onError: toastQueryError }),
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
                <Route path="settings/developers" element={<DevelopersPage />} />
                <Route
                  path="developers"
                  element={<Navigate to="/app/settings/developers" replace />}
                />
              </Route>
              {/* legacy redirects */}
              <Route path="/documents/:id" element={<LegacyDocRedirect />} />
              <Route
                path="/service-accounts"
                element={<Navigate to="/app/settings/service-accounts" replace />}
              />
              <Route element={<AppShell />}>
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            <Toaster />
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
