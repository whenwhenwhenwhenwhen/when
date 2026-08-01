import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { BrowserRouter, Routes, Route } from "react-router";
import { GoogleAuthProvider, useConvexGoogleAuth } from "./lib/googleAuth";
import { loadConfig } from "./config";
import App from "./App";
import { ScheduleView } from "./components/ScheduleView";
import { AuthCallbackPage } from "./components/AuthCallbackPage";
import { CalendarCallbackPage } from "./components/CalendarCallbackPage";
import { DiscordChannelPickerPage } from "./components/DiscordChannelPickerPage";
import { DiscordAccountLinkPage } from "./components/DiscordAccountLinkPage";
import { AuthProfileSync } from "./components/AuthProfileSync";
import { ToastProvider } from "./components/ToastProvider";
import { AnonymousUserProvider } from "./hooks/useAnonymousUser";
import "./index.css";

loadConfig().then((cfg) => {
  const convex = new ConvexReactClient(cfg.CONVEX_URL);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <GoogleAuthProvider>
        <AnonymousUserProvider>
          <ConvexProviderWithAuth client={convex} useAuth={useConvexGoogleAuth}>
            <ToastProvider>
              <AuthProfileSync />
              <BrowserRouter>
                <Routes>
                  <Route path="/" element={<App />} />
                  <Route path="/schedule/:id" element={<ScheduleView />} />
                  <Route path="/auth/callback" element={<AuthCallbackPage />} />
                  <Route path="/auth/calendar-callback" element={<CalendarCallbackPage />} />
                  <Route path="/discord/link-channel" element={<DiscordChannelPickerPage />} />
                  <Route path="/discord/link-account" element={<DiscordAccountLinkPage />} />
                </Routes>
              </BrowserRouter>
            </ToastProvider>
          </ConvexProviderWithAuth>
        </AnonymousUserProvider>
      </GoogleAuthProvider>
    </StrictMode>,
  );
});
