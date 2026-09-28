// Morning Mix backend
// Handles Spotify login (Authorization Code + PKCE) and proxies the few
// endpoints the frontend needs, so the Spotify client secret and access
// tokens never reach the browser.
//
// Run locally:
//   cp .env.example .env   (fill in real values)
//   npm install
//   npm start
//
// Then point your deployed Morning Mix frontend's API_BASE at this
// server's URL (see frontend-integration-notes.md).

require("dotenv").config();
const express = require("express");
const cookieSession = require("cookie-session");
const cors = require("cors");
const crypto = require("crypto");

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  FRONTEND_URL,
  SESSION_SECRET,
  PORT = 8888,
} = process.env;

for (const [k, v] of Object.entries({ SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, FRONTEND_URL, SESSION_SECRET })) {
  if (!v) { console.error(`Missing required env var: ${k}. Copy .env.example to .env and fill it in.`); process.exit(1); }
}

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(cookieSession({
  name: "mm_session",
  secret: SESSION_SECRET,
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  sameSite: "lax",
  httpOnly: true,
}));

const SCOPES = ["user-top-read", "user-read-email"].join(" ");
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

// ---------- 1. Kick off login ----------
app.get("/auth/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });
  res.redirect(`${AUTH_URL}?${params.toString()}`);
});

// ---------- 2. Spotify redirects back here with a code ----------
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`${FRONTEND_URL}?auth=error`);
  if (!state || state !== req.session.oauthState) return res.redirect(`${FRONTEND_URL}?auth=state_mismatch`);
  req.session.oauthState = null;

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    });
    const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body,
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokens = await tokenRes.json(); // { access_token, refresh_token, expires_in, ... }

    // Store tokens server-side, in the signed session cookie. For a
    // multi-device or longer-lived product, swap this for a real
    // database row keyed by user id instead of a cookie.
    req.session.spotify = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    };

    res.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (err) {
    console.error(err);
    res.redirect(`${FRONTEND_URL}?auth=error`);
  }
});

// ---------- helper: refresh the access token when it's expired ----------
async function getValidAccessToken(req) {
  const sp = req.session.spotify;
  if (!sp) return null;
  if (Date.now() < sp.expires_at - 60_000) return sp.access_token;

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: sp.refresh_token });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body,
  });
  if (!r.ok) { req.session.spotify = null; return null; }
  const t = await r.json();

  req.session.spotify = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || sp.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
  };
  return req.session.spotify.access_token;
}

function requireAuth(req, res, next) {
  if (!req.session.spotify) return res.status(401).json({ error: "not_authenticated" });
  next();
}

// ---------- 3. Frontend checks login state ----------
app.get("/auth/status", (req, res) => {
  res.json({ authenticated: !!req.session.spotify });
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------- 4. The data Morning Mix actually needs ----------
// Mirrors what picks() in the frontend currently invents locally —
// this is the real version of it.
app.get("/api/top-artists", requireAuth, async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) return res.status(401).json({ error: "not_authenticated" });

    const r = await fetch(`${API_BASE}/me/top/artists?time_range=medium_term&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: "spotify_error" });
    const data = await r.json();

    // Shape it down to just what the frontend needs
    const artists = data.items.map((a) => ({
      id: a.id,
      name: a.name,
      genres: a.genres, // Spotify's own genre tags — use these instead of the hardcoded GENRES list
      popularity: a.popularity, // 0-100: low popularity is a decent stand-in for "niche"
    }));
    res.json({ artists });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/top-tracks", requireAuth, async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) return res.status(401).json({ error: "not_authenticated" });

    const r = await fetch(`${API_BASE}/me/top/tracks?time_range=medium_term&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(r.status).json({ error: "spotify_error" });
    const data = await r.json();

    const tracks = data.items.map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      album: t.album.name,
      spotifyUrl: t.external_urls.spotify,
    }));
    res.json({ tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => console.log(`Morning Mix backend listening on http://127.0.0.1:${PORT}`));
