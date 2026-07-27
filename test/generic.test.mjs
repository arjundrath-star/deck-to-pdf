/**
 * Unit tests for the pure generic-mode heuristic (src/core/generic.ts).
 * Run with: npm test  (compiles core to test/.build first).
 *
 * Every plan fixture has a structural analog here with dummy URLs; the real
 * captured deck stays outside the repo and is exercised by the browser
 * harness (test/harness.html) when its git-ignored path is present.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDeck, parseSrcsetLargest, MAX_IMAGES } from "./.build/generic.js";

const ORIGIN = "https://deck.example";

function ctx(overrides = {}) {
  return {
    baseUrl: ORIGIN + "/view",
    origin: ORIGIN,
    viewportWidth: 1280,
    scrollHeight: 16000,
    ...overrides,
  };
}

function img(index, overrides = {}) {
  return {
    index,
    src: `/slides/s${index}.webp`,
    srcset: "",
    naturalWidth: 1600,
    naturalHeight: 900,
    attrWidth: null,
    attrHeight: null,
    displayWidth: 1200,
    displayHeight: 675,
    ...overrides,
  };
}

/** A 21-slide deck plus the page chrome (logo, avatar) around it. */
function deck21() {
  const imgs = [];
  imgs.push(img(0, { src: "/logo.png", naturalWidth: 180, naturalHeight: 40, displayWidth: 180, displayHeight: 40 }));
  for (let i = 1; i <= 21; i++) imgs.push(img(i));
  imgs.push(img(22, { src: "/avatar.jpg", naturalWidth: 96, naturalHeight: 96, displayWidth: 48, displayHeight: 48 }));
  return imgs;
}

test("adiabatic-shaped page: 21 slides, document order, no warnings", () => {
  const a = analyzeDeck(deck21(), ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 21);
  assert.deepEqual(
    a.slides.map((s) => s.url),
    Array.from({ length: 21 }, (_, i) => `${ORIGIN}/slides/s${i + 1}.webp`)
  );
  assert.equal(a.lazyCount, 0);
  assert.equal(a.lowCountWarning, false);
  assert.equal(a.droppedDuplicates, 0);
});

test("loop-clone carousel: edge clones trimmed, order preserved from slide 1", () => {
  // Swiper loop mode: [clone of last, 1..21, clone of first].
  const imgs = [img(0, { src: "/slides/s21.webp" })];
  for (let i = 1; i <= 21; i++) imgs.push(img(i));
  imgs.push(img(22, { src: "/slides/s1.webp" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 21);
  assert.ok(a.slides[0].url.endsWith("/s1.webp"), "must start at slide 1, not a rotated clone");
  assert.ok(a.slides[20].url.endsWith("/s21.webp"));
  assert.equal(a.droppedDuplicates, 2);
});

test("title image reused as the closing slide: closing copy dropped, order kept", () => {
  const imgs = [];
  for (let i = 1; i <= 20; i++) imgs.push(img(i));
  imgs.push(img(21, { src: "/slides/s1.webp" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 20);
  assert.ok(a.slides[0].url.endsWith("/s1.webp"));
  assert.ok(a.slides[19].url.endsWith("/s20.webp"));
  assert.equal(a.droppedDuplicates, 1);
});

test("interior duplicate collapses keep-first", () => {
  const imgs = [];
  for (let i = 1; i <= 6; i++) imgs.push(img(i));
  imgs.push(img(7, { src: "/slides/s3.webp" }));
  imgs.push(img(8, { src: "/slides/s7.webp" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 7);
  assert.equal(a.droppedDuplicates, 1);
});

test("srcset: largest w descriptor wins over src and smaller variants", () => {
  const imgs = [];
  for (let i = 1; i <= 5; i++) {
    imgs.push(
      img(i, {
        src: `/slides/s${i}-medium.webp`,
        srcset: `/slides/s${i}-640.webp 640w, /slides/s${i}-1920.webp 1920w, /slides/s${i}-1280.webp 1280w`,
      })
    );
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  for (const [i, s] of a.slides.entries()) {
    assert.equal(s.url, `${ORIGIN}/slides/s${i + 1}-1920.webp`);
  }
});

test("parseSrcsetLargest: w beats x, x fallback, first fallback, junk survives", () => {
  assert.equal(parseSrcsetLargest("a.jpg 1x, b.jpg 2x, c.jpg 800w"), "c.jpg");
  assert.equal(parseSrcsetLargest("a.jpg 1x, b.jpg 2x"), "b.jpg");
  assert.equal(parseSrcsetLargest("a.jpg, b.jpg"), "a.jpg");
  assert.equal(parseSrcsetLargest(""), null);
  assert.equal(parseSrcsetLargest("   "), null);
});

test("parseSrcsetLargest: commas inside Cloudinary/Imgix URLs survive", () => {
  const srcset =
    "https://res.example/w_640,c_fill/s.jpg 640w, https://res.example/w_1920,c_fill/s.jpg 1920w";
  assert.equal(parseSrcsetLargest(srcset), "https://res.example/w_1920,c_fill/s.jpg");
});

test("Cloudinary-style cross-origin srcset declines cleanly, no garbage URLs", () => {
  const imgs = [];
  for (let i = 1; i <= 5; i++) {
    imgs.push(
      img(i, {
        src: `https://cdn.example/w_640,c_fill/s${i}.jpg`,
        srcset: `https://cdn.example/w_640,c_fill/s${i}.jpg 640w, https://cdn.example/w_1920,c_fill/s${i}.jpg 1920w`,
      })
    );
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "cross-origin");
  assert.equal(a.sampleHost, "cdn.example");
});

test("unsized unloaded images are surfaced, not silently dropped", () => {
  // The unstyled <img loading="lazy"> deck: above-fold slides loaded, the
  // rest collapsed to 0x0 with no size hints anywhere.
  const imgs = [];
  for (let i = 1; i <= 5; i++) imgs.push(img(i));
  for (let i = 6; i <= 20; i++) {
    imgs.push(
      img(i, {
        naturalWidth: 0,
        naturalHeight: 0,
        displayWidth: 0,
        displayHeight: 0,
      })
    );
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 5);
  assert.equal(a.unsizedLazyCount, 15);
});

test("nothing loaded and nothing sized: still the keep-scrolling message", () => {
  const imgs = [];
  for (let i = 1; i <= 12; i++) {
    imgs.push(
      img(i, { naturalWidth: 0, naturalHeight: 0, displayWidth: 0, displayHeight: 0 })
    );
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "no-deck");
  assert.equal(a.reason, "lazy");
  assert.equal(a.unsizedLazyCount, 12);
});

test("lazy below-the-fold slides are counted, deck still reported", () => {
  const imgs = [];
  for (let i = 1; i <= 8; i++) imgs.push(img(i));
  for (let i = 9; i <= 14; i++) {
    imgs.push(
      img(i, { naturalWidth: 0, naturalHeight: 0, attrWidth: 1600, attrHeight: 900 })
    );
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 8);
  assert.equal(a.lazyCount, 6);
});

test("nothing loaded yet: no-deck with the lazy reason", () => {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    imgs.push(img(i, { naturalWidth: 0, naturalHeight: 0, attrWidth: 1600, attrHeight: 900 }));
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "no-deck");
  assert.equal(a.reason, "lazy");
  assert.equal(a.lazyCount, 10);
});

test("lazy image with a different ratio does not pollute lazyCount", () => {
  const imgs = deck21();
  imgs.push(
    img(30, { src: "/banner.webp", naturalWidth: 0, naturalHeight: 0, attrWidth: 1200, attrHeight: 200 })
  );
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.lazyCount, 0);
});

test("virtualized list: low-count warning fires", () => {
  const imgs = [];
  for (let i = 1; i <= 5; i++) imgs.push(img(i, { displayHeight: 720 }));
  const a = analyzeDeck(imgs, ctx({ scrollHeight: 15120 })); // 21 slots x 720
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 5);
  assert.equal(a.lowCountWarning, true);
});

test("fully loaded deck: low-count warning stays quiet", () => {
  const a = analyzeDeck(deck21(), ctx({ scrollHeight: 21 * 675 + 800 }));
  assert.equal(a.status, "ok");
  assert.equal(a.lowCountWarning, false);
});

test("image-light page: no-deck, no crash", () => {
  const imgs = [
    img(0, { src: "/hero.jpg", naturalWidth: 1400, naturalHeight: 600, displayWidth: 1280, displayHeight: 549 }),
    img(1, { src: "/chart.png", naturalWidth: 1000, naturalHeight: 800, displayWidth: 500, displayHeight: 400 }),
    img(2, { src: "/icon1.png", naturalWidth: 64, naturalHeight: 64, displayWidth: 32, displayHeight: 32 }),
    img(3, { src: "/icon2.png", naturalWidth: 64, naturalHeight: 64, displayWidth: 32, displayHeight: 32 }),
  ];
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "no-deck");
  assert.equal(a.reason, "no-group");
});

test("cross-origin deck declines with the host named", () => {
  const imgs = [];
  for (let i = 1; i <= 21; i++) imgs.push(img(i, { src: `https://cdn.example/slides/s${i}.webp` }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "cross-origin");
  assert.equal(a.sampleHost, "cdn.example");
  assert.equal(a.count, 21);
});

test("one cross-origin member declines the whole group", () => {
  const imgs = deck21();
  imgs[5] = img(5, { src: "https://cdn.example/slides/s5.webp" });
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "cross-origin");
});

test("cross-origin lazy member also declines", () => {
  const imgs = deck21();
  imgs.push(
    img(30, {
      src: "https://cdn.example/slides/s22.webp",
      naturalWidth: 0,
      naturalHeight: 0,
      attrWidth: 1600,
      attrHeight: 900,
    })
  );
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "cross-origin");
});

test("over the image cap: too-many", () => {
  const imgs = [];
  for (let i = 1; i <= MAX_IMAGES + 1; i++) imgs.push(img(i));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "too-many");
  assert.equal(a.count, MAX_IMAGES + 1);
});

test("cap applies after dedupe: clones do not push a deck over the limit", () => {
  // 200 unique slides plus 2 loop clones = 202 img elements.
  const imgs = [img(0, { src: `/slides/s${MAX_IMAGES}.webp` })];
  for (let i = 1; i <= MAX_IMAGES; i++) imgs.push(img(i));
  imgs.push(img(MAX_IMAGES + 1, { src: "/slides/s1.webp" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, MAX_IMAGES);
});

test("minimum group size: 3 passes, 2 does not", () => {
  const three = [img(1), img(2), img(3)];
  assert.equal(analyzeDeck(three, ctx()).status, "ok");
  const two = [img(1), img(2)];
  assert.equal(analyzeDeck(two, ctx()).status, "no-deck");
});

test("same URL repeated everywhere collapses below the minimum: no-deck", () => {
  const imgs = [];
  for (let i = 1; i <= 6; i++) imgs.push(img(i, { src: "/slides/same.webp" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "no-deck");
});

test("non-http(s) and unparseable sources are ignored", () => {
  const imgs = deck21();
  imgs.push(img(30, { src: "data:image/gif;base64,R0lGOD" }));
  imgs.push(img(31, { src: "" }));
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 21);
});

test("ratio tolerance: responsive rounding clusters, 4:3 stays separate", () => {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    imgs.push(img(i, { naturalWidth: 1600 - (i % 2), naturalHeight: 900 })); // 1600/1599
  }
  for (let i = 11; i <= 14; i++) {
    imgs.push(img(i, { naturalWidth: 1200, naturalHeight: 900 }));
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 10, "the 16:9 cluster wins; 4:3 images stay out");
});

test("small images never become candidates", () => {
  const imgs = [];
  for (let i = 1; i <= 10; i++) {
    imgs.push(img(i, { naturalWidth: 400, naturalHeight: 225, displayWidth: 300, displayHeight: 169 }));
  }
  assert.equal(analyzeDeck(imgs, ctx()).status, "no-deck");
});

test("small natural but large display counts (50 percent viewport rule)", () => {
  const imgs = [];
  for (let i = 1; i <= 4; i++) {
    imgs.push(img(i, { naturalWidth: 700, naturalHeight: 394, displayWidth: 900, displayHeight: 506 }));
  }
  const a = analyzeDeck(imgs, ctx());
  assert.equal(a.status, "ok");
  assert.equal(a.slides.length, 4);
});
