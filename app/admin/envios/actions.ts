"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import { parseToCents } from "@/lib/money";
import {
  cargarAjustesEnvio,
  normalizarRegion,
  plantillaZonasIniciales,
  saveTaxConfig,
  tipoAPuntosBasicos,
} from "@/lib/shipping";

/**
 * Mutaciones de zonas de envío, tarifas e impuestos.
 *
 * Igual que en el resto del panel, los formularios funcionan sin JavaScript y el
 * resultado viaja como un código en la URL que la pantalla traduce. Nunca texto
 * libre: un mensaje que viene de la barra de direcciones es un cartel que
 * cualquiera puede escribir con un enlace preparado.
 */

const VOLVER = "/admin/envios";

async function exigirSesion() {
  // Envíos e impuestos: solo la dueña. Devuelve la cuenta (con rol) para la bitácora.
  return requireOwner("envios");
}

function refrescar() {
  revalidatePath("/admin/envios");
  // El checkout enseña las opciones de envío: si cambian aquí, allí también.
  revalidatePath("/checkout");
  revalidatePath("/carrito");
}

/* ───────────────────────────── zonas ───────────────────────────── */

const EsquemaZona = z.object({
  name: z.string().trim().min(1, "nombre"),
});

export async function guardarZona(fd: FormData): Promise<void> {
  const admin = await exigirSesion();

  const id = String(fd.get("id") ?? "").trim() || null;
  const datos = EsquemaZona.safeParse({ name: String(fd.get("name") ?? "") });
  if (!datos.success) redirect(`${VOLVER}?zona=${id ?? "nueva"}&error=nombre`);

  // Las regiones llegan como varias casillas con el mismo nombre.
  const regiones = fd
    .getAll("regions")
    .map((r) => normalizarRegion(String(r)))
    .filter(Boolean);

  const unicas = Array.from(new Set(regiones));
  if (unicas.length === 0) redirect(`${VOLVER}?zona=${id ?? "nueva"}&error=regiones`);

  if (id) {
    const previa = await db.shippingZone.findUnique({ where: { id }, select: { id: true } });
    if (!previa) redirect(`${VOLVER}?hecho=no-existe`);

    await db.shippingZone.update({
      where: { id },
      data: { name: datos.data.name, regionsJson: JSON.stringify(unicas) },
    });
    await logActivity({
      action: "update",
      entityType: "shipping_zone",
      entityId: id,
      summary: `Cambió la zona de envío ${datos.data.name}`,
      userId: admin.id,
      userEmail: admin.email,
    });
  } else {
    const total = await db.shippingZone.count();
    const creada = await db.shippingZone.create({
      data: { name: datos.data.name, regionsJson: JSON.stringify(unicas), position: total },
    });
    await logActivity({
      action: "create",
      entityType: "shipping_zone",
      entityId: creada.id,
      summary: `Creó la zona de envío ${datos.data.name}`,
      userId: admin.id,
      userEmail: admin.email,
    });
  }

  refrescar();
  redirect(`${VOLVER}?hecho=zona-guardada`);
}

export async function borrarZona(fd: FormData): Promise<void> {
  const admin = await exigirSesion();
  const id = String(fd.get("id") ?? "").trim();
  if (!id) redirect(VOLVER);

  const confirmado = String(fd.get("confirmado") ?? "") === "si";
  if (!confirmado) redirect(`${VOLVER}?borrarZona=${id}`);

  const zona = await db.shippingZone.findUnique({
    where: { id },
    select: { name: true, _count: { select: { rates: true } } },
  });
  if (!zona) redirect(`${VOLVER}?hecho=no-existe`);

  // Las tarifas caen con la zona (onDelete: Cascade en el esquema).
  await db.shippingZone.delete({ where: { id } });
  await logActivity({
    action: "delete",
    entityType: "shipping_zone",
    entityId: id,
    summary: `Borró la zona ${zona.name} y sus ${zona._count.rates} tarifas`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar();
  redirect(`${VOLVER}?hecho=zona-borrada`);
}

export async function moverZona(fd: FormData): Promise<void> {
  await exigirSesion();
  const id = String(fd.get("id") ?? "").trim();
  const direccion = String(fd.get("direccion") ?? "");
  if (!id || (direccion !== "arriba" && direccion !== "abajo")) redirect(VOLVER);

  const zonas = await db.shippingZone.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  const i = zonas.findIndex((z) => z.id === id);
  const j = direccion === "arriba" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= zonas.length) redirect(VOLVER);

  // Reescribimos todas las posiciones: es la forma más simple de que no queden
  // huecos ni empates después de varias reordenaciones.
  const orden = [...zonas];
  [orden[i], orden[j]] = [orden[j], orden[i]];
  await db.$transaction(
    orden.map((z, pos) => db.shippingZone.update({ where: { id: z.id }, data: { position: pos } })),
  );

  refrescar();
  redirect(VOLVER);
}

/* ───────────────────────────── tarifas ───────────────────────────── */

export async function guardarTarifa(fd: FormData): Promise<void> {
  const admin = await exigirSesion();

  const zoneId = String(fd.get("zoneId") ?? "").trim();
  const id = String(fd.get("id") ?? "").trim() || null;
  if (!zoneId) redirect(VOLVER);

  const zona = await db.shippingZone.findUnique({ where: { id: zoneId }, select: { name: true } });
  if (!zona) redirect(`${VOLVER}?hecho=no-existe`);

  const name = String(fd.get("name") ?? "").trim();
  if (!name) redirect(`${VOLVER}?tarifa=${id ?? `nueva-${zoneId}`}&error=nombre`);

  // parseToCents acepta "6.95", "$6.95" y "6,95": lo que Madeline escriba.
  const priceCents = parseToCents(String(fd.get("price") ?? "0")) ?? 0;
  const minSubtotalCents = parseToCents(String(fd.get("min") ?? "0")) ?? 0;
  const maxSubtotalCents = parseToCents(String(fd.get("max") ?? "0")) ?? 0;

  if (priceCents < 0 || minSubtotalCents < 0 || maxSubtotalCents < 0) {
    redirect(`${VOLVER}?tarifa=${id ?? `nueva-${zoneId}`}&error=negativo`);
  }
  // Un tramo con el techo por debajo del suelo no lo cumple ningún pedido: es
  // una tarifa que nunca se vería y que parecería un fallo de la tienda.
  if (maxSubtotalCents > 0 && maxSubtotalCents < minSubtotalCents) {
    redirect(`${VOLVER}?tarifa=${id ?? `nueva-${zoneId}`}&error=tramo`);
  }

  const datos = {
    name,
    priceCents,
    minSubtotalCents,
    maxSubtotalCents,
    etaLabel: String(fd.get("eta") ?? "").trim(),
  };

  if (id) {
    const previa = await db.shippingRate.findUnique({ where: { id }, select: { id: true } });
    if (!previa) redirect(`${VOLVER}?hecho=no-existe`);
    await db.shippingRate.update({ where: { id }, data: datos });
  } else {
    const total = await db.shippingRate.count({ where: { zoneId } });
    await db.shippingRate.create({ data: { ...datos, zoneId, position: total } });
  }

  await logActivity({
    action: id ? "update" : "create",
    entityType: "shipping_rate",
    entityId: id ?? undefined,
    summary: `${id ? "Cambió" : "Añadió"} la tarifa ${name} en ${zona.name}`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar();
  redirect(`${VOLVER}?hecho=tarifa-guardada`);
}

export async function borrarTarifa(fd: FormData): Promise<void> {
  const admin = await exigirSesion();
  const id = String(fd.get("id") ?? "").trim();
  if (!id) redirect(VOLVER);

  const tarifa = await db.shippingRate.findUnique({
    where: { id },
    select: { name: true, zone: { select: { name: true } } },
  });
  if (!tarifa) redirect(`${VOLVER}?hecho=no-existe`);

  await db.shippingRate.delete({ where: { id } });
  await logActivity({
    action: "delete",
    entityType: "shipping_rate",
    entityId: id,
    summary: `Borró la tarifa ${tarifa.name} de ${tarifa.zone.name}`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar();
  redirect(`${VOLVER}?hecho=tarifa-borrada`);
}

/* ──────────────────────── configuración inicial ──────────────────────── */

/**
 * Crea el punto de partida (Ohio, Estados Unidos y recogida en la boutique) con
 * los importes que ya están en los ajustes generales. No inventa precios: si
 * hoy la tienda cobra $6.95 de envío, eso es lo que aparece.
 */
export async function crearConfiguracionInicial(): Promise<void> {
  const admin = await exigirSesion();

  const existentes = await db.shippingZone.count();
  if (existentes > 0) redirect(`${VOLVER}?hecho=ya-hay-zonas`);

  const ajustes = await cargarAjustesEnvio();
  const plantilla = plantillaZonasIniciales(ajustes);

  await db.$transaction(async (tx) => {
    for (const [i, zona] of plantilla.entries()) {
      await tx.shippingZone.create({
        data: {
          name: zona.name,
          regionsJson: JSON.stringify(zona.regions),
          position: i,
          rates: {
            create: zona.rates.map((t) => ({
              name: t.name,
              priceCents: t.priceCents,
              minSubtotalCents: t.minSubtotalCents,
              maxSubtotalCents: t.maxSubtotalCents,
              etaLabel: t.etaLabel,
              position: t.position,
            })),
          },
        },
      });
    }
  });

  await logActivity({
    action: "create",
    entityType: "shipping_zone",
    summary: `Creó la configuración inicial de envíos (${plantilla.length} zonas)`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar();
  redirect(`${VOLVER}?hecho=inicial-creada`);
}

/* ───────────────────────────── impuestos ───────────────────────────── */

export async function guardarImpuestos(fd: FormData): Promise<void> {
  const admin = await exigirSesion();

  const activo = fd.get("activo") === "on";
  const rateBps = tipoAPuntosBasicos(String(fd.get("rate") ?? ""));
  const etiqueta = String(fd.get("etiqueta") ?? "").trim() || "Impuesto sobre ventas";
  const estados = fd
    .getAll("estados")
    .map((e) => normalizarRegion(String(e)))
    .filter(Boolean);
  const confirmadoPor = String(fd.get("confirmadoPor") ?? "").trim();

  if (rateBps === null || rateBps < 0) redirect(`${VOLVER}?error=tipo#impuestos`);
  // Un 30 % de impuesto sobre ventas no existe en Estados Unidos: es un dedo
  // resbalado. Mejor rechazarlo que cobrárselo a una clienta.
  if (rateBps > 3000) redirect(`${VOLVER}?error=tipo-alto#impuestos`);

  // Activar el cobro sin haber escrito quién confirmó el tipo es exactamente el
  // error que este módulo existe para evitar.
  if (activo && (rateBps === 0 || !confirmadoPor)) {
    redirect(`${VOLVER}?error=sin-confirmar#impuestos`);
  }

  await saveTaxConfig({
    activo,
    rateBps,
    etiqueta,
    estados: Array.from(new Set(estados)),
    confirmadoPor,
  });

  await logActivity({
    action: "update",
    entityType: "setting",
    summary: activo
      ? `Activó el impuesto sobre ventas al ${(rateBps / 100).toFixed(2)} %`
      : "Desactivó el cobro de impuesto sobre ventas",
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar();
  redirect(`${VOLVER}?hecho=impuestos-guardados#impuestos`);
}
