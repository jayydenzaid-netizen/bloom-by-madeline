import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    // Las fotos importadas de proveedores viven en sus CDNs.
    remotePatterns: [
      { protocol: "https", hostname: "*.alicdn.com" },
      { protocol: "https", hostname: "*.aliexpress-media.com" },
      { protocol: "https", hostname: "*.cdninstagram.com" },
      { protocol: "https", hostname: "*.fbcdn.net" },
      // Las fotos que sube Madeline desde el móvil (Vercel Blob).
      { protocol: "https", hostname: "*.vercel-storage.com" },
    ],
  },
  // El one-page original queda accesible como referencia histórica.
  async rewrites() {
    return [];
  },
};

export default config;
