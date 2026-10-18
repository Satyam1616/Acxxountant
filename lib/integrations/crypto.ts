import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { StorageError } from "@/lib/domain/errors";

function keyMaterial(): Buffer {
  const value = process.env.ENCRYPTION_KEY;
  if (!value)
    throw new StorageError(
      "encryption_not_configured",
      "ENCRYPTION_KEY is required for integration credentials",
    );
  return createHash("sha256").update(value).digest();
}

export function encryptSecret(value: string, associatedData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, associatedData: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue)
    throw new StorageError("credential_corrupt", "Encrypted credential format is invalid");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyMaterial(),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new StorageError(
      "credential_tampered",
      "Encrypted integration credential could not be verified",
    );
  }
}
