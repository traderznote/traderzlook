// Library-global error sink. The default rethrows on a microtask so a throwing
// listener's failure surfaces without truncating dispatch.

export type ReportError = (error: unknown) => void;

const defaultReporter: ReportError = (error) => {
  queueMicrotask(() => {
    throw error;
  });
};

let reporter: ReportError = defaultReporter;

export function reportError(error: unknown): void {
  reporter(error);
}

/** Install a reporter; pass `null` to restore the default microtask-rethrow. */
export function setReportError(fn: ReportError | null): void {
  reporter = fn ?? defaultReporter;
}
