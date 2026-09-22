// Tests for lib/email/rate-limit. Pure — no DB required.
//   npm run test:email-rate-limit

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RATE_LIMITS,
  isEmailRateLimited,
  recordEmailAttempt,
  __resetEmailRateLimitsForTests
} from "../lib/email/rate-limit";

// Force NODE_ENV to something that allows the reset helper. In Node's test
// runner NODE_ENV is usually undefined. Using bracket access to bypass the
// `readonly` overload on process.env.NODE_ENV that @types/node ships.
if (!process.env.NODE_ENV) {
  (process.env as Record<string, string>).NODE_ENV = "test";
}

describe("email rate-limit", () => {
  beforeEach(() => {
    __resetEmailRateLimitsForTests();
  });

  test("permits up to the limit and blocks afterwards", () => {
    const bucket = { bucket: "verify" as const, key: "u@example.com" };
    for (let i = 0; i < RATE_LIMITS.verify; i++) {
      assert.equal(
        isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.verify }),
        false,
        `should not be limited on attempt ${i + 1}`
      );
      recordEmailAttempt(bucket);
    }
    assert.equal(
      isEmailRateLimited({ ...bucket, limit: RATE_LIMITS.verify }),
      true,
      "should be limited after reaching the ceiling"
    );
  });

  test("distinct keys have distinct budgets", () => {
    const bucketA = { bucket: "password-reset" as const, key: "a@example.com" };
    const bucketB = { bucket: "password-reset" as const, key: "b@example.com" };
    for (let i = 0; i < RATE_LIMITS.passwordReset; i++) {
      recordEmailAttempt(bucketA);
    }
    assert.equal(
      isEmailRateLimited({ ...bucketA, limit: RATE_LIMITS.passwordReset }),
      true
    );
    assert.equal(
      isEmailRateLimited({ ...bucketB, limit: RATE_LIMITS.passwordReset }),
      false
    );
  });

  test("distinct buckets do not collide", () => {
    const key = "same-key@example.com";
    const verify = { bucket: "verify" as const, key };
    const reset = { bucket: "password-reset" as const, key };
    for (let i = 0; i < RATE_LIMITS.verify; i++) {
      recordEmailAttempt(verify);
    }
    assert.equal(
      isEmailRateLimited({ ...verify, limit: RATE_LIMITS.verify }),
      true
    );
    assert.equal(
      isEmailRateLimited({ ...reset, limit: RATE_LIMITS.passwordReset }),
      false
    );
  });
});
