/*
 * Test-time certificate generation for the mock PLC. The key pair is created with the openssl CLI in a fresh
 * temporary directory, read into memory and the directory is removed again. Nothing is ever committed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCert {
  key: string;
  cert: string;
}

export function generateSelfSignedCert(commonName = "S7-MOCK-PLC"): TestCert {
  const dir = mkdtempSync(join(tmpdir(), "s7-mock-plc-"));
  try {
    const keyFile = join(dir, "key.pem");
    const certFile = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", keyFile, "-out", certFile, "-subj", `/CN=${commonName}`, "-days", "2",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
