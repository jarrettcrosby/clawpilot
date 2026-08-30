import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptStorageState,
  encryptStorageState,
  SessionEnvelopeError,
} from "../src/crypto-envelope.mjs";

const ownerId = "owner-fixture";
const leaseId = "lease-fixture-0001";

test("round trips a storage state in an opaque lease-bound AES-GCM envelope", () => {
  const encodedDataKey = randomBytes(32).toString("base64url");
  const storageState = {
    cookies: [
      {
        name: "li_at",
        value: "secret-cookie-value",
        domain: ".linkedin.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
    ],
    origins: [
      {
        origin: "https://www.linkedin.com",
        localStorage: [{ name: "fixture", value: "fixture-value" }],
      },
    ],
  };
  const envelope = encryptStorageState({
    storageState,
    encodedDataKey,
    leaseId,
    ownerId,
  });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(JSON.stringify(envelope).includes("secret-cookie-value"), false);
  assert.deepEqual(
    decryptStorageState({ envelope, encodedDataKey, leaseId, ownerId }),
    storageState,
  );
});

test("the exact NUL-separated AAD binds both lease and owner", () => {
  const encodedDataKey = randomBytes(32).toString("base64url");
  const envelope = encryptStorageState({
    storageState: { cookies: [], origins: [] },
    encodedDataKey,
    leaseId,
    ownerId,
  });
  assert.throws(
    () =>
      decryptStorageState({
        envelope,
        encodedDataKey,
        leaseId: "lease-fixture-0002",
        ownerId,
      }),
    (error) => error instanceof SessionEnvelopeError && error.code === "envelope_decryption_failed",
  );
});
