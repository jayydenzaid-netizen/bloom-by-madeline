import type { MetadataRoute } from "next";
import { construirSitemap } from "@/lib/seo";

/**
 * `/sitemap.xml` — el índice que le damos a Google.
 *
 * Se genera desde la base de datos en cada petición (`force-dynamic`): en
 * cuanto Madeline publica un producto desde el móvil, el sitemap ya lo lista.
 * Con caché estática, un producto publicado el jueves no aparecería hasta el
 * siguiente despliegue, que en esta tienda puede tardar semanas.
 *
 * La lógica de qué entra y qué no vive en `lib/seo.ts`, para que el sitemap y
 * el panel de SEO cuenten exactamente lo mismo.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return construirSitemap();
}
