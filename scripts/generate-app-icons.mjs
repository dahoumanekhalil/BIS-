// Generates every app icon / splash source from the brand mark (star.png).
//   node scripts/generate-app-icons.mjs
// Outputs:
//   public/icons/*            web + PWA icons (any + maskable), apple-touch icon
//   mobile/assets/*           1024px icon + splash sources for @capacitor/assets
// Idempotent. Requires `sharp` (already present via Next.js).
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const NAVY = "#080D18";
const SRC = "star.png";

await mkdir("public/icons", { recursive: true });
await mkdir("mobile/assets", { recursive: true });

// Draw the mark centred on a solid brand background. `ratio` = mark height as
// a fraction of the canvas (maskable icons need a bigger safe zone).
async function icon(size, ratio, out) {
  const markH = Math.round(size * ratio);
  const mark = await sharp(SRC)
    .resize({ height: markH, fit: "inside" })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: NAVY }
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log("wrote", out);
}

await icon(192, 0.7, "public/icons/icon-192.png");
await icon(512, 0.7, "public/icons/icon-512.png");
await icon(512, 0.5, "public/icons/icon-maskable-512.png"); // inside the 80% safe zone
await icon(180, 0.7, "public/icons/apple-touch-icon.png");
await icon(32, 0.85, "public/icons/favicon-32.png");

// Capacitor asset sources (icon 1024, adaptive foreground, splash 2732).
await icon(1024, 0.7, "mobile/assets/icon-only.png");
{
  const fg = await sharp(SRC).resize({ height: 600, fit: "inside" }).png().toBuffer();
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: fg, gravity: "center" }])
    .png()
    .toFile("mobile/assets/icon-foreground.png");
  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: NAVY }
  })
    .png()
    .toFile("mobile/assets/icon-background.png");
  console.log("wrote adaptive icon layers");
}
{
  const mark = await sharp(SRC).resize({ height: 900, fit: "inside" }).png().toBuffer();
  await sharp({
    create: { width: 2732, height: 2732, channels: 4, background: NAVY }
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile("mobile/assets/splash.png");
  await sharp({
    create: { width: 2732, height: 2732, channels: 4, background: NAVY }
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile("mobile/assets/splash-dark.png");
  console.log("wrote splash sources");
}
