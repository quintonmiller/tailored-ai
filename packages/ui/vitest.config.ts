import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DOMPurify needs a real DOM: it sanitizes by parsing input into one and
    // walking the tree, which is both why it is trustworthy and why it cannot
    // be exercised against plain strings.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
