import { ParsedStack } from "vitest";
import { defineConfig } from "vitest/config";
import testEnv from "./testEnv.json";

export default defineConfig({
  test: {
onStackTrace(error: Error, { file }: ParsedStack): boolean | void {
      // Reject all traces from third parties
      if (file.includes('node_modules'))
        return false
    },
    env: {
      ...testEnv,
    },
    testTimeout: 60_000,
    hookTimeout: 10_000,
  }, 
  
});
