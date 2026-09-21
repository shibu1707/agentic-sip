import crypto from "crypto";

const CHARSET = "utf8";

// Key set 1 — standard encrypt/decrypt
const KEY1 = "2019100520220101";
const IV1  = "2019100520220101";

// Key set 2 — encryptDotnet (URL-safe base64)
const KEY2 = "8080808080808080";
const IV2  = "8080808080808080";

export function encrypt(plainText) {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(KEY1, CHARSET),
    Buffer.from(IV1, CHARSET)
  );
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plainText, CHARSET)),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

export function encryptDotnet(plainText) {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(KEY2, CHARSET),
    Buffer.from(IV2, CHARSET)
  );
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plainText, CHARSET)),
    cipher.final(),
  ]);
  return encrypted
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function decrypt(encryptedText) {
  const normalized = encryptedText.replace(/-/g, "+").replace(/_/g, "/");
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(KEY1, CHARSET),
    Buffer.from(IV1, CHARSET)
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(normalized, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString(CHARSET);
}

export function decryptDotnet(encryptedText) {
  const normalized = encryptedText.replace(/-/g, "+").replace(/_/g, "/");
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(KEY2, CHARSET),
    Buffer.from(IV2, CHARSET)
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(normalized, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString(CHARSET);
}
