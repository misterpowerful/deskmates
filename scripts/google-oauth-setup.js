// One-time, interactive, manual OAuth consent flow for the Gmail/Calendar
// tools (src/tools/gmail.js, src/tools/calendar.js) — this genuinely cannot
// be scripted end-to-end without a browser and a Google account login, the
// same way the `sudo systemctl restart` permission couldn't be automated.
// Not part of the normal server startup path; run it once by hand.
//
// This process listens on the SERVER (deskmates's own host), but the
// browser doing the Google consent runs on your laptop — Google's redirect
// to http://127.0.0.1:<PORT> would otherwise land on your laptop's own
// loopback and never reach this script. Forward that one port over SSH
// while running the script remotely, in one command, from your laptop:
//
//   ssh -L 8945:127.0.0.1:8945 <user>@<host> \
//     'cd /var/www/deskmates && node scripts/google-oauth-setup.js'
//
// Then open the printed URL in a browser on your laptop as normal — the
// tunnel carries Google's redirect back to this process on the server.
//
// Prerequisite: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET already in .env,
// from a Google Cloud Console project with the Gmail API and Calendar API
// enabled and an OAuth 2.0 "Desktop app" client created. See README.md.

import "dotenv/config";
import http from "node:http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are not set in .env — create an OAuth 2.0 Desktop app client in Google Cloud Console first. See README.md.",
  );
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

// Desktop-app OAuth clients use the loopback IP redirect flow: any port on
// 127.0.0.1 is accepted without pre-registering it in Cloud Console. Fixed
// (rather than OS-assigned) so the SSH -L port-forward command above can be
// written down verbatim instead of depending on a port only known after the
// process starts.
const REDIRECT_PORT = 8945;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1`);
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      `<p>Authorization was not granted (${error}). You can close this tab and re-run the script.</p>`,
    );
    console.error(`\nAuthorization denied or failed: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400).end("Missing ?code");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" }).end(
    "<p>Got it — you can close this tab and go back to the terminal.</p>",
  );

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: `http://127.0.0.1:${REDIRECT_PORT}`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error(`\nToken exchange failed (${tokenRes.status}):`, tokenData);
      process.exit(1);
    }
    if (!tokenData.refresh_token) {
      console.error(
        "\nNo refresh_token in the response. This usually means this Google account already granted " +
          "this app consent before and Google didn't re-issue one. Revoke prior access at " +
          "https://myaccount.google.com/permissions and re-run this script, or delete the app's " +
          "existing grant, then try again.",
      );
      process.exit(1);
    }

    console.log("\nSuccess. Add this to .env as GOOGLE_REFRESH_TOKEN:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokenData.refresh_token}\n`);
    console.log("Then restart the service: sudo systemctl restart deskmates");
  } finally {
    server.close();
    process.exit(0);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${REDIRECT_PORT} is already in use on this machine. Free it (check ` +
        `"lsof -i :${REDIRECT_PORT}") and re-run.`,
    );
  } else {
    console.error("\nServer error:", err.message);
  }
  process.exit(1);
});

server.listen(REDIRECT_PORT, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  // access_type=offline + prompt=consent: without both, Google often omits
  // refresh_token on a second-or-later consent for the same account/app.
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log(
    `Listening on 127.0.0.1:${REDIRECT_PORT}. If you're running this over SSH, make sure you ` +
      `launched it with -L ${REDIRECT_PORT}:127.0.0.1:${REDIRECT_PORT} (see the top of this file).\n`,
  );
  console.log("Open this URL in a browser signed into the Google account to grant access:\n");
  console.log(authUrl.toString());
  console.log("\nWaiting for the redirect back to this machine...");
});
