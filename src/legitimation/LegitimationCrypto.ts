// Ported to TypeScript from S7CommPlusDriver (Thomas Wiens, LGPL).
import { createCipheriv, createHash } from "node:crypto";

export class LegitimationCrypto {
  /** SHA256 */
  static sha256(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha256").update(data).digest());
  }

  /** SHA1 (used by the legacy legitimation) */
  static sha1(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash("sha1").update(data).digest());
  }

  /** Encrypt AES-CBC with PKCS7 padding (key length selects AES-128/192/256). */
  static encryptAesCbc(plainBytes: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
    const alg = `aes-${key.length * 8}-cbc`;
    const cipher = createCipheriv(alg, key, iv);
    cipher.setAutoPadding(true);
    return new Uint8Array(Buffer.concat([cipher.update(plainBytes), cipher.final()]));
  }
}
