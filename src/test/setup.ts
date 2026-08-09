import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest.config.mts runs with globals: false, so @testing-library/react's
// own auto-cleanup (which looks for a global afterEach) never registers.
// Do it explicitly; this is a no-op in the node-environment test files that
// never call render() in the first place.
afterEach(() => {
  cleanup();
});
