import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_ALGORITHM = "A256GCM";
const ENVELOPE_VERSION = 1;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;

export function decodeTransientDataKey(encodedKey) {
  if (
    typeof encodedKey !== "string" ||
    encodedKey.length < 40 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(encodedKey)
  ) {
    throw new SessionEnvelopeError("invalid_data_key");
  }

  let key;
  try {
    key = Buffer.from(encodedKey.replace(/=+$/, ""), "base64url");
  } catch {
    throw new SessionEnvelopeError("invalid_data_key");
  }

  if (key.length !== 32) {
    key.fill(0);
    throw new SessionEnvelopeError("invalid_data_key");
  }
  return key;
}

function copyDataKey(encodedDataKey, dataKey) {
  if (Buffer.isBuffer(dataKey) && dataKey.length === 32) return Buffer.from(dataKey);
  return decodeTransientDataKey(encodedDataKey);
}

function decodeEnvelopePart(value, expectedLength, code) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionEnvelopeError(code);
  }
  const decoded = Buffer.from(value, "base64url");
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    decoded.fill(0);
    throw new SessionEnvelopeError(code);
  }
  return decoded;
}

function validateStorageState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.cookies) ||
    !Array.isArray(value.origins)
  ) {
    throw new SessionEnvelopeError("invalid_storage_state");
  }
  return value;
}

function additionalData(leaseId, ownerId) {
  if (typeof leaseId !== "string" || leaseId.length < 8 || leaseId.length > 200) {
    throw new SessionEnvelopeError("invalid_lease");
  }
  if (typeof ownerId !== "string" || ownerId.length < 3 || ownerId.length > 200) {
    throw new SessionEnvelopeError("invalid_owner");
  }
  return Buffer.from(
    `clawpilot\0career-site-linkedin-worker-envelope\0v${ENVELOPE_VERSION}\0${leaseId}\0${ownerId}`,
    "utf8",
  );
}

export class SessionEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionEnvelopeError";
    this.code = code;
  }
}

export function encryptStorageState({
  storageState,
  encodedDataKey,
  dataKey,
  leaseId,
  ownerId,
}) {
  const validated = validateStorageState(storageState);
  const plaintext = Buffer.from(JSON.stringify(validated), "utf8");
  if (plaintext.length > MAX_STORAGE_STATE_BYTES) {
    plaintext.fill(0);
    throw new SessionEnvelopeError("storage_state_too_large");
  }

  const key = copyDataKey(encodedDataKey, dataKey);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(additionalData(leaseId, ownerId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: ENVELOPE_VERSION,
      algorithm: ENVELOPE_ALGORITHM,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url"),
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

export function decryptStorageState({
  envelope,
  encodedDataKey,
  dataKey,
  leaseId,
  ownerId,
}) {
  if (
    !envelope ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.algorithm !== ENVELOPE_ALGORITHM
  ) {
    throw new SessionEnvelopeError("invalid_envelope");
  }

  const key = copyDataKey(encodedDataKey, dataKey);
  const iv = decodeEnvelopePart(envelope.iv, 12, "invalid_envelope_iv");
  const tag = decodeEnvelopePart(envelope.tag, 16, "invalid_envelope_tag");
  const ciphertext = decodeEnvelopePart(
    envelope.ciphertext,
    undefined,
    "invalid_envelope_ciphertext",
  );
  if (ciphertext.length > MAX_STORAGE_STATE_BYTES + 1024) {
    key.fill(0);
    throw new SessionEnvelopeError("storage_state_too_large");
  }

  let plaintext;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(additionalData(leaseId, ownerId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_STORAGE_STATE_BYTES) {
      throw new SessionEnvelopeError("storage_state_too_large");
    }
    return validateStorageState(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof SessionEnvelopeError) {
      throw error;
    }
    throw new SessionEnvelopeError("envelope_decryption_failed");
  } finally {
    key.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    plaintext?.fill(0);
  }
}

export function validateTransientDataKey(encodedDataKey) {
  const key = decodeTransientDataKey(encodedDataKey);
  key.fill(0);
  return encodedDataKey;
}
