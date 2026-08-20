"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Mutaciones de las plantillas de mensajes.
 *
 * Importante y honesto: hoy la tienda NO tiene servicio de correo, así que
 * guardar una plantilla no manda nada a nadie. Estas plantillas son el guion de
 * lo que Madeline copia y pega en el DM de Instagram, que es su canal real. El
 * día que se conecte un proveedor de correo, estos mismos textos se envían
 * solos sin tocar una línea: por eso se guardan estructurados (asunto + cuerpo
 * + variables) y no como notas sueltas.
 */

/* ─────────────────────────── claves ─────────────────────────── */

/**
 * Las tres plantillas del ciclo de una venta. `key` es único en la tabla.
 *
 * OJO: en un fichero "use server" SOLO se pueden exportar funciones async, así
 * que estas constantes se quedan dentro. La pantalla mantiene su propia lista
 * (con etiquetas y explicaciones para Madeline) en plantillas/page.tsx.
 */
const CLAVES_PLANTILLA = ["order_confirmation", "order_shipped", "abandoned_cart"] as const;
export type ClavePlantilla = (typeof CLAVES_PLANTILLA)[number];

/* ─────────────────────────── auditoría ─────────────────────────── */

async function registrar(
  admin: { id: string; email: string },
  action: string,
  entityId: string | null,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db.activityLog
    .create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action,
        entityType: "emailTemplate",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    .catch(() => {});
}

function volver(parametros: Record<string, string>): never {
  const query = new URLSearchParams();
  for (const [clave, valor] of Object.entries(parametros)) {
    if (valor) query.set(clave, valor.slice(0, 300));
  }
  redirect(`/admin/plantillas?${query.toString()}`);
}

/* ─────────────────────────── textos de partida ─────────────────────────── */

/**
 * Borradores iniciales. No inventan NADA que solo sepa Madeline (ni plazos, ni
 * precios, ni políticas): todo lo que cambia entre un pedido y otro va como
 * variable `{{…}}`, y lo que ella tendría que decidir se deja fuera.
 *
 * El tono es el suyo: cercano, de tú, sin corporativismo.
 */
const PLANTILLAS_BASE: Record<ClavePlantilla, { subject: string; body: string }> = {
  order_confirmation: {
    subject: "Tu pedido {{numero}} está confirmado ✿",
    body: `Hola {{nombre}}:

¡Gracias por tu pedido! Ya lo tengo apuntado y lo estoy preparando.

Pedido: {{numero}}
Fecha: {{fecha}}

{{articulos}}

Total: {{total}}

Te escribo en cuanto salga. Si necesitas cambiar algo (una talla, la dirección), contéstame a este mismo mensaje y lo arreglamos.

Gracias por comprar en {{tienda}} ✿
{{instagram}}`,
  },
  order_shipped: {
    subject: "Tu pedido {{numero}} va de camino",
    body: `Hola {{nombre}}:

Tu pedido {{numero}} ya salió.

Transportista: {{transportista}}
Número de seguimiento: {{seguimiento}}

{{articulos}}

Cuando te llegue, cuéntame qué tal te queda — y si te haces una foto, etiquétame, que me encanta verlo puesto.

{{tienda}}
{{instagram}}`,
  },
  abandoned_cart: {
    subject: "{{nombre}}, te dejaste algo en el carrito",
    body: `Hola {{nombre}}:

Vi que te quedaste a medias con esto:

{{articulos}}

Te lo guardo un ratito, pero traigo poquitas unidades de cada pieza y vuelan.

Si tienes dudas de talla o quieres más fotos, dímelo y te las mando ahora mismo.

Terminar el pedido: {{enlace}}

{{tienda}}
{{instagram}}`,
  },
};

/* ─────────────────────────── crear las que falten ─────────────────────────── */

/**
 * Crea las plantillas que no existan todavía, con el texto de partida.
 * Se puede pulsar dos veces sin duplicar nada.
 */
export async function crearPlantillasQueFaltan(): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const existentes = await db.emailTemplate.findMany({ select: { key: true } });
  const yaEstan = new Set(existentes.map((p) => p.key));

  let creadas = 0;
  for (const clave of CLAVES_PLANTILLA) {
    if (yaEstan.has(clave)) continue;
    const base = PLANTILLAS_BASE[clave];
    await db.emailTemplate.create({
      data: { key: clave, subject: base.subject, body: base.body, isActive: true },
    });
    creadas++;
  }

  await registrar(admin, "create", null, `Creó ${creadas} plantillas de mensaje`, { creadas });
  revalidatePath("/admin/plantillas");
  volver({ ok: `Listo: ${creadas} plantillas creadas. Léelas y cámbialas a tu manera de escribir.` });
}

/* ─────────────────────────── guardar ─────────────────────────── */

const EsquemaPlantilla = z.object({
  key: z.enum(CLAVES_PLANTILLA),
  subject: z
    .string()
    .trim()
    .min(3, "El asunto no puede quedarse vacío.")
    .max(200, "El asunto es larguísimo: en el móvil solo se leen las primeras palabras."),
  body: z.string().trim().min(5, "El mensaje no puede quedarse vacío.").max(8000, "El mensaje es demasiado largo."),
  isActive: z.boolean().default(true),
});

export async function guardarPlantilla(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const datos = EsquemaPlantilla.safeParse({
    key: String(fd.get("key") ?? ""),
    subject: String(fd.get("subject") ?? ""),
    body: String(fd.get("body") ?? ""),
    isActive: String(fd.get("isActive") ?? "1") === "1",
  });

  if (!datos.success) {
    volver({ error: datos.error.issues[0]?.message ?? "Revisa el asunto y el mensaje." });
  }

  const v = datos.data;
  const guardada = await db.emailTemplate.upsert({
    where: { key: v.key },
    create: { key: v.key, subject: v.subject, body: v.body, isActive: v.isActive },
    update: { subject: v.subject, body: v.body, isActive: v.isActive },
  });

  await registrar(admin, "update", guardada.id, `Editó la plantilla "${v.key}"`, { activa: v.isActive });
  revalidatePath("/admin/plantillas");
  volver({ ok: "Mensaje guardado. Recuerda: se copia y se pega, todavía no sale solo." });
}

/* ─────────────────────────── restaurar el texto de partida ─────────────────────────── */

/**
 * Devuelve una plantilla a su texto original. Es una vuelta atrás, no un
 * borrado: por eso basta con confirmarlo desde la pantalla (`?restaurar=clave`)
 * y no hace falta teclear nada.
 */
export async function restaurarPlantilla(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const clave = String(fd.get("key") ?? "") as ClavePlantilla;
  if (!CLAVES_PLANTILLA.includes(clave)) {
    volver({ error: "No sé qué plantilla querías restaurar." });
  }

  const base = PLANTILLAS_BASE[clave];
  const guardada = await db.emailTemplate.upsert({
    where: { key: clave },
    create: { key: clave, subject: base.subject, body: base.body, isActive: true },
    update: { subject: base.subject, body: base.body },
  });

  await registrar(admin, "update", guardada.id, `Restauró el texto de partida de "${clave}"`);
  revalidatePath("/admin/plantillas");
  volver({ ok: "Plantilla devuelta al texto de partida." });
}
