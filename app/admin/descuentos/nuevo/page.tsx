import { requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import DiscountForm from "../_components/DiscountForm";

/**
 * Alta de un código de descuento. Es el mismo formulario que la edición, con el
 * descuento a null; así no hay dos pantallas que se puedan desincronizar.
 *
 * Aquí se cargan las colecciones y los productos para el selector "a qué se
 * aplica". Se traen todos (una boutique no tiene diez mil) y el buscador filtra
 * en el navegador: así elegir tres colecciones no cuesta tres viajes al
 * servidor desde el móvil de la tienda.
 */

export const dynamic = "force-dynamic";

export default async function NuevoDescuentoPage() {
  const admin = await requireOwner("descuentos");

  const [colecciones, productos] = await Promise.all([
    db.collection.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }], select: { id: true, title: true } }),
    db.product.findMany({
      where: { status: { not: "archived" } },
      orderBy: { title: "asc" },
      take: 500,
      select: { id: true, title: true },
    }),
  ]);

  return <DiscountForm descuento={null} colecciones={colecciones} productos={productos} />;
}
