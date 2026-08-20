import { db } from "@/lib/db";

/** "Vestido Coral · Talla M" -> "vestido-coral-talla-m" */
export function slugify(input: string): string {
  return (input || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "producto";
}

/**
 * Devuelve un slug libre en la tabla de productos. Si "vestido-coral" ya existe
 * prueba "vestido-coral-2", "-3"... `ignoreId` permite re-guardar un producto sin
 * que choque consigo mismo.
 */
export async function uniqueProductSlug(title: string, ignoreId?: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const found = await db.product.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!found || found.id === ignoreId) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export async function uniqueCollectionSlug(title: string, ignoreId?: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    const found = await db.collection.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!found || found.id === ignoreId) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}
