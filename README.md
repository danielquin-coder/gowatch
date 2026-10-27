# GoWatch

GoWatch is a static, installable web app (PWA) for phones. Prop your phone above a physical Go board, tap the four corners once, and GoWatch watches the game through the camera, records every move, builds an SGF, and uploads it to your own [online-go.com](https://online-go.com) (OGS) library.

* Vanilla HTML/CSS/JS ES modules, no bundler, no runtime npm dependencies.
* Computer vision with [OpenCV.js](https://docs.opencv.org/4.x/opencv.js), loaded lazily and cached by the service worker. A built-in pure-JS warp is used if OpenCV can't be loaded.
* Every user logs into their **own** OGS account with OAuth2 Authorization Code + PKCE (public client, no secret). Tokens stay in that browser's localStorage.

## Layout

```
index.html, callback.html, manifest.json, sw.js
css/style.css
js/config.js   deployment config + Settings overrides
js/ogs.js      PKCE login, token refresh, /me, library, SGF upload
js/game.js     board rules, captures, ko, undo, SGF export, inferMove()
js/vision.js   OpenCV.js loading, perspective warp, stone classification
js/tracker.js  temporal stability + motion gating -> moves
js/camera.js   getUserMedia, torch, wake lock
js/ui.js       stage overlay (corner handles, magnifier), board diagrams
js/app.js      wiring, persistence, views
proxy/worker.js  optional Cloudflare Worker CORS proxy
tests/           node --test (game logic) + Playwright (vision)
tools/make-icons.mjs  regenerates icons/
```

## Deploy on GitHub Pages

1. Create a repo named `gowatch` and push the contents of this folder to the `main` branch (the files at the repo root, not inside a subfolder).
2. Repo **Settings > Pages > Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`.
3. After a minute the app is at `https://<user>.github.io/gowatch/`. HTTPS is required for the camera.
4. When you change any file, bump `CACHE_VERSION` in `sw.js` so installed copies update.

All asset paths are relative, so any sub-path works.

## Register the OAuth app on OGS

1. Log in to online-go.com and open <https://online-go.com/oauth2/applications/>.
2. Click **Register a new application** (or "New application").
3. Fill in:
   * **Name**: `GoWatch` (anything you like)
   * **Client type**: **Public**
   * **Authorization grant type**: **Authorization code**
   * **Redirect URIs**: exactly `https://<user>.github.io/gowatch/callback.html` (must match character for character: scheme, host, path, no trailing slash after `.html`). The same value is shown in the app under Settings > "Redirect URI to register on OGS".
4. Save and copy the generated **Client id**. (A public client has no secret.)
5. Put the client id into `js/config.js` (`OGS_CLIENT_ID: '...'`) **or** leave it empty and paste it in the app's Settings (gear icon). Settings values are kept in that browser only, which lets one deployment be configured without editing files.

For local testing, register a second redirect URI such as `http://localhost:8000/callback.html` and serve the folder with `python3 -m http.server 8000` (localhost counts as a secure context for the camera).

### How several people use one deployment

The OAuth application only identifies *GoWatch*; it never holds anyone's password or token. Each person opens the same URL, taps **Log in with OGS**, approves access with their own account, and gets their own 30-day token stored in their own browser. Uploaded SGFs land in that person's OGS library. The client id is public by design (PKCE), so it is safe to commit it in `config.js`.

## Using it

1. **Setup**: log in, enter player names (Black defaults to your OGS username), pick board size and komi, **Start camera**, then **Tap 4 corners** in the order top-left, top-right, bottom-right, bottom-left. Tap the *outermost grid intersections* (the corner points where lines meet), not the edge of the wood. Drag the yellow handles to fine-tune; a 4x magnifier appears while you drag. Turn on **Test mode** to watch the live classification and adjust **Sensitivity**. Optionally clear the board and press **Calibrate empty board**.
2. **Record**: the status line shows who is to play, the move number and the tracker state (`watching`, `motion`, `stable`). A move is recorded when the board has looked the same for about 1.2 s with no hand over it; you get a beep and a vibration. Buttons: Pass (not visible to a camera), Undo, Fix board, Swap colors, Pause, End game. If the board can't be explained as a single move, a **Check board** banner appears: open it, tap intersections to toggle empty/black/white until it matches reality, and accept. If your edit is exactly one move it is recorded as a move, otherwise as a setup node (AB/AW/AE) in the SGF.
3. **Review**: final position, result (winner, points / resignation / time), SGF preview, then **Upload to OGS** (optionally to a folder), **Download SGF**, **Share SGF** or **New game**.

The game is saved to localStorage after every change; reloading the page and pressing *Resume recording* continues where you left off.

### Camera tips

* Prop the phone **directly above** the board (a tripod, a mug stack, a gooseneck clamp) looking straight down; tilt is handled by the perspective transform, but the closer to vertical the better.
* Even, diffuse lighting. Avoid shadows from your arm or lamp, and glare on glossy stones. Turn on the torch only if it doesn't create hot spots.
* Keep the whole board plus a little margin in view, and don't move the phone mid-game (if you do, re-tap the corners).
* Stones that overhang the intersections at a steep angle are harder to read; a more vertical camera helps.

## If OGS blocks cross-origin requests (CORS)

OGS must allow browser requests from `https://<user>.github.io` for login token exchange, `/api/v1/me/` and the upload. If it doesn't, the browser reports a network `TypeError` and GoWatch shows an error explaining that CORS is probably blocking the call (Download and Share SGF always work). The fix is the tiny proxy in `proxy/worker.js`:

1. Create a free Cloudflare account, go to **Workers & Pages > Create > Worker**, and paste `proxy/worker.js` (or `wrangler deploy` it).
2. Optional: add an environment variable `ALLOWED_ORIGIN` = `https://<user>.github.io` so only your site can use it.
3. In GoWatch **Settings**, set *CORS proxy URL* to the Worker URL (e.g. `https://gowatch-proxy.<you>.workers.dev`). From then on every OGS REST call, including the token exchange and refresh, goes through the Worker.

The Worker forwards only these paths to `https://online-go.com`: `/oauth2/token/`, `/api/v1/me/`, `/api/v1/me/games/sgf/*`, `/api/v1/library/*`. Cookies are never forwarded or returned. The authorize page itself is a normal browser navigation to OGS and does not use the proxy.

## Tests

```
node --test                        # (or npm test) game logic + vision; NB: Node 21+ rejects `node --test tests/`
OPENCV_JS_PATH=/path/opencv.js node --test tests/vision.test.mjs   # also exercise OpenCV offline
```

* `tests/game.test.mjs`: captures, ko, suicide, undo, SGF output, JSON round trip, `inferMove` (single stone, capture, no change, ambiguous, uncaptured stones).
* `tests/vision.test.mjs`: starts a static server, opens `index.html` in Chromium via Playwright, paints a perspective-skewed synthetic 19x19 photo (wood grain, lighting gradient, shadows, noise, ~45 stones) and asserts at least 95% of intersections are classified correctly, once with the pure-JS warp and once with OpenCV.js (skipped with a message when OpenCV.js can't be fetched).

## Design notes

* **Corners are the four corner intersections** and are stored normalised (0..1) against the video frame, so they survive resolution changes. The warped square is 608 px; with `size` points per side an intersection sits at the centre of a `608/size` cell (32 px for 19x19).
* **Classification**: mean luminance over a disc of 0.3 cell, compared with the median of the nearby "between" points (square centres, never covered by stones) so lighting gradients are handled locally. Black = clearly darker; white = clearly brighter *and* much less saturated than the wood. The sensitivity slider scales both thresholds. An optional empty-board baseline adds the grid-line/star-point darkness to the reference.
* **OpenCV is used for the warp and light blur**; if it cannot be loaded, an equivalent pure-JS homography warp takes over, so detection still works (just a little slower).
* **inferMove** accepts exactly one new stone whose captures explain every other difference. The colour is taken from what the camera saw; only if the captures are inconsistent with that colour but consistent with the other one is it re-coloured. Out-of-turn moves are accepted (handicap, mistakes) and flagged with a toast. A new stone that should capture stones that are still on the board waits up to 8 s for you to remove them before raising "Check board".
* **Undo** removes the move from the record and tells the tracker to ignore the unchanged physical board until you take the stone off, so it isn't re-recorded.
* **Handicap / pre-placed stones**: the first stable board when recording starts becomes root `AB`/`AW` (and `HA[n]`); after a handicap White moves first.
* **Passes** can't be seen, so use the Pass button.
* **Swap colors** treats camera-black as SGF-white; set it before the first stone (changing it mid-game shows up as a board mismatch to fix).
* **Login uses a full-page redirect** (most reliable on phones/PWAs). `callback.html` performs the code exchange itself, announces the result via `BroadcastChannel`/`localStorage` to any other open GoWatch tab, then returns to `./`.
* **Service worker**: own files cache-first (bump `CACHE_VERSION`), OpenCV network-first with a 6 s timeout then cache, everything else (OGS) untouched. OGS tokens are never cached by it.
* SGF files are named `GoWatch-YYYY-MM-DD-HHMM.sgf`, mime type `application/x-go-sgf`, uploaded to collection `0` (library root) unless you pick a folder.

## Known limitations

* Detection is colour/brightness based: glossy glare, dark wooden boards, very pale boards with white stones, or dim light reduce accuracy; use the test mode and sensitivity slider.
* It tracks one board state at a time; captures made by removing several stones across many seconds, or two moves between stable frames, fall to the "Check board" dialog.
* Scoring is not computed; enter the result yourself.
* The OGS CORS behaviour and exact upload response couldn't be verified offline; the proxy is the fallback.
