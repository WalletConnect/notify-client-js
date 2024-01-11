import { ParsedStack } from "vitest";
import { defineConfig } from "vitest/config";
import testEnv from "./testEnv.json";

export default defineConfig({
  test: {
onStackTrace(error: Error, { file }: ParsedStack): boolean | void {
      // If we've encountered a ReferenceError, show the whole stack.
      if (error.name === 'ReferenceError')
        return

      // Reject all frames from third party libraries.
      if (file.includes('node_modules'))
        return false
    },    env: {
      ...testEnv,
    },
    testTimeout: 60_000,
    hookTimeout: 10_000,
  }, 
  
});
