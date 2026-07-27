/**
 * Test harness server for generic mode.
 *
 * Serves the browser harness (test/harness.html), the synthetic fixture
 * pages, generated SVG "slides" at exact intrinsic sizes, the tsc-compiled
 * core modules, and pdf-lib for the full-pipeline check.
 *
 * The real captured deck fixture is confidential and lives OUTSIDE this
 * repo. Its routes only exist when a path is supplied:
 *   node test/serve.mjs --real-fixture /path/to/fixture-dir
 * (or REAL_DECK_FIXTURE env). The dir must hold page.html, urls.txt, and
 * slide-NN image files; urls.txt line order defines slide order. Nothing
 * from that dir is ever copied into the repo.
 *
 * Run `npm run test:build` first so test/.build exists.
 */

import { createServer } from "http";
import { existsSync, readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8879);

const argIdx = process.argv.indexOf("--real-fixture");
const realDir =
  (argIdx > -1 ? process.argv[argIdx + 1] : process.env.REAL_DECK_FIXTURE) || null;

/** pathname -> local slide file; plus the expected order of pathnames. */
let realMap = null;
if (realDir && existsSync(join(realDir, "urls.txt")) && existsSync(join(realDir, "page.html"))) {
  const lines = readFileSync(join(realDir, "urls.txt"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  realMap = { order: [], files: new Map() };
  lines.forEach((line, i) => {
    const pathname = new URL(line).pathname;
    const file = join(realDir, `slide-${String(i + 1).padStart(2, "0")}.webp`);
    realMap.order.push(pathname);
    realMap.files.set(pathname, file);
  });
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
};

function sendFile(res, file) {
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, {
    "content-type": TYPES[ext] || "application/octet-stream",
    // Tests iterate on these files; a cached stale harness lies.
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}

function genSvg(w, h, name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="hsl(${hue},60%,72%)"/>` +
    `<text x="50%" y="50%" font-size="${Math.round(h / 4)}" text-anchor="middle" ` +
    `dominant-baseline="middle" fill="#222" font-family="sans-serif">${name}</text></svg>`
  );
}

const server = createServer((req, res) => {
  // DNS-rebinding guard: the real-fixture routes serve a confidential deck;
  // only true local hosts may ask for anything.
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (host !== "localhost" && host !== "127.0.0.1") {
    res.writeHead(403);
    res.end("local only");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/" || p === "/harness.html") return sendFile(res, join(here, "harness.html"));

  let m = p.match(/^\/fixtures\/([\w-]+\.html)$/);
  if (m) return sendFile(res, join(here, "fixtures", m[1]));

  m = p.match(/^\/\.build\/([\w-]+\.js)$/);
  if (m) return sendFile(res, join(here, ".build", m[1]));

  if (p === "/vendor/pdf-lib.esm.js") {
    return sendFile(res, join(here, "..", "node_modules", "pdf-lib", "dist", "pdf-lib.esm.js"));
  }

  m = p.match(/^\/gen\/(\d{2,4})x(\d{2,4})\/([\w-]{1,40})\.svg$/);
  if (m) {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
    res.end(genSvg(Number(m[1]), Number(m[2]), m[3]));
    return;
  }

  if (p === "/real/available") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ available: !!realMap, count: realMap ? realMap.order.length : 0 }));
    return;
  }
  if (realMap) {
    if (p === "/real/deck.html") return sendFile(res, join(realDir, "page.html"));
    if (p === "/real/urls.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ order: realMap.order }));
      return;
    }
    if (realMap.files.has(p)) return sendFile(res, realMap.files.get(p));
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`harness on http://localhost:${PORT}/harness.html`);
  console.log(`real fixture: ${realMap ? `${realMap.order.length} slides from ${basename(realDir)}` : "not supplied (tests will skip)"}`);
});
