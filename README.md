\# Cloze Refiner



Anki cloze batch refiner powered by OpenAI.



\## Setup



Create a .env file (not committed):



OPENAI\_API\_KEY=PASTE\_YOUR\_KEY\_HERE  

APP\_USERNAME=SET\_A\_USERNAME\_OR\_PATH\_HERE  



Run:



node server.js



Open http://localhost:3000




## Long-term style seeding (Micro / Gross / Path)

You can seed the rewrite style with your own phrase library stored in the repo.

1. Copy `data/style_seed.example.json` to `data/style_seed.json`.
2. Put your snippets under keys: `micro`, `gross`, and/or `path`.
3. Restart the server, or call:
   - `POST /api/rewrite/reload-style-seed`

Notes:
- This is best for curated style snippets from your own docs (including content copied from Word).
- Confirmed examples saved with **Save Corrected** still persist to `data/rewrite_learning.json`.
- Both the curated seed file and saved corrections are used together to steer future output style.


## Grossing Manual integration

The app links to the externally hosted Grossing Manual at `https://gross-pathology-manual-uch.github.io/Path/`.

For the Node app, `/grossing-manual` remains available for old bookmarks and redirects to that external manual. GitHub Pages uses the same external URL directly, so no vendored manual sync is required.

### Render build/deploy notes

Recommended Render build/start:

```bash
# Build
npm ci

# Start
npm start
```


## GitHub Pages static preview

The `.github/workflows/static.yml` workflow publishes a front-end-only preview for GitHub Pages. It copies `cap_cloze_refiner.html` to `index.html`, includes the synoptic generator, script, and favicon. The Grossing Manual button opens the external hosted manual.

Important limitations:

- GitHub Pages is static and cannot run `server.js`. Refiner/Rewriter OpenAI actions still require the Node server (`npm start`) or a deployed backend.
- The static preview uses relative asset links so it works from a GitHub Pages project path like `/Path/` instead of only from the domain root.

## Vercel API backend

The browser code defaults AI API calls to the deployed Vercel backend:

```text
https://path-lcq4f9pfy-jamesbar-s-projects.vercel.app
```

Local development on `localhost` still uses the local `server.js` process. Static previews such as GitHub Pages or `file://` now call the Vercel backend instead of assuming there is no API server. To point a preview at a different backend, set `window.PATH_API_ORIGIN` before loading `script.js` or set `localStorage.PATH_API_ORIGIN` in the browser.

For Vercel, keep `OPENAI_API_KEY` (and optional `APP_USERNAME`) in Vercel environment variables. If the login gate is enabled and you open the static preview from another origin, first sign in at the Vercel app URL so the browser can send the backend cookie.

