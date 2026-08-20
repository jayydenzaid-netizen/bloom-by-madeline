import type { Metadata, Viewport } from "next";
import "./globals.css";

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://bloom-by-madeline.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: "Bloom by Madeline — Boutique de Moda Femenina · Hamilton, Ohio",
    template: "%s · Bloom by Madeline",
  },
  description:
    "Tendencias exclusivas seleccionadas a mano. Elevamos tu estilo casual elegante. Boutique de moda femenina en 1305 Grand Blvd, Hamilton, OH. Envíos a todo USA.",
  alternates: { canonical: "/" },
  openGraph: {
    siteName: "Bloom by Madeline",
    title: "Bloom by Madeline — Boutique de Moda Femenina",
    description:
      "Tendencias exclusivas · Elevamos tu estilo casual elegante · Hamilton, OH · Envíos a todo USA",
    type: "website",
    locale: "es_US",
    url: "/",
    images: [
      {
        url: "/assets/og.jpg",
        width: 1200,
        height: 630,
        alt: "Bloom by Madeline — boutique de moda femenina en Hamilton, Ohio",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bloom by Madeline — Boutique de Moda Femenina",
    description: "Tendencias exclusivas · Estilo casual elegante · Hamilton, OH · Envíos a todo USA",
    images: ["/assets/og.jpg"],
  },
  icons: {
    icon: "/favicon.svg",
    apple: "/assets/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#ECE1CD",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Jost:wght@300;400;500&family=Allura&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
