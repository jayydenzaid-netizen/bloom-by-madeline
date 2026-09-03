import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PageHeader } from "../../_components/ui";
import PrendaRapida from "./_components/PrendaRapida";
import "./prenda.css";

/**
 * «Añadir prenda»: el alta del día a día, pensada para el móvil.
 *
 * El editor completo (`/admin/productos/nuevo`) sigue existiendo para los casos
 * raros —varios colores, precios distintos por talla, SEO a mano—, pero pedía
 * demasiado para lo normal. Aquí solo hay cuatro cosas: fotos, nombre, precio y
 * cuántas piezas por talla. Todo lo demás lo rellena el servidor.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Añadir prenda" };

export default async function NuevaPrendaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  // Las categorías salen del catálogo, no de una lista escrita a fuego: si
  // Madeline crea «Faldas» en Colecciones, aparece aquí sola.
  const categorias = await db.collection.findMany({
    where: { isVisible: true },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { id: true, title: true },
  });

  const sp = await searchParams;
  const uno = (k: string) => ((Array.isArray(sp[k]) ? sp[k]?.[0] : sp[k]) ?? "").trim();
  const nombre = uno("hecha");
  const recienCreada = nombre
    ? { nombre, publicada: uno("pub") === "1", id: uno("id") }
    : null;

  return (
    <>
      <PageHeader
        title="Añadir prenda"
        subtitle="Fotos, nombre, precio y tallas. Nada más."
        actions={
          <Link className="adm-btn adm-btn-ghost adm-btn-sm" href="/admin/productos">
            Ver mis prendas
          </Link>
        }
      />

      <PrendaRapida recienCreada={recienCreada} categorias={categorias} />

      <p className="np-avanzado">
        ¿Necesitas colores, precios distintos por talla o ajustes de buscadores?{" "}
        <Link href="/admin/productos/nuevo">Abrir el editor completo</Link>
      </p>
    </>
  );
}
