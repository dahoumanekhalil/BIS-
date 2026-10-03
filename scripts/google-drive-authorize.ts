// One-shot operator OAuth flow for Google Drive off-site backup replication
// (Layer B.2 — docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md).
//
// Usage:
//   GOOGLE_DRIVE_CLIENT_ID="…" GOOGLE_DRIVE_CLIENT_SECRET="…" \
//     npx tsx scripts/google-drive-authorize.ts
//
// Standalone Node CLI. Deliberately does NOT import `server-only` —
// it must run outside the Next.js runtime on the operator's laptop.
//
// Absolute rules enforced here:
//   * The refresh token is printed EXACTLY ONCE, to the operator's
//     tty, followed by a 15-second countdown, after which the terminal
//     is cleared. It is never written to a file, never sent over any
//     network beyond Google's own token endpoint, never logged.
//   * The client secret is never printed.
//   * The authorization code is never printed.
//   * All error paths report `err.constructor.name` only — never
//     `err.message` — because gaxios embeds the token endpoint URL and
//     response body in messages, and the response body of a failed
//     token exchange can echo back the client secret.
//
// Local HTTP listener:
//   * Bound to `127.0.0.1` only. Never `0.0.0.0`, never a public
//     hostname. The listener accepts exactly one request on
//     `/oauth2callback` before shutting down.
//   * Callback state is a 24-byte (192-bit) CSPRNG token, base64url-
//     encoded, validated at request time; a mismatch immediately aborts.
//     (The PKCE code verifier is a separate 32-byte random value.)

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { google } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";

// ─── Constants (must match lib/backup/replication/drive-client.ts) ─────────

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete the browser flow
const COUNTDOWN_SECONDS = 15;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openInBrowser(url: string): void {
  // Best-effort helper — if the spawn fails, the URL is already
  // printed and the operator can paste manually.
  //
  // Only ever launch Google's HTTPS consent page: the OS URL handlers
  // below will also open executables, file:// and other protocols, so
  // nothing else may reach them.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") return;
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      // NOT `cmd /c start`: cmd treats every `&` in the OAuth URL as a
      // command separator, so the browser received a truncated URL
      // (Google: "Required parameter is missing: response_type").
      // FileProtocolHandler hands the URL to the default browser
      // without any shell parsing. Absolute path: a bare name would be
      // searched in the current directory first.
      const rundll32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
      spawn(rundll32, ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore"
      }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Ignore: operator can copy the URL manually.
  }
}

type CallbackResult = { code: string };

function waitForCallback(expectedState: string): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${REDIRECT_HOST}:${REDIRECT_PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
        return;
      }
      const oauthErr = url.searchParams.get("error");
      if (oauthErr !== null) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end("Authorization declined. Return to the terminal.\n");
        server.close();
        // Reject with a name-only Error — the `oauthErr` string is
        // safe (a fixed enum like `access_denied`), but we still avoid
        // interpolating it into a chain that might land in a log.
        reject(new Error("authorization_declined"));
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (state === null || state !== expectedState) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end("Invalid state — possible replay. Aborted.\n");
        server.close();
        reject(new Error("state_mismatch"));
        return;
      }
      if (code === null || code.length === 0) {
        res
          .writeHead(400, { "Content-Type": "text/plain" })
          .end("Missing authorization code. Aborted.\n");
        server.close();
        reject(new Error("missing_code"));
        return;
      }
      // Successful browser leg. Do NOT echo the code back to the
      // browser page — the code is a bearer credential (though
      // single-use and short-lived) and does not need to be shown.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<title>Authorization complete</title></head>` +
          `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;` +
          `padding:2rem;max-width:36rem;margin:0 auto;">` +
          `<h1 style="margin:0 0 1rem;">Authorization complete</h1>` +
          `<p>Return to the terminal that started this script.</p>` +
          `<p>You may close this tab now.</p>` +
          `</body></html>\n`
      );
      server.close();
      resolve({ code });
    });

    // Bind explicitly to the loopback interface so a misconfigured
    // firewall cannot expose this listener to the network.
    server.on("error", (err) => {
      reject(new Error(`server_${err?.constructor?.name ?? "Error"}`));
    });
    server.listen(REDIRECT_PORT, REDIRECT_HOST);

    const timer = setTimeout(() => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(new Error("callback_timeout"));
    }, CALLBACK_TIMEOUT_MS);
    // Do not keep the process alive on the timer alone.
    timer.unref();
  });
}

async function displayRefreshTokenOnce(token: string): Promise<void> {
  const bar = "─".repeat(72);
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write("REFRESH TOKEN — copy into your deployment's secret manager NOW\n");
  process.stdout.write("Env var name: GOOGLE_DRIVE_REFRESH_TOKEN\n");
  process.stdout.write(`${bar}\n\n`);
  process.stdout.write(`${token}\n\n`);
  process.stdout.write(`${bar}\n`);
  process.stdout.write(
    "This terminal will be cleared in " +
      `${COUNTDOWN_SECONDS.toString()}s. The token is NOT stored anywhere ` +
      "else. If you miss the paste, revoke this credential at " +
      "https://myaccount.google.com/permissions and rerun this script.\n\n"
  );
  for (let remaining = COUNTDOWN_SECONDS; remaining > 0; remaining--) {
    process.stdout.write(
      `\rClearing in ${remaining.toString().padStart(2, " ")}s ...`
    );
    await sleep(1000);
  }
  // Clear scrollback + move cursor home. `\x1b[3J` clears the
  // scrollback buffer in supporting terminals (xterm, VS Code, Windows
  // Terminal ≥ 1.4). If the terminal does not honor these codes, the
  // operator sees a screenful of blank lines instead — still hides the
  // token from casual over-shoulder view.
  process.stdout.write("\r\x1b[2J\x1b[3J\x1b[H");
  process.stdout.write("Refresh token cleared from the terminal.\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const clientId = (process.env.GOOGLE_DRIVE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "").trim();

  if (clientId.length === 0 || clientSecret.length === 0) {
    process.stderr.write(
      "GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET must both be set.\n" +
        "See docs/BACKUP_GOOGLE_DRIVE_IMPLEMENTATION_PLAN.md §B for setup.\n"
    );
    process.exit(1);
  }

  const state = base64url(randomBytes(24));
  const { verifier: codeVerifier, challenge: codeChallenge } = pkce();

  const oauth2 = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: REDIRECT_URI
  });

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: false
  });

  process.stdout.write("Google Drive backup — one-time operator authorization\n\n");
  process.stdout.write("Opening the consent page in your default browser.\n");
  process.stdout.write("If it does not open, copy this URL manually:\n\n");
  process.stdout.write(`  ${authUrl}\n\n`);
  openInBrowser(authUrl);
  process.stdout.write("Waiting for authorization callback on ");
  process.stdout.write(`${REDIRECT_URI} ...\n`);

  const { code } = await waitForCallback(state);

  // Exchange the code for tokens. Ask the OAuth2 client to include the
  // PKCE verifier so Google validates the challenge/verifier pair.
  let refreshToken: string;
  try {
    const { tokens } = await oauth2.getToken({
      code,
      codeVerifier
    });
    if (
      tokens === null ||
      typeof tokens.refresh_token !== "string" ||
      tokens.refresh_token.length === 0
    ) {
      process.stderr.write(
        "Google did not return a refresh_token. This usually means the " +
          "account has previously granted this client and the refresh " +
          "token was not re-issued. Revoke this app at " +
          "https://myaccount.google.com/permissions and rerun.\n"
      );
      process.exit(1);
    }
    refreshToken = tokens.refresh_token;
  } catch (err) {
    // NAME ONLY — err.message may embed the token endpoint URL and,
    // in some gaxios versions, echoes back the failed response body.
    const name = err instanceof Error ? err.constructor.name : "Error";
    process.stderr.write(`Token exchange failed: ${name}\n`);
    process.exit(1);
  }

  await displayRefreshTokenOnce(refreshToken);
  process.exit(0);
}

main().catch((err) => {
  // Defensive: never let a rejected promise reach node's default
  // reporter, which prints the full stack (message + URL + headers).
  const name = err instanceof Error ? err.constructor.name : "Error";
  process.stderr.write(`Authorization script failed: ${name}\n`);
  process.exit(1);
});
