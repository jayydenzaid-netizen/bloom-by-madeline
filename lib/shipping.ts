// Envíos e impuestos: quién cobra qué por llevar el paquete y cuánto impuesto
// se le suma al pedido.
//
// Vive aquí y no dentro del panel porque el CHECKOUT tiene que usar exactamente
// estas mismas funciones. Si la caja calculara el envío por su cuenta, tarde o
// temprano cobraría algo distinto de lo que la pantalla de /admin/envios promete
// —y eso se descubre siempre con la clienta delante, con el pedido a medias.
//
// Reglas de la casa que aquí se cumplen sin excepción:
//  1. Todo el dinero va en CENTAVOS ENTEROS. Ni un float.
//  2. El impuesto NUNCA se inventa: si nadie ha confirmado el tipo aplicable,
//     se cobra 0 y se dice por qué. Cobrar mal un impuesto es un problema legal.
//  3. La parte de cálculo no importa Prisma: se le pasan los datos y devuelve el
//     resultado. Así el simulador del panel y la caja comparten el mismo código
//     y no pueden discrepar. Solo las funciones que leen la base de datos cargan
//     el cliente de Prisma, y lo hacen bajo demanda, ya dentro de la función.
//
// ─────────────────────────────────────────────────────────────────────────────
// CÓMO ENCHUFAR ESTO AL CHECKOUT (para quien construya /checkout)
// ─────────────────────────────────────────────────────────────────────────────
//
//   import { calculateShipping, calculateTax } from "@/lib/shipping";
//
//   // 1) Con el subtotal del carrito (después de descuentos de producto) y el
//   //    destino que la clienta va tecleando, se piden las opciones:
//   const envio = await calculateShipping(subtotalCents, {
//     state: form.state,          // "OH" o "Ohio", da igual
//     country: form.country,      // por defecto "US"
//     weightGrams: pesoTotal,     // opcional, ver nota de peso más abajo
//   });
//
//   // 2) `envio.opciones` SIEMPRE trae al menos una opción. Se pintan todas como
//   //    radio buttons: la clienta elige entre envío y recogida en la boutique.
//   //    Nunca elijas tú por ella; la recogida le ahorra dinero y a la boutique
//   //    también, pero es su decisión.
//   const elegida = envio.opciones.find((o) => o.id === form.opcionEnvioId) ?? envio.opciones[0];
//
//   // 3) El impuesto se calcula sobre lo que diga la contable que es imponible.
//   //    Por defecto aquí va SOLO el subtotal; si te confirman que el envío
//   //    también tributa en Ohio, pasa `subtotalCents + elegida.priceCents`.
//   const impuesto = await calculateTax(subtotalCents, { state: form.state });
//
//   const totalCents = subtotalCents + elegida.priceCents + impuesto.taxCents;
//
//   // 4) Al crear el Order, guarda copia congelada de lo cobrado:
//   //    shippingCents: elegida.priceCents, taxCents: impuesto.taxCents.
//   //    Un pedido viejo tiene que seguir siendo auditable aunque después se
//   //    cambien las zonas o el tipo de impuesto.
//
// Si `impuesto.aplicado` es false hay que enseñar `impuesto.nota` en el resumen
// (o simplemente no mostrar la línea de impuesto): no se está cobrando nada.
//
// NOTA SOBRE EL PESO: el modelo `ShippingRate` de hoy solo tiene tramos por
// SUBTOTAL, no por peso. `weightGrams` se acepta en la firma para no tener que
// cambiarla el día que se añadan tramos por peso, y viaja hasta el resultado
// para poder enseñarlo, pero hoy no altera ningún precio. Está documentado a
// propósito en vez de fingir que funciona.

import { formatCents } from "@/lib/money";

/* ───────────────────────────── regiones ───────────────────────────── */

/**
 * Los 50 estados + Washington D.C. Es un dato público y fijo, no un dato
 * inventado de la clienta. El selector del panel se alimenta de aquí.
 */
export const ESTADOS_US: ReadonlyArray<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "Distrito de Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawái" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Luisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Míchigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Misisipi" },
  { code: "MO", name: "Misuri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "Nuevo Hampshire" },
  { code: "NJ", name: "Nueva Jersey" },
  { code: "NM", name: "Nuevo México" },
  { code: "NY", name: "Nueva York" },
  { code: "NC", name: "Carolina del Norte" },
  { code: "ND", name: "Dakota del Norte" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregón" },
  { code: "PA", name: "Pensilvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "Carolina del Sur" },
  { code: "SD", name: "Dakota del Sur" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "Virginia Occidental" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

const ESTADO_POR_CODIGO = new Map(ESTADOS_US.map((e) => [e.code, e.name]));
const CODIGO_POR_NOMBRE = new Map(ESTADOS_US.map((e) => [quitarAcentos(e.name).toUpperCase(), e.code]));

/** Cualquier destino. Es la zona que recoge lo que no encaja en ninguna otra. */
export const REGION_COMODIN = "*";
/** Marca una zona como "recogida en la boutique": se ofrece siempre y vale $0. */
export const REGION_RECOGIDA = "PICKUP";
/** País por defecto: la boutique está en Hamilton, Ohio. */
export const PAIS_POR_DEFECTO = "US";

/**
 * Formas admitidas en `ShippingZone.regionsJson` (JSON: string[]):
 *
 *   "*"        → cualquier destino (comodín)
 *   "PICKUP"   → zona de recogida en tienda, no depende del destino
 *   "US-OH"    → un estado concreto (forma canónica, estilo ISO 3166-2)
 *   "US"       → un país entero
 *   "OH"       → forma corta heredada; se lee como estado si el código existe
 *
 * La forma corta es ambigua a propósito solo en un caso ("CA" es California y
 * también Canadá): gana el ESTADO, porque esta tienda vende dentro de EEUU. Al
 * guardar desde el panel siempre se escribe la forma canónica "US-CA", así que
 * la ambigüedad solo puede venir de datos escritos a mano.
 */
export function normalizarRegion(raw: string): string {
  const limpio = String(raw ?? "").trim().toUpperCase();
  if (!limpio) return "";
  if (limpio === REGION_COMODIN || limpio === REGION_RECOGIDA) return limpio;
  // "us-oh" y "US - OH" acaban igual: sin espacios y con un solo guion.
  return limpio.replace(/\s+/g, "").replace(/-+/g, "-");
}

/** "Ohio", "ohio", "OH", "US-OH" → "OH". Devuelve "" si no lo reconoce. */
export function codigoEstado(valor: string | null | undefined): string {
  const limpio = String(valor ?? "").trim();
  if (!limpio) return "";
  const alto = limpio.toUpperCase();
  const conGuion = alto.includes("-") ? alto.split("-").pop() ?? "" : alto;
  if (ESTADO_POR_CODIGO.has(conGuion)) return conGuion;
  return CODIGO_POR_NOMBRE.get(quitarAcentos(limpio).toUpperCase()) ?? "";
}

/** "OH" → "Ohio". Si no lo conoce devuelve el propio código, no un hueco. */
export function nombreEstado(code: string): string {
  return ESTADO_POR_CODIGO.get(String(code ?? "").toUpperCase()) ?? String(code ?? "");
}

function quitarAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Texto legible de las regiones de una zona, para el panel. */
export function describirRegiones(regions: string[]): string {
  const limpias = regions.map(normalizarRegion).filter(Boolean);
  if (limpias.length === 0) return "Sin regiones: esta zona no se aplicará a nadie";
  if (limpias.includes(REGION_RECOGIDA)) return "Recogida en la boutique";
  if (limpias.includes(REGION_COMODIN)) return "Cualquier destino";

  const estados: string[] = [];
  const paises: string[] = [];
  for (const region of limpias) {
    const estado = region.includes("-") ? region.split("-")[1] : region;
    if (ESTADO_POR_CODIGO.has(estado)) estados.push(nombreEstado(estado));
    else paises.push(region === "US" ? "Estados Unidos" : region);
  }
  const partes = [...paises, ...estados];
  if (partes.length <= 4) return partes.join(" · ");
  return `${partes.slice(0, 4).join(" · ")} y ${partes.length - 4} más`;
}

/* ───────────────────────────── tipos ───────────────────────────── */

/** Una tarifa dentro de una zona. Encaja tal cual con `ShippingRate`. */
export type TarifaEnvio = {
  id: string;
  name: string;
  priceCents: number;
  minSubtotalCents: number;
  /** 0 = sin tope. */
  maxSubtotalCents: number;
  etaLabel: string;
  position: number;
};

/** Una zona con sus tarifas. `regions` ya viene parseado del JSON. */
export type ZonaEnvio = {
  id: string;
  name: string;
  regions: string[];
  position: number;
  rates: TarifaEnvio[];
};

export type Destino = {
  /** "OH", "Ohio" o "US-OH": se normaliza sola. */
  state?: string | null;
  /** Por defecto "US". */
  country?: string | null;
  /** Hoy no altera precios; ver la nota sobre el peso arriba. */
  weightGrams?: number | null;
};

/** Lo que ve la clienta en el checkout: una opción por la que puede optar. */
export type OpcionEnvio = {
  /** Id de la tarifa, o "ajustes:estandar" / "ajustes:recogida" en el respaldo. */
  id: string;
  zoneId: string | null;
  zoneName: string;
  name: string;
  priceCents: number;
  /** Plazo estimado tal y como lo escribió Madeline. Puede ir vacío. */
  etaLabel: string;
  esRecogida: boolean;
  /** Explicación extra ("Gratis por superar $75.00"). Puede ir vacía. */
  nota: string;
};

/** Los ajustes generales de la tienda que afectan al envío (lib/settings.ts). */
export type AjustesEnvio = {
  freeShippingOverCents: number;
  flatShippingCents: number;
  localPickup: boolean;
  shippingNotice: string;
};

export type ResultadoEnvio = {
  /** Nunca va vacío: si nada encaja, siempre queda la recogida o el respaldo. */
  opciones: OpcionEnvio[];
  /** Zona que ganó, o null si se cayó al respaldo de los ajustes. */
  zona: { id: string; name: string; regions: string[] } | null;
  /** De dónde salieron las opciones: zonas configuradas o ajustes generales. */
  origen: "zonas" | "ajustes";
  /** Explicaciones para el panel (el simulador las pinta tal cual). */
  notas: string[];
  weightGrams: number | null;
};

export type ContextoEnvio = {
  zonas?: ZonaEnvio[];
  ajustes?: AjustesEnvio;
  /** Permite apagar el umbral global de envío gratis (por ejemplo, en un test). */
  aplicarEnvioGratis?: boolean;
};

/* ─────────────────────── elección de zona y tarifa ─────────────────────── */

/**
 * Cuánto de específica es una región para este destino:
 *   3 = estado exacto · 2 = país · 1 = comodín · 0 = no aplica.
 * Con esto "Ohio" gana siempre a "Estados Unidos", y "Estados Unidos" gana al
 * comodín, que es justo lo que espera cualquiera que configure zonas.
 */
function especificidadRegion(region: string, estado: string, pais: string): number {
  const r = normalizarRegion(region);
  if (!r || r === REGION_RECOGIDA) return 0;
  if (r === REGION_COMODIN) return 1;

  if (r.includes("-")) {
    const [paisRegion, estadoRegion] = r.split("-");
    if (!estadoRegion) return paisRegion === pais ? 2 : 0;
    return estadoRegion === estado && paisRegion === pais ? 3 : 0;
  }

  // Forma corta: primero se prueba como estado (ver normalizarRegion).
  if (ESTADO_POR_CODIGO.has(r) && r === estado) return 3;
  if (r === pais) return 2;
  return 0;
}

/** Especificidad de la zona = la mejor de sus regiones. */
export function especificidadZona(zona: ZonaEnvio, destino: Destino): number {
  const estado = codigoEstado(destino.state);
  const pais = String(destino.country ?? PAIS_POR_DEFECTO).trim().toUpperCase() || PAIS_POR_DEFECTO;
  let mejor = 0;
  for (const region of zona.regions) {
    const valor = especificidadRegion(region, estado, pais);
    if (valor > mejor) mejor = valor;
  }
  return mejor;
}

function esZonaRecogida(zona: ZonaEnvio): boolean {
  return zona.regions.map(normalizarRegion).includes(REGION_RECOGIDA);
}

/**
 * La zona que manda para este destino. Solo gana UNA: la más específica, y a
 * igualdad de especificidad la que Madeline puso más arriba en la lista.
 */
export function elegirZona(zonas: ZonaEnvio[], destino: Destino): ZonaEnvio | null {
  let ganadora: ZonaEnvio | null = null;
  let mejor = 0;

  for (const zona of zonas) {
    if (esZonaRecogida(zona)) continue; // la recogida se ofrece aparte, siempre
    const valor = especificidadZona(zona, destino);
    if (valor === 0) continue;
    if (valor > mejor || (valor === mejor && ganadora !== null && zona.position < ganadora.position)) {
      mejor = valor;
      ganadora = zona;
    }
  }
  return ganadora;
}

/** Tarifas de la zona cuyo tramo de subtotal incluye este subtotal. */
export function tarifasQueEncajan(zona: ZonaEnvio, subtotalCents: number): TarifaEnvio[] {
  const subtotal = Math.max(0, Math.round(subtotalCents || 0));
  return zona.rates
    .filter((t) => {
      if (subtotal < Math.max(0, t.minSubtotalCents || 0)) return false;
      const tope = Math.max(0, t.maxSubtotalCents || 0);
      // 0 en el tope significa "sin tope", no "hasta $0.00".
      if (tope > 0 && subtotal > tope) return false;
      return true;
    })
    .sort((a, b) => a.position - b.position || a.priceCents - b.priceCents || a.name.localeCompare(b.name));
}

/* ─────────────────────────── cálculo de envío ─────────────────────────── */

/**
 * El cálculo puro: mismos datos dentro, mismo resultado fuera, sin base de datos.
 * Lo usan `calculateShipping` (la caja) y el simulador del panel, para que sea
 * imposible que enseñen cosas distintas.
 */
export function resolverEnvio(
  subtotalCents: number,
  destino: Destino,
  contexto: { zonas: ZonaEnvio[]; ajustes: AjustesEnvio; aplicarEnvioGratis?: boolean },
): ResultadoEnvio {
  const subtotal = Math.max(0, Math.round(subtotalCents || 0));
  const { zonas, ajustes } = contexto;
  const aplicarGratis = contexto.aplicarEnvioGratis !== false;
  const notas: string[] = [];
  const peso = typeof destino.weightGrams === "number" && Number.isFinite(destino.weightGrams)
    ? Math.max(0, Math.round(destino.weightGrams))
    : null;

  const zonasRecogida = zonas.filter(esZonaRecogida).sort((a, b) => a.position - b.position);
  const zona = elegirZona(zonas, destino);

  let opciones: OpcionEnvio[] = [];
  let origen: ResultadoEnvio["origen"] = "zonas";

  if (zona) {
    const tarifas = tarifasQueEncajan(zona, subtotal);
    if (tarifas.length === 0) {
      // La zona existe pero ninguna tarifa cubre este subtotal. Es un agujero de
      // configuración, y callárselo dejaría a la clienta sin poder pagar.
      notas.push(
        `La zona "${zona.name}" no tiene ninguna tarifa para un subtotal de ${dolares(subtotal)}: se usan los ajustes generales.`,
      );
    } else {
      opciones = tarifas.map((t) => ({
        id: t.id,
        zoneId: zona.id,
        zoneName: zona.name,
        name: t.name,
        priceCents: Math.max(0, Math.round(t.priceCents || 0)),
        etaLabel: t.etaLabel,
        esRecogida: false,
        nota: "",
      }));
    }
  } else if (zonas.length === 0) {
    notas.push("Todavía no hay zonas configuradas: se usan los ajustes generales de la tienda.");
  } else {
    notas.push(
      `Ninguna zona cubre ese destino${destino.state ? ` (${nombreEstado(codigoEstado(destino.state)) || destino.state})` : ""}: se usan los ajustes generales.`,
    );
  }

  // Respaldo: mientras no haya zonas (o no cubran el destino) la tienda sigue
  // vendiendo con lo que ya estaba en Ajustes. Nada se rompe por estar vacío.
  if (opciones.length === 0) {
    origen = "ajustes";
    opciones = [
      {
        id: "ajustes:estandar",
        zoneId: null,
        zoneName: "Ajustes generales",
        name: "Envío estándar",
        priceCents: Math.max(0, Math.round(ajustes.flatShippingCents || 0)),
        etaLabel: ajustes.shippingNotice ?? "",
        esRecogida: false,
        nota: "",
      },
    ];
  }

  // La recogida siempre vale $0 y siempre se ofrece si está habilitada: es la
  // venta de mostrador de los jueves, viernes y sábados.
  if (zonasRecogida.length > 0) {
    for (const zr of zonasRecogida) {
      const tarifas = tarifasQueEncajan(zr, subtotal);
      const lista = tarifas.length > 0 ? tarifas : [null];
      for (const t of lista) {
        opciones.push({
          id: t ? t.id : `zona:${zr.id}`,
          zoneId: zr.id,
          zoneName: zr.name,
          name: t?.name || zr.name,
          priceCents: 0, // forzado: recoger en la tienda no puede costar dinero
          etaLabel: t?.etaLabel || "",
          esRecogida: true,
          nota: "",
        });
      }
    }
  } else if (ajustes.localPickup) {
    opciones.push({
      id: "ajustes:recogida",
      zoneId: null,
      zoneName: "Ajustes generales",
      name: "Recogida en la boutique",
      priceCents: 0,
      etaLabel: "Jueves a sábado · 1:00 – 8:00 PM",
      esRecogida: true,
      nota: "",
    });
  }

  // Umbral global de envío gratis. Se aplica a la opción de envío MÁS BARATA que
  // cueste dinero, no a todas: si Madeline ofrece un exprés de $15, regalarlo
  // también sería regalar dinero que ella no dijo de regalar.
  const umbral = Math.max(0, Math.round(ajustes.freeShippingOverCents || 0));
  if (aplicarGratis && subtotal >= umbral) {
    let indice = -1;
    for (let i = 0; i < opciones.length; i++) {
      const o = opciones[i];
      if (o.esRecogida || o.priceCents <= 0) continue;
      if (indice === -1 || o.priceCents < opciones[indice].priceCents) indice = i;
    }
    if (indice >= 0) {
      opciones[indice] = {
        ...opciones[indice],
        priceCents: 0,
        nota: umbral > 0 ? `Gratis por superar ${dolares(umbral)}` : "Envío gratis siempre",
      };
      notas.push(
        umbral > 0
          ? `Envío gratis: el subtotal (${dolares(subtotal)}) llega al umbral de ${dolares(umbral)}.`
          : "El umbral de envío gratis está en $0.00, así que el envío estándar sale siempre gratis.",
      );
    }
  }

  return {
    opciones,
    zona: zona ? { id: zona.id, name: zona.name, regions: zona.regions } : null,
    origen,
    notas,
    weightGrams: peso,
  };
}

/**
 * Punto de entrada para el checkout: elige la zona que aplica y devuelve TODAS
 * las opciones que la clienta puede elegir, no una sola.
 *
 * Si se le pasa `contexto` con zonas y ajustes ya cargados, no toca la base de
 * datos (así lo usan los tests y el simulador del panel).
 */
export async function calculateShipping(
  subtotalCents: number,
  destino: Destino = {},
  contexto: ContextoEnvio = {},
): Promise<ResultadoEnvio> {
  const zonas = contexto.zonas ?? (await cargarZonas());
  const ajustes = contexto.ajustes ?? (await cargarAjustesEnvio());
  return resolverEnvio(subtotalCents, destino, {
    zonas,
    ajustes,
    aplicarEnvioGratis: contexto.aplicarEnvioGratis,
  });
}

/** Zonas con sus tarifas, ya ordenadas y con el JSON de regiones parseado. */
export async function cargarZonas(): Promise<ZonaEnvio[]> {
  const { db } = await import("@/lib/db");
  const filas = await db.shippingZone.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    include: { rates: { orderBy: [{ position: "asc" }, { priceCents: "asc" }] } },
  });

  return filas.map((z) => ({
    id: z.id,
    name: z.name,
    regions: parsearRegiones(z.regionsJson),
    position: z.position,
    rates: z.rates.map((t) => ({
      id: t.id,
      name: t.name,
      priceCents: t.priceCents,
      minSubtotalCents: t.minSubtotalCents,
      maxSubtotalCents: t.maxSubtotalCents,
      etaLabel: t.etaLabel,
      position: t.position,
    })),
  }));
}

/** `regionsJson` es un string con JSON dentro; si viniera roto, no reventamos. */
export function parsearRegiones(json: string | null | undefined): string[] {
  try {
    const bruto: unknown = JSON.parse(String(json ?? "[]"));
    if (!Array.isArray(bruto)) return [];
    return bruto
      .filter((x): x is string => typeof x === "string")
      .map(normalizarRegion)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Solo la parte de los ajustes generales que afecta al envío. */
export async function cargarAjustesEnvio(): Promise<AjustesEnvio> {
  const { getSettings } = await import("@/lib/settings");
  const s = await getSettings();
  return {
    freeShippingOverCents: s.freeShippingOverCents,
    flatShippingCents: s.flatShippingCents,
    localPickup: s.localPickup,
    shippingNotice: s.shippingNotice,
  };
}

/* ──────────────────────────── impuestos ──────────────────────────── */

/**
 * Configuración de impuestos.
 *
 * El tipo se guarda en PUNTOS BÁSICOS enteros (bps): 7,8 % = 780 bps. Igual que
 * el dinero, nunca en float — un 0.078 arrastra error y acaba dando un centavo
 * de más o de menos en la mitad de los pedidos.
 *
 * Por defecto está APAGADO y a 0. Hamilton está en el condado de Butler, Ohio,
 * que suma su propio recargo al tipo estatal, y ese número NO se inventa aquí:
 * lo confirma la contable de Madeline antes de activar nada.
 */
export type ConfigImpuestos = {
  activo: boolean;
  /** Puntos básicos. 780 = 7,80 %. */
  rateBps: number;
  /** Cómo se llama la línea en el recibo. */
  etiqueta: string;
  /** Estados donde se cobra (forma canónica "US-OH"). Vacío = ninguno. */
  estados: string[];
  /** Quién y cuándo confirmó el tipo. Vacío mientras nadie lo haya confirmado. */
  confirmadoPor: string;
};

export const IMPUESTOS_POR_DEFECTO: ConfigImpuestos = {
  activo: false,
  rateBps: 0,
  etiqueta: "Impuesto sobre ventas",
  estados: ["US-OH"],
  confirmadoPor: "",
};

/** Claves propias en la tabla Setting. Prefijadas para no chocar con nadie. */
const CLAVES_IMPUESTO = {
  activo: "tax.enabled",
  rateBps: "tax.rateBps",
  etiqueta: "tax.label",
  estados: "tax.states",
  confirmadoPor: "tax.confirmedBy",
} as const;

export async function getTaxConfig(): Promise<ConfigImpuestos> {
  const { db } = await import("@/lib/db");
  const filas = await db.setting.findMany({ where: { key: { in: Object.values(CLAVES_IMPUESTO) } } });
  const mapa = new Map(filas.map((f) => [f.key, f.value]));

  const leer = <T>(clave: string, porDefecto: T): T => {
    const bruto = mapa.get(clave);
    if (bruto === undefined) return porDefecto;
    try {
      return JSON.parse(bruto) as T;
    } catch {
      return porDefecto;
    }
  };

  const estados = leer<string[]>(CLAVES_IMPUESTO.estados, IMPUESTOS_POR_DEFECTO.estados);

  return {
    activo: leer(CLAVES_IMPUESTO.activo, IMPUESTOS_POR_DEFECTO.activo) === true,
    rateBps: Math.max(0, Math.round(Number(leer(CLAVES_IMPUESTO.rateBps, IMPUESTOS_POR_DEFECTO.rateBps)) || 0)),
    etiqueta: String(leer(CLAVES_IMPUESTO.etiqueta, IMPUESTOS_POR_DEFECTO.etiqueta) || IMPUESTOS_POR_DEFECTO.etiqueta),
    estados: Array.isArray(estados) ? estados.map(normalizarRegion).filter(Boolean) : [],
    confirmadoPor: String(leer(CLAVES_IMPUESTO.confirmadoPor, "") || ""),
  };
}

export async function saveTaxConfig(patch: Partial<ConfigImpuestos>): Promise<void> {
  const { db } = await import("@/lib/db");
  const entradas: [string, unknown][] = [];
  if (patch.activo !== undefined) entradas.push([CLAVES_IMPUESTO.activo, patch.activo]);
  if (patch.rateBps !== undefined) entradas.push([CLAVES_IMPUESTO.rateBps, Math.max(0, Math.round(patch.rateBps))]);
  if (patch.etiqueta !== undefined) entradas.push([CLAVES_IMPUESTO.etiqueta, patch.etiqueta]);
  if (patch.estados !== undefined) entradas.push([CLAVES_IMPUESTO.estados, patch.estados.map(normalizarRegion).filter(Boolean)]);
  if (patch.confirmadoPor !== undefined) entradas.push([CLAVES_IMPUESTO.confirmadoPor, patch.confirmadoPor]);

  for (const [key, valor] of entradas) {
    const value = JSON.stringify(valor);
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

export type ResultadoImpuesto = {
  taxCents: number;
  rateBps: number;
  etiqueta: string;
  /** false = no se cobró nada, y `nota` dice por qué. */
  aplicado: boolean;
  nota: string;
};

/**
 * Impuesto sobre la base imponible que se le pase. Devuelve 0 —y explica por
 * qué— mientras nadie haya confirmado y activado un tipo: la tienda prefiere no
 * cobrar impuesto a cobrarlo mal.
 *
 * Ojo: grava EXACTAMENTE lo que se le pasa. Si la contable confirma que en Ohio
 * el envío también tributa, hay que pasar `subtotal + envío`, no solo subtotal.
 */
export async function calculateTax(
  subtotalCents: number,
  destino: Destino = {},
  config?: ConfigImpuestos,
): Promise<ResultadoImpuesto> {
  const cfg = config ?? (await getTaxConfig());
  return resolverImpuesto(subtotalCents, destino, cfg);
}

/** Versión pura de `calculateTax`, para el simulador y los tests. */
export function resolverImpuesto(
  subtotalCents: number,
  destino: Destino,
  cfg: ConfigImpuestos,
): ResultadoImpuesto {
  const base = Math.max(0, Math.round(subtotalCents || 0));
  const vacio = (nota: string): ResultadoImpuesto => ({
    taxCents: 0,
    rateBps: cfg.rateBps,
    etiqueta: cfg.etiqueta,
    aplicado: false,
    nota,
  });

  if (!cfg.activo) {
    return vacio("No se está cobrando impuesto: el cobro está desactivado en Envíos e impuestos.");
  }
  if (cfg.rateBps <= 0) {
    return vacio("No se está cobrando impuesto: falta escribir el tipo confirmado por la contable.");
  }

  const estado = codigoEstado(destino.state);
  const pais = String(destino.country ?? PAIS_POR_DEFECTO).trim().toUpperCase() || PAIS_POR_DEFECTO;
  const aplica = cfg.estados.some((region) => especificidadRegion(region, estado, pais) > 0);
  if (!aplica) {
    return vacio(
      estado
        ? `No se cobra impuesto para ${nombreEstado(estado)}: no está en la lista de estados con impuesto.`
        : "No se cobra impuesto: falta el estado del destino.",
    );
  }

  return {
    // Redondeo al centavo entero, una sola vez y al final.
    taxCents: Math.round((base * cfg.rateBps) / 10_000),
    rateBps: cfg.rateBps,
    etiqueta: cfg.etiqueta,
    aplicado: true,
    nota: `${cfg.etiqueta} ${formatearTipo(cfg.rateBps)} sobre ${dolares(base)}.`,
  };
}

/** 780 → "7.80 %". Los bps nunca se enseñan crudos a Madeline. */
export function formatearTipo(bps: number): string {
  const seguro = Math.max(0, Math.round(bps || 0));
  return `${(seguro / 100).toFixed(2)} %`;
}

/** "7.8", "7,8 %", "7.8%" → 780 bps. null si no hay número dentro. */
export function tipoAPuntosBasicos(entrada: string | number | null | undefined): number | null {
  if (entrada === null || entrada === undefined) return null;
  if (typeof entrada === "number") {
    return Number.isFinite(entrada) ? Math.round(entrada * 100) : null;
  }
  const limpio = entrada.replace(/[^\d.,-]/g, "").replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  if (!limpio || limpio === "." || limpio === "-") return null;
  const valor = Number.parseFloat(limpio);
  if (!Number.isFinite(valor)) return null;
  return Math.round(valor * 100);
}

/* ─────────────────────────── configuración inicial ─────────────────────────── */

/**
 * Punto de partida razonable para esta boutique concreta: Ohio (su estado),
 * Estados Unidos (su Instagram dice que envía a todo el país) y recogida en el
 * mostrador. Los importes NO se inventan: salen de los ajustes que ya existen.
 */
export function plantillaZonasIniciales(ajustes: AjustesEnvio): Array<{
  name: string;
  regions: string[];
  rates: Array<Omit<TarifaEnvio, "id">>;
}> {
  const plano = Math.max(0, Math.round(ajustes.flatShippingCents || 0));
  const umbral = Math.max(0, Math.round(ajustes.freeShippingOverCents || 0));

  const tarifasEnvio = (etiquetaPlazo: string): Array<Omit<TarifaEnvio, "id">> => {
    const lista: Array<Omit<TarifaEnvio, "id">> = [
      {
        name: "Envío estándar",
        priceCents: plano,
        minSubtotalCents: 0,
        // Si hay umbral de envío gratis, la tarifa de pago llega justo hasta él.
        maxSubtotalCents: umbral > 0 ? Math.max(0, umbral - 1) : 0,
        etaLabel: etiquetaPlazo,
        position: 0,
      },
    ];
    if (umbral > 0) {
      lista.push({
        name: "Envío gratis",
        priceCents: 0,
        minSubtotalCents: umbral,
        maxSubtotalCents: 0,
        etaLabel: etiquetaPlazo,
        position: 1,
      });
    }
    return lista;
  };

  const zonas = [
    { name: "Ohio", regions: ["US-OH"], rates: tarifasEnvio("2 a 4 días hábiles") },
    { name: "Estados Unidos", regions: ["US"], rates: tarifasEnvio("3 a 7 días hábiles") },
  ];

  if (ajustes.localPickup) {
    zonas.push({
      name: "Recogida en la boutique",
      regions: [REGION_RECOGIDA],
      rates: [
        {
          name: "Recogida en la boutique",
          priceCents: 0,
          minSubtotalCents: 0,
          maxSubtotalCents: 0,
          etaLabel: "Jueves a sábado · 1:00 – 8:00 PM",
          position: 0,
        },
      ],
    });
  }

  return zonas;
}

/* ─────────────────────────── utilidades ─────────────────────────── */

/**
 * Dinero dentro de una frase ("Gratis por superar $75.00"). Pasa por
 * formatCents, que es la única función autorizada a convertir centavos a texto;
 * el panel sigue pintando importes sueltos con <Money/>.
 */
function dolares(cents: number): string {
  return formatCents(Math.max(0, Math.round(cents || 0)));
}
