import type { MetadataRoute } from "next";
import { construirRobots } from "@/lib/seo";

/**
 * `/robots.txt` — lo primero que lee un buscador antes de rastrear.
 *
 * Sustituye al `public/robots.txt` del sitio antiguo, que decía «Allow: /» a
 * secas: eso dejaba el panel, la API y el checkout abiertos al rastreo. Aquí se
 * cierran y se apunta al sitemap.
 *
 * OJO al desplegar: Next NO admite un fichero estático y una ruta generada con
 * la misma dirección. Si vuelve a aparecer `public/robots.txt`, el build falla
 * con «A conflicting public file and page file was found».
 */
export default function robots(): MetadataRoute.Robots {
  return construirRobots();
}
