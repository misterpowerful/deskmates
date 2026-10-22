// Exchanges GOOGLE_REFRESH_TOKEN for a short-lived access token, shared by
// gmail.js and calendar.js. The refresh token itself comes from the one-time
// interactive scripts/google-oauth-setup.js run — nothing in this module
// performs the initial OAuth consent flow.

import { fetchWithTimeout, retryRead, statusError } from "./http.js";

let cachedToken = null;
let cachedExpiryMs = 0;

export async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiryMs - 30_000) {
    return cachedToken;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google OAuth is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN) — see README.md, scripts/google-oauth-setup.js",
    );
  }

  // Token refresh is idempotent, so it is safe to retry.
  const data = await retryRead(async () => {
    const res = await fetchWithTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
      { label: "Google OAuth" },
    );
    if (!res.ok) {
      throw statusError(`Google token refresh failed (${res.status}): ${await res.text()}`, res.status);
    }
    return res.json();
  });
  cachedToken = data.access_token;
  cachedExpiryMs = now + data.expires_in * 1000;
  return cachedToken;
}
