/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "api.dicebear.com" }
    ]
  },
  experimental: {
    optimizePackageImports: ["clsx"]
  },
  async headers() {
    return [
      {
        // The service worker must always be re-fetched so a bad version can be
        // replaced immediately, and may control the whole origin.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "X-Content-Type-Options", value: "nosniff" }
        ]
      },
      {
        // The participant area is personal and its content differs for the
        // mobile app (the badge page may carry the owner's own token): never
        // store it in any shared or browser cache, and vary by User-Agent.
        source: "/compte/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Vary", value: "User-Agent" }
        ]
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Content-Type", value: "application/manifest+json" },
          { key: "Cache-Control", value: "public, max-age=3600" }
        ]
      },
      // Offline shell files: small, public, always revalidated.
      ...["/offline.html", "/offline.js", "/offline-core.js"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }]
      }))
    ];
  }
};

export default nextConfig;
