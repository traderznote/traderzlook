// Dev-only invariant check: __DEV__ is false in the published build, so the guard and
// its argument expressions are eliminated. Never use it for user-input validation.
export function assert(condition: unknown, message: string): asserts condition {
  if (__DEV__ && !condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
