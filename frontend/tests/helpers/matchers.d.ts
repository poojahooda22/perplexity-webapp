// Declaration merging so the jest-dom matchers (extended onto `expect` in testing-library.ts)
// are visible to TypeScript inside test files. Type-only — `verbatimModuleSyntax` requires `import type`.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import type { Matchers, AsymmetricMatchers } from "bun:test";

declare module "bun:test" {
  interface Matchers<T> extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers {}
}
