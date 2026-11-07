/**
 * Vite config for design mode (`npm run dev:design`).
 *
 * Aliases "convex/react" and the Google auth module to mock implementations
 * so the app runs with in-memory fake data — no Convex backend or Google
 * OAuth credentials required.
 */

import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  // Keep mock data and browser storage separate from the normal dev app.
  server: {
    port: 5174,
    strictPort: true,
  },
  resolve: {
    alias: [
      // Replace Convex React hooks/provider with mock implementations
      {
        find: "convex/react",
        replacement: path.resolve(__dirname, "src/mock/convexReact.ts"),
      },
      // Replace auth module with a mock that always returns anonymous.
      {
        find: /^\.\.?\/lib\/authClient(\.tsx)?$/,
        replacement: path.resolve(__dirname, "src/mock/authClient.tsx"),
      },
    ],
  },
  build: {
    outDir: "dist",
  },
});
