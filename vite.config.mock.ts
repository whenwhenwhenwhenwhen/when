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
  resolve: {
    alias: [
      // Replace Convex React hooks/provider with mock implementations
      {
        find: "convex/react",
        replacement: path.resolve(__dirname, "src/mock/convexReact.ts"),
      },
      // Replace Google auth module with a mock that always returns anonymous.
      // Components import it via relative paths ("../lib/googleAuth",
      // "./lib/googleAuth") so we match the full specifier.
      {
        find: /^\.\.?\/lib\/googleAuth(\.tsx)?$/,
        replacement: path.resolve(__dirname, "src/mock/googleAuth.tsx"),
      },
    ],
  },
  build: {
    outDir: "dist",
  },
});
