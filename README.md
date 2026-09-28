# Morning Mix backend

This is the piece Morning Mix is missing: a small server that logs a
listener into Spotify and fetches their real top artists and tracks,
without ever putting the client secret or access tokens in the browser.

## Why this has to be a separate server

Claude's published artifact pages run in a sandbox that blocks outbound
requests to any domain outside a short script-loading allowlist — so
even a working backend couldn't be called *from* a Claude artifact.
This server is meant to be deployed on its own (Render, Railway,
Fly.io, a VPS, etc.), with the Morning Mix frontend also deployed as
its own static site (Vercel, Netlify, GitHub Pages) that calls this
server directly. It stops being a Claude artifact at that point and
becomes a normal two-part web app: static frontend + small backend.

## 1. Register a Spotify app

1. Go to https://developer.spotify.com/dashboard and log in.
2. Create an app. Any name/description is fine.
3. In the app's settings, add a **Redirect URI** that exactly matches
   `SPOTIFY_REDIRECT_URI` below (for local testing:
   `http://127.0.0.1:8888/auth/callback`).
4. Copy the **Client ID** and **Client Secret** into your `.env`.

## 2. Configure

```bash
cp .env.example .env
# then edit .env with your real Client ID, secret, and URLs
```

## 3. Run it

```bash
npm install
npm start
```

Visit `http://127.0.0.1:8888/auth/login` in a browser — it should send
you to Spotify's login/consent screen, then redirect back and set a
session cookie.

## 4. What it exposes to the frontend

| Route | What it does |
|---|---|
| `GET /auth/login` | Redirects the browser to Spotify to sign in |
| `GET /auth/callback` | Spotify redirects here after login (handled automatically) |
| `GET /auth/status` | `{ authenticated: true/false }` — call this on page load |
| `POST /auth/logout` | Clears the session |
| `GET /api/top-artists` | The signed-in listener's top artists, with Spotify's own genre tags |
| `GET /api/top-tracks` | Their top tracks |

All of these need `credentials: "include"` on the frontend's `fetch`
calls so the session cookie is sent.

## 5. Wiring it into the Morning Mix frontend

In `morning-mix.html`, the hardcoded `C` catalog and the "Connect"
panel are the two things to replace:

```js
const API_BASE = "https://your-backend.onrender.com"; // deployed URL

async function checkAuth() {
  const r = await fetch(`${API_BASE}/auth/status`, { credentials: "include" });
  return (await r.json()).authenticated;
}

async function loadRealTaste() {
  const [artistsRes, tracksRes] = await Promise.all([
    fetch(`${API_BASE}/api/top-artists`, { credentials: "include" }),
    fetch(`${API_BASE}/api/top-tracks`, { credentials: "include" }),
  ]);
  const { artists } = await artistsRes.json();
  const { tracks } = await tracksRes.json();
  // artists[i].genres is Spotify's own genre list per artist — use it
  // in place of the GENRES chips, and artists[i].popularity as a
  // niche/mainstream signal in place of the manual tier numbers.
}
```

The "Connect Spotify" button becomes `window.location.href =
`${API_BASE}/auth/login`` instead of just toggling a hidden panel.

## 6. Before this touches real user data

This skeleton is enough to run locally and see it work, not enough to
ship to strangers:

- Swap the cookie-based session for a real database (tokens keyed by
  user id), so logins survive server restarts and scale past one
  process.
- Add HTTPS and set `sameSite`/`secure` cookie flags for production.
- Handle Spotify's rate limits (429 responses) with backoff.
- Add your app's icon/privacy policy in the Spotify dashboard before
  requesting **Extended Quota Mode** — new Spotify apps are capped at
  25 authorized users until Spotify approves that.
- Apple Music needs a separate flow (MusicKit JS + a signed developer
  token from an Apple Developer account); it isn't included here.
