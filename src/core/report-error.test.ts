import { afterEach, expect, test } from 'vitest';
import { reportError, setReportError } from './report-error';

// Restore the default (microtask-rethrow) reporter after each test.
afterEach(() => setReportError(null));

test('routes the error to a custom reporter', () => {
  const seen: unknown[] = [];
  setReportError((e) => seen.push(e));
  const err = new Error('boom');
  reportError(err);
  expect(seen).toEqual([err]);
});

test('setReportError replaces the previous reporter', () => {
  const a: unknown[] = [];
  const b: unknown[] = [];
  setReportError((e) => a.push(e));
  setReportError((e) => b.push(e));
  reportError('x');
  expect(a).toEqual([]);
  expect(b).toEqual(['x']);
});
