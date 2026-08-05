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
import { ErrorBoundary, MessageScreen } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";
import { AnonymousUserProvider } from "./hooks/useAnonymousUser";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

loadConfig()
  .then((cfg) => {
    const convex = new ConvexReactClient(cfg.CONVEX_URL);

    root.render(
      <StrictMode>
        <ErrorBoundary>
          <GoogleAuthProvider>
            <AnonymousUserProvider>
              <ConvexProviderWithAuth client={convex} useAuth={useConvexGoogleAuth}>
                <ToastProvider>
                  <AuthProfileSync />
                  <BrowserRouter>
                    <Routes>
                      <Route path="/" element={<App />} />
                      <Route
                        path="/schedule/:id"
                        element={
                          <ErrorBoundary message="Schedule not found.">
                            <ScheduleView />
                          </ErrorBoundary>
                        }
                      />
                      <Route path="/auth/callback" element={<AuthCallbackPage />} />
                      <Route path="/auth/calendar-callback" element={<CalendarCallbackPage />} />
                      <Route path="/discord/link-channel" element={<DiscordChannelPickerPage />} />
                      <Route path="/discord/link-account" element={<DiscordAccountLinkPage />} />
                      <Route
                        path="*"
                        element={<MessageScreen message="Page not found." />}
                      />
                    </Routes>
                  </BrowserRouter>
                </ToastProvider>
              </ConvexProviderWithAuth>
            </AnonymousUserProvider>
          </GoogleAuthProvider>
        </ErrorBoundary>
      </StrictMode>,
    );
  })
  .catch((err) => {
    console.error("Failed to start the app:", err);
    root.render(
      <StrictMode>
        <MessageScreen
          message="Couldn't load the app configuration."
          actionLabel="Try again"
        />
      </StrictMode>,
    );
  });
