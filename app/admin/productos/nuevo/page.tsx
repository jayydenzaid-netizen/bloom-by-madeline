import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import ProductForm from "../_components/ProductForm";

/**
 * Alta de producto. Es el mismo editor que la ficha existente, con `producto`
 * a null: mantener dos formularios distintos para crear y editar es la forma
 * más segura de que uno de los dos se quede atrás.
 */

export const dynamic = "force-dynamic";

export default async function NuevoProductoPage() {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const [colecciones, ajustes] = await Promise.all([
    db.collection.findMany({
      orderBy: [{ position: "asc" }, { title: "asc" }],
      select: { id: true, title: true },
    }),
    // La regla de precio de la tienda alimenta el botón "precio desde el coste"
    // del editor de variantes.
    getSettings(),
  ]);

  return <ProductForm producto={null} colecciones={colecciones} pricing={ajustes.pricing} />;
}
