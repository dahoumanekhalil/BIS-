// Generates the app icon / adaptive icon / splash from the brand mark
// (../star.png at the repository root). Uses `sharp`, already installed for the
// website (run from the repo root or from mobile-app/).
//   node mobile-app/scripts/make-assets.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const require = createRequire(join(root, "package.json"));
const sharp = require("sharp");

const SRC = join(root, "star.png");
const OUT = join(here, "..", "assets");
const NAVY = "#080D18";
await mkdir(OUT, { recursive: true });

const mark = (h) => sharp(SRC).resize({ height: h, fit: "inside" }).png().toBuffer();

// iOS / store icon: opaque, mark centred on the brand navy.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: NAVY } })
  .composite([{ input: await mark(720), gravity: "center" }])
  .png({ compressionLevel: 9 })
  .toFile(join(OUT, "icon.png"));

// Android adaptive foreground: transparent, mark inside the 66% safe zone.
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await mark(560), gravity: "center" }])
  .png()
  .toFile(join(OUT, "android-icon-foreground.png"));

// Splash: transparent mark (the navy background comes from the config).
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await mark(640), gravity: "center" }])
  .png()
  .toFile(join(OUT, "splash-icon.png"));

await sharp({ create: { width: 48, height: 48, channels: 4, background: NAVY } })
  .composite([{ input: await mark(40), gravity: "center" }])
  .png()
  .toFile(join(OUT, "favicon.png"));

console.log("assets written to", OUT);
