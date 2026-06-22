// Preloaded by `bun test` AFTER happydom.ts (order matters — DOM globals must exist first).
// Teaches Bun's `expect` the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
// and unmounts every rendered tree after each test so suites stay isolated.
import { afterEach, expect } from "bun:test";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { restoreFetch } from "../helpers/fetch-mock";
import { __reset } from "../helpers/supabase-fake";

expect.extend(matchers);

afterEach(() => {
  cleanup(); // unmount React trees
  restoreFetch(); // put global.fetch back
  __reset(); // clear the fake Supabase session + listeners
});
