/**
 * One-time: generate the extension signing key and derive its stable ID.
 *
 *   node scripts/gen-key.mjs
 *
 * Writes:
 *   - key.pem        the PRIVATE signing key (git-ignored, never commit). Back
 *                    it up safely: losing it changes the extension ID and breaks
 *                    updates for everyone.
 * Prints:
 *   - the manifest "key" value (public, safe to commit) -> paste into manifest.json
 *   - the extension ID -> stable across installs once the key is pinned
 *
 * If key.pem already exists it is reused (does not overwrite).
 */

import crypto from "crypto";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const keyPath = join(here, "..", "key.pem");

let privatePem;
if (existsSync(keyPath)) {
  privatePem = readFileSync(keyPath, "utf8");
  console.log("Reusing existing key.pem");
} else {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  privatePem = privateKey;
  writeFileSync(keyPath, privatePem);
  console.log("Wrote key.pem (private — keep safe, never commit)");
}

// Public key in SPKI DER form: this is exactly what Chrome's manifest "key" wants.
const pubDer = crypto.createPublicKey(privatePem).export({ type: "spki", format: "der" });
const manifestKey = pubDer.toString("base64");

// Extension ID = first 16 bytes of sha256(pubDer), hex, mapped 0-9a-f -> a-p.
const hash = crypto.createHash("sha256").update(pubDer).digest("hex");
const id = hash
  .slice(0, 32)
  .split("")
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");

console.log("\nmanifest.json \"key\":\n" + manifestKey);
console.log("\nExtension ID:\n" + id + "\n");
