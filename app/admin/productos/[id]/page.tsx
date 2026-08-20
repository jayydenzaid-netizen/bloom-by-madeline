import { notFound, redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import ProductForm, { type ProductoEditable } from "../_components/ProductForm";

/**
 * Ficha de producto. Solo carga y traduce: toda la edición vive en ProductForm
 * y todo el guardado en el Server Action, para que crear y editar recorran
 * exactamente el mismo camino.
 */

export const dynamic = "force-dynamic";

export default async function EditarProductoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  // En Next 15 params y searchParams son promesas.
  const { id } = await params;
  const sp = await searchParams;

  const [producto, colecciones, ajustes] = await Promise.all([
    db.product.findUnique({
      where: { id },
      include: {
        images: { orderBy: { position: "asc" } },
        variants: { orderBy: { position: "asc" } },
        collections: { select: { collectionId: true } },
      },
    }),
    db.collection.findMany({
      orderBy: [{ position: "asc" }, { title: "asc" }],
      select: { id: true, title: true },
    }),
    getSettings(),
  ]);

  if (!producto) notFound();

  const editable: ProductoEditable = {
    id: producto.id,
    title: producto.title,
    slug: producto.slug,
    description: producto.description,
    status: producto.status,
    vendor: producto.vendor,
    productType: producto.productType,
    // tagsJson y optionNamesJson son Strings con JSON dentro: si alguien los
    // dejó corruptos a mano, mejor abrir la ficha vacía que reventar la página.
    tags: leerLista(producto.tagsJson),
    optionNames: leerLista(producto.optionNamesJson),
    seoTitle: producto.seoTitle ?? "",
    seoDescription: producto.seoDescription ?? "",
    sourceProvider: producto.sourceProvider,
    sourceUrl: producto.sourceUrl,
    coleccionesIds: producto.collections.map((c) => c.collectionId),
    imagenes: producto.images.map((img) => ({ id: img.id, url: img.url, alt: img.alt })),
    variantes: producto.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
      priceCents: v.priceCents,
      compareAtCents: v.compareAtCents,
      costCents: v.costCents,
      stock: v.stock,
      trackStock: v.trackStock,
      imageUrl: v.imageUrl,
    })),
  };

  return (
    <ProductForm
      producto={editable}
      colecciones={colecciones}
      pricing={ajustes.pricing}
      recienCreado={sp.guardado === "1"}
    />
  );
}

function leerLista(json: string): string[] {
  try {
    const valor: unknown = JSON.parse(json || "[]");
    return Array.isArray(valor) ? valor.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
