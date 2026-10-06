// Builds mobile/www from the website's public offline files.
//   node scripts/sync-www.mjs
// Single source of truth: ../public/offline.html, offline.js, offline-core.js
// (the same files the PWA service worker serves), so the website and the app
// can never drift apart. Also writes the tiny launcher index.html.
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "..", "public");
const www = join(here, "..", "www");

await mkdir(www, { recursive: true });
for (const f of ["offline.html", "offline.js", "offline-core.js"]) {
  await copyFile(join(pub, f), join(www, f));
  console.log("copied", f);
}

// Launcher: only used if the native shell ever loads the bundled web dir
// instead of the remote site. It shows the offline page — never a blank screen.
const launcher = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta http-equiv="refresh" content="0; url=offline.html" />
<title>BIS 2027</title></head>
<body style="margin:0;background:#080D18"></body></html>
`;
await writeFile(join(www, "index.html"), launcher, "utf8");
console.log("wrote index.html");

// Safety: the bundled page must not reference remote origins.
const html = await readFile(join(www, "offline.html"), "utf8");
if (/https?:\/\//.test(html)) {
  throw new Error("offline.html references a remote URL — refusing to bundle");
}
