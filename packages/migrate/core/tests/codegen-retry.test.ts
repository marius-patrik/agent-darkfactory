import { describe, expect, test } from "bun:test";

import { isRetryableBufFailure } from "../../../../scripts/verify-codegen";

describe("Buf codegen transient failure classification", () => {
  test("success output is not classified as retryable", () => {
    expect(isRetryableBufFailure("Generation completed successfully")).toBe(false);
  });

  test("rate-limit exhaustion is classified as retryable", () => {
    expect(isRetryableBufFailure("resource_exhausted: too many requests")).toBe(true);
  });

  test("schema and authentication failures remain fail-closed", () => {
    expect(isRetryableBufFailure("invalid proto syntax: authentication required after rate limit exceeded")).toBe(false);
  });
});
