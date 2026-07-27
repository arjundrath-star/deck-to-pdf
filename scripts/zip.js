/**
 * Packages the dist/ folder into deploy/deck-to-pdf.zip for manual sharing
 * or a Load-unpacked-style install from a zip.
 *
 * The package is FLAT: every file at the zip root, no subfolders. Some
 * re-hosting pipelines flatten folder structure on re-zip, which breaks the
 * manifest icon paths and makes Chrome refuse the load. A flat package
 * gives such a pipeline nothing to destroy.
 *
 * Usage: node scripts/zip.js   (run `npm run build` first)
 */

const { execSync } = require("child_process");
const { existsSync, mkdirSync, readdirSync, rmSync } = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");
const deployDir = path.resolve(__dirname, "..", "deploy");
const outZip = path.join(deployDir, "deck-to-pdf.zip");

if (!existsSync(distDir)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

// Guard the flat-package invariant before zipping.
const subdirs = readdirSync(distDir, { withFileTypes: true }).filter((e) => e.isDirectory());
if (subdirs.length > 0) {
  console.error(
    `dist/ contains subfolders (${subdirs.map((d) => d.name).join(", ")}) — the package must be flat. Check webpack.config.js CopyPlugin patterns.`
  );
  process.exit(1);
}

mkdirSync(deployDir, { recursive: true });
if (existsSync(outZip)) rmSync(outZip);

try {
  // -X strips extra file attributes; -j is implicit since dist/ is flat.
  execSync(`cd "${distDir}" && zip -X "${outZip}" *`, { stdio: "inherit", shell: "/bin/zsh" });
  console.log(`Packaged to: ${outZip}`);
} catch {
  console.error("Could not zip — is the `zip` CLI available?");
  process.exit(1);
}
