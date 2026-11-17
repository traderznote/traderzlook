// Compile-time defines, substituted as literals by esbuild (build) and vite (tests) so
// dev asserts and bench counters dead-code-eliminate out of the shipped bundle.
export {};

declare global {
  /** True in dev/test builds; false (and stripped) in the published bundle. */
  const __DEV__: boolean;
  /** True only under bench instrumentation; false (and stripped) otherwise. */
  const __TN_PROFILE__: boolean;

  // Present on every target but absent from lib.es2022, so headless modules need no lib.dom.
  function queueMicrotask(callback: () => void): void;

  // Only the methods headless modules use; not lib.dom's full type.
  const console: { warn(...data: unknown[]): void };
}
