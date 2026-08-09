# Deck to PDF

A Chrome extension that downloads a DocSend or Papermark deck as a PDF in one click, generalized from a tool I built and ran at a venture firm. Published with the firm's permission. It existed so the team could file pitch decks internally without routing confidential material through a third-party converter.

## Provenance

This is the general, public version of an existing, fully developed repo. I built and ran the original in production at the venture firm where I worked. That original stays private with the firm, along with the complete commit history from months of development. I sanitized this copy for publication (synthetic names, placeholder IDs, no firm data) and published it fresh, so the git history here starts at the publish date. The commit count reflects the sanitization and release, not the work of building the tool.

## How it works

DocSend and Papermark serve each slide as a separate image. When you open a deck, your browser has already fetched and decoded those images into the page. The extension collects them in slide order, fetches the bytes, stitches them into a PDF with [pdf-lib](https://github.com/Hopding/pdf-lib), and downloads the file. Nothing leaves your browser.

For pages that are not DocSend or Papermark (v0.4), a generic mode scans the current page for a slide deck under the activeTab grant, shows what it found as an ordered thumbnail strip with per-image deselect, then fetches the confirmed images in page context and assembles the PDF. It only converts decks whose images load from the page's own site.

## Install (unpacked)

1. Run `npm install && npm run build`.
2. Open Chrome, go to `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.

## Usage

Open a DocSend or Papermark deck, click the toolbar icon, and hit **Download PDF**. The extension scrolls the deck so every slide loads, waits for them to finish, then assembles and downloads the file. On any other page, the popup offers to scan the page for a deck instead.

Password-protected and email-gated decks work as long as you have already entered the credentials and are viewing the slides.

## Notes

- **Download control.** This bypasses the sender's "downloads off" setting. Only use it on decks shared with you.
- **Access log.** DocSend logs every view against the email on your session. The download shows up in the sender's analytics under your address.
- **Maintenance.** The extension reads each viewer's page structure to find slide images. If DocSend or Papermark update their viewers, the selectors in `src/core/docsend.ts` or `src/core/papermark.ts` may need a patch.
- **Page types.** Standard image-slide decks work. Embedded video, spreadsheet tabs, and other non-image content are skipped.

## Project structure

```
src/
  core/
    docsend.ts        -- DocSend selectors and scroll logic
    papermark.ts      -- Papermark selectors
    site-adapter.ts   -- shared adapter interface
    generic.ts        -- generic deck detection (pure logic, no DOM)
    generic-dom.ts    -- generic detection, DOM side
    generic-flow.ts   -- popup/collector flow state
    image-fetch.ts    -- image bytes via fetch in page context
    pdf.ts            -- image bytes to PDF (pdf-lib, no Chrome or DOM APIs)
    b64.ts            -- base64 helpers for message passing
  content.ts          -- content script for the known sites
  generic-collector.ts -- injected on demand for generic mode
  popup.ts            -- the UI and orchestrator
  background.ts       -- service worker
manifest.json
```

`core/pdf.ts` and `core/generic.ts` have no Chrome or DOM dependencies; the test suite runs them directly under Node.

## Development

```bash
npm install
npm run build   # builds to dist/
npm run watch   # rebuilds on file save
npm test        # compiles the pure core and runs the Node test suite
npm run zip     # packages dist/ into a flat zip
```

To pin a stable extension ID for distribution, run `node scripts/gen-key.mjs` and paste the printed `"key"` value into `manifest.json`. The generated `key.pem` is the private signing key; it is git-ignored and must never be committed.

## License

MIT
