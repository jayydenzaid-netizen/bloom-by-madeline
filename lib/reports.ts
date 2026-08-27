import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";

/**
 * Informes y analítica de la tienda.
 *
 * Reglas de la casa que se aplican aquí sin excepción:
 *
 *  1. **Solo cuenta lo cobrado.** Todas las consultas filtran por
 *     `paymentStatus = "paid"`. Un pedido pendiente todavía no es dinero, y un
 *     informe que lo sume convierte una previsión en un ingreso imaginario.
 *  2. **Cero números inventados.** Si no hay datos se devuelve una lista vacía o
 *     `null`, nunca un cero maquillado ni una media sacada de la nada.
 *  3. **Si falta el coste, se dice.** El margen se calcula solo sobre las líneas
 *     que tienen `costCents`, y siempre se informa de cuántas no lo tienen. Un
 *     margen del 100 % porque el coste está vacío es peor que no dar margen.
 *  4. **Todo el dinero en centavos enteros**, formateado únicamente con
 *     `formatCents()`.
 *
 * ¿Por qué se agrupa por día en JavaScript y no con SQL?
 * SQLite guarda las fechas en UTC. Un `GROUP BY date(createdAt)` partiría los
 * días por medianoche de Londres, así que una venta del jueves a las 8 de la
 * tarde en Hamilton (Ohio) aparecería el viernes. Agrupar en JS usa la zona
 * horaria del servidor, que es la de la boutique, y el volumen de una tienda de
 * barrio no justifica optimizar nada más.
 */

/* ═══════════════════════════ Rango de fechas ═══════════════════════════ */

export type Rango = {
  /** Instante inicial, **incluido**. */
  desde: Date;
  /** Instante final, **excluido**. Siempre es una medianoche local. */
  hasta: Date;
};

/** Atajos del selector. El orden es el que se pinta en pantalla. */
export const ATAJOS = [
  { key: "hoy", label: "Hoy" },
  { key: "7d", label: "7 días" },
  { key: "30d", label: "30 días" },
  { key: "mes", label: "Este mes" },
  { key: "mes-pasado", label: "Mes pasado" },
  { key: "ano", label: "Este año" },
] as const;

export type AtajoKey = (typeof ATAJOS)[number]["key"];
export type RangoKey = AtajoKey | "personalizado";

/** Techo de seguridad del rango personalizado: dos años de días en una gráfica ya es ilegible. */
const MAX_DIAS = 731;

export function inicioDelDia(fecha: Date): Date {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function sumarDias(fecha: Date, dias: number): Date {
  const d = new Date(fecha);
  d.setDate(d.getDate() + dias);
  return d;
}

/** Fecha local -> "2026-08-19". Es la clave con la que se agrupan los días. */
export function claveDia(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * "2026-08-19" -> Date a medianoche **local**.
 * `new Date("2026-08-19")` lo interpretaría como UTC y en Ohio devolvería el 18
 * a las 8 de la tarde: de ahí el desglose a mano.
 */
export function diaDesdeClave(valor: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
  if (!m) return null;
  const [, y, mes, dia] = m;
  const d = new Date(Number(y), Number(mes) - 1, Number(dia));
  // Rechaza fechas imposibles ("2026-02-31" rebosaría a marzo sin avisar).
  if (d.getFullYear() !== Number(y) || d.getMonth() !== Number(mes) - 1 || d.getDate() !== Number(dia)) {
    return null;
  }
  return d;
}

/**
 * Rango de un atajo. `hoy` se puede inyectar para poder probarlo.
 * "Este mes" y "este año" se cortan en mañana: si llegaran a fin de mes, la
 * gráfica arrastraría una cola plana de días que aún no han pasado.
 */
export function rangoDeAtajo(key: AtajoKey, hoy: Date = new Date()): Rango {
  const dia0 = inicioDelDia(hoy);
  const manana = sumarDias(dia0, 1);

  switch (key) {
    case "hoy":
      return { desde: dia0, hasta: manana };
    case "7d":
      return { desde: sumarDias(dia0, -6), hasta: manana };
    case "30d":
      return { desde: sumarDias(dia0, -29), hasta: manana };
    case "mes":
      return { desde: new Date(dia0.getFullYear(), dia0.getMonth(), 1), hasta: manana };
    case "mes-pasado": {
      const inicio = new Date(dia0.getFullYear(), dia0.getMonth() - 1, 1);
      const fin = new Date(dia0.getFullYear(), dia0.getMonth(), 1);
      return { desde: inicio, hasta: fin };
    }
    case "ano":
      return { desde: new Date(dia0.getFullYear(), 0, 1), hasta: manana };
  }
}

/** Periodo inmediatamente anterior, de la misma duración exacta. */
export function rangoAnterior(rango: Rango): Rango {
  const duracion = rango.hasta.getTime() - rango.desde.getTime();
  return { desde: new Date(rango.desde.getTime() - duracion), hasta: new Date(rango.desde.getTime()) };
}

/** Días naturales que abarca el rango (mínimo 1). */
export function diasDelRango(rango: Rango): number {
  let n = 0;
  for (let d = inicioDelDia(rango.desde); d < rango.hasta; d = sumarDias(d, 1)) n++;
  return Math.max(1, n);
}

const FMT_DIA_MES = new Intl.DateTimeFormat("es-US", { day: "numeric", month: "short" });
const FMT_COMPLETA = new Intl.DateTimeFormat("es-US", { day: "numeric", month: "long", year: "numeric" });
const FMT_DIA_SEMANA = new Intl.DateTimeFormat("es-US", { weekday: "long", day: "numeric", month: "long" });

/** "1 de agosto de 2026 – 19 de agosto de 2026" (o un solo día si el rango es de uno). */
export function etiquetaRango(rango: Rango): string {
  const primer = inicioDelDia(rango.desde);
  // `hasta` es exclusivo: el último día visible es el anterior a esa medianoche.
  const ultimo = inicioDelDia(new Date(rango.hasta.getTime() - 1));
  if (claveDia(primer) === claveDia(ultimo)) return FMT_COMPLETA.format(primer);
  return `${FMT_COMPLETA.format(primer)} – ${FMT_COMPLETA.format(ultimo)}`;
}

export function etiquetaDiaCorta(fecha: Date): string {
  return FMT_DIA_MES.format(fecha);
}

export function etiquetaDiaLarga(fecha: Date): string {
  return FMT_DIA_SEMANA.format(fecha);
}

/**
 * Traduce los parámetros de la URL a un rango real.
 * El rango viaja siempre en la URL para que Madeline pueda guardarse el enlace
 * de "el mes pasado" o mandárselo a quien le lleva las cuentas.
 */
export function resolverRango(
  params: { rango?: string; desde?: string; hasta?: string },
  hoy: Date = new Date(),
): { key: RangoKey; rango: Rango } {
  const desde = params.desde ? diaDesdeClave(params.desde) : null;
  const hasta = params.hasta ? diaDesdeClave(params.hasta) : null;

  if (desde && hasta) {
    // Si vienen del revés se intercambian en vez de devolver un informe vacío:
    // es un error de dedo, no una consulta legítima.
    let a = desde <= hasta ? desde : hasta;
    const b = desde <= hasta ? hasta : desde;
    // Si el rango se pasa del techo se recorta por el principio, no por el final:
    // quien pide "desde 2020 hasta hoy" quiere ver sus ventas, y quedarse con
    // los dos años MÁS VIEJOS le devolvería una pantalla vacía.
    if (b.getTime() - a.getTime() > MAX_DIAS * 86_400_000) a = sumarDias(b, -(MAX_DIAS - 1));
    // `hasta` en la URL es un día incluido; internamente el rango lo excluye.
    return { key: "personalizado", rango: { desde: a, hasta: sumarDias(b, 1) } };
  }

  const atajo = ATAJOS.find((a) => a.key === params.rango)?.key ?? "30d";
  return { key: atajo, rango: rangoDeAtajo(atajo, hoy) };
}

/* ═══════════════════════════ Filtro común ═══════════════════════════ */

/**
 * Un pedido cuenta en el día en que se **cobró** (`paidAt`). Si el pedido está
 * pagado pero nadie apuntó cuándo — pasa con las ventas de mostrador que se
 * registran a mano — se usa la fecha de creación como mejor aproximación.
 */
export function fechaDeVenta(pedido: { paidAt: Date | null; createdAt: Date }): Date {
  return pedido.paidAt ?? pedido.createdAt;
}

function whereVentas(rango: Rango): Prisma.OrderWhereInput {
  return {
    paymentStatus: "paid",
    OR: [
      { paidAt: { gte: rango.desde, lt: rango.hasta } },
      { AND: [{ paidAt: null }, { createdAt: { gte: rango.desde, lt: rango.hasta } }] },
    ],
  };
}

/** ¿Ha cobrado la tienda algo alguna vez? Decide si la pantalla enseña informe o tutorial. */
export async function hayVentasAlgunaVez(): Promise<boolean> {
  return (await db.order.count({ where: { paymentStatus: "paid" } })) > 0;
}

/* ═══════════════════════════ Ventas por día ═══════════════════════════ */

export type PuntoDia = {
  /** "2026-08-19" */
  dia: string;
  fecha: Date;
  ingresosCents: number;
  pedidos: number;
};

/**
 * Serie diaria completa: los días sin ventas salen con 0, no se saltan. Una
 * gráfica que une el lunes con el jueves miente sobre la forma de la semana.
 */
export async function salesByDay(desde: Date, hasta: Date): Promise<PuntoDia[]> {
  const rango: Rango = { desde, hasta };
  const pedidos = await db.order.findMany({
    where: whereVentas(rango),
    select: { totalCents: true, paidAt: true, createdAt: true },
  });

  const acumulado = new Map<string, { ingresosCents: number; pedidos: number }>();
  for (const p of pedidos) {
    const clave = claveDia(fechaDeVenta(p));
    const actual = acumulado.get(clave) ?? { ingresosCents: 0, pedidos: 0 };
    actual.ingresosCents += p.totalCents;
    actual.pedidos += 1;
    acumulado.set(clave, actual);
  }

  const serie: PuntoDia[] = [];
  for (let d = inicioDelDia(desde); d < hasta; d = sumarDias(d, 1)) {
    const clave = claveDia(d);
    const dato = acumulado.get(clave);
    serie.push({
      dia: clave,
      fecha: new Date(d),
      ingresosCents: dato?.ingresosCents ?? 0,
      pedidos: dato?.pedidos ?? 0,
    });
  }
  return serie;
}

/* ═══════════════════════════ Resumen ═══════════════════════════ */

export type MetricasBase = {
  /** Total cobrado, envío incluido. Es el dinero que entró de verdad. */
  ingresosCents: number;
  pedidos: number;
  /** Ingresos / pedidos. `null` si no hubo ni un pedido: dividir entre 0 no es 0. */
  ticketMedioCents: number | null;
  unidades: number;
};

export type Variacion = {
  /** Porcentaje con un decimal. `null` cuando no se puede calcular. */
  pct: number | null;
  direccion: "sube" | "baja" | "igual" | "nuevo";
};

export type Resumen = {
  actual: MetricasBase;
  anterior: MetricasBase;
  variacion: {
    ingresos: Variacion;
    pedidos: Variacion;
    ticketMedio: Variacion;
    unidades: Variacion;
  };
  rango: Rango;
  rangoPrevio: Rango;
};

/**
 * Comparación entre dos periodos.
 * Cuando el periodo anterior fue 0 **no se inventa un +100 %**: se marca como
 * "nuevo", que es lo que de verdad pasó (antes no había nada con lo que comparar).
 */
function variacion(actual: number | null, anterior: number | null): Variacion {
  const a = actual ?? 0;
  const b = anterior ?? 0;
  if (a === 0 && b === 0) return { pct: 0, direccion: "igual" };
  if (b === 0) return { pct: null, direccion: "nuevo" };
  const pct = Math.round(((a - b) / b) * 1000) / 10;
  return { pct, direccion: pct > 0 ? "sube" : pct < 0 ? "baja" : "igual" };
}

async function metricasDe(rango: Rango): Promise<MetricasBase> {
  const where = whereVentas(rango);
  const [agregado, unidades] = await Promise.all([
    db.order.aggregate({ where, _sum: { totalCents: true }, _count: { _all: true } }),
    db.orderItem.aggregate({ where: { order: where }, _sum: { quantity: true } }),
  ]);

  const ingresosCents = agregado._sum.totalCents ?? 0;
  const pedidos = agregado._count._all;

  return {
    ingresosCents,
    pedidos,
    ticketMedioCents: pedidos > 0 ? Math.round(ingresosCents / pedidos) : null,
    unidades: unidades._sum.quantity ?? 0,
  };
}

export async function summary(desde: Date, hasta: Date): Promise<Resumen> {
  const rango: Rango = { desde, hasta };
  const previo = rangoAnterior(rango);

  const [actual, anterior] = await Promise.all([metricasDe(rango), metricasDe(previo)]);

  return {
    actual,
    anterior,
    variacion: {
      ingresos: variacion(actual.ingresosCents, anterior.ingresosCents),
      pedidos: variacion(actual.pedidos, anterior.pedidos),
      ticketMedio: variacion(actual.ticketMedioCents, anterior.ticketMedioCents),
      unidades: variacion(actual.unidades, anterior.unidades),
    },
    rango,
    rangoPrevio: previo,
  };
}

/* ═══════════════════════════ Productos ═══════════════════════════ */

export type ProductoTop = {
  /** `null` si el producto se borró del catálogo: la línea del pedido sobrevive igual. */
  productId: string | null;
  titulo: string;
  imagenUrl: string | null;
  unidades: number;
  /** Precio × cantidad de las líneas. No incluye envío. */
  ingresosCents: number;
  /** Coste solo de las líneas que lo tienen. */
  costeCents: number;
  /** Ingresos de esas mismas líneas, para que el margen compare peras con peras. */
  ingresosConCosteCents: number;
  lineasSinCoste: number;
  /** `null` cuando ninguna línea trae coste: sin dato no hay margen. */
  margenPct: number | null;
};

type LineaVendida = {
  productId: string | null;
  title: string;
  imageUrl: string | null;
  priceCents: number;
  costCents: number | null;
  quantity: number;
};

async function lineasVendidas(rango: Rango): Promise<LineaVendida[]> {
  return db.orderItem.findMany({
    where: { order: whereVentas(rango) },
    select: { productId: true, title: true, imageUrl: true, priceCents: true, costCents: true, quantity: true },
  });
}

function margenPct(ingresosCents: number, costeCents: number, lineasConCoste: number): number | null {
  if (lineasConCoste === 0 || ingresosCents <= 0) return null;
  return Math.round(((ingresosCents - costeCents) / ingresosCents) * 1000) / 10;
}

/**
 * Más vendidos, en las dos lecturas que importan: **por unidades** (lo que más
 * sale por la puerta) y **por ingresos** (lo que más dinero deja). No siempre
 * son el mismo producto, y confundirlos lleva a reponer lo que no toca.
 */
export async function topProducts(
  desde: Date,
  hasta: Date,
  limite = 10,
): Promise<{ porUnidades: ProductoTop[]; porIngresos: ProductoTop[] }> {
  const lineas = await lineasVendidas({ desde, hasta });

  type Acumulado = ProductoTop & { lineasConCoste: number };
  const mapa = new Map<string, Acumulado>();

  for (const l of lineas) {
    // Si el producto ya no existe se agrupa por título congelado: es lo único
    // que queda del artículo, y sigue siendo información útil.
    const clave = l.productId ?? `titulo:${l.title}`;
    const item =
      mapa.get(clave) ??
      ({
        productId: l.productId,
        titulo: l.title,
        imagenUrl: null,
        unidades: 0,
        ingresosCents: 0,
        costeCents: 0,
        ingresosConCosteCents: 0,
        lineasSinCoste: 0,
        margenPct: null,
        lineasConCoste: 0,
      } satisfies Acumulado);

    const ingresoLinea = l.priceCents * l.quantity;
    item.unidades += l.quantity;
    item.ingresosCents += ingresoLinea;
    if (l.imageUrl && !item.imagenUrl) item.imagenUrl = l.imageUrl;

    if (l.costCents === null || l.costCents === undefined) {
      item.lineasSinCoste += 1;
    } else {
      item.lineasConCoste += 1;
      item.costeCents += l.costCents * l.quantity;
      item.ingresosConCosteCents += ingresoLinea;
    }

    mapa.set(clave, item);
  }

  const todos: ProductoTop[] = [...mapa.values()].map((item) => ({
    productId: item.productId,
    titulo: item.titulo,
    imagenUrl: item.imagenUrl,
    unidades: item.unidades,
    ingresosCents: item.ingresosCents,
    costeCents: item.costeCents,
    ingresosConCosteCents: item.ingresosConCosteCents,
    lineasSinCoste: item.lineasSinCoste,
    margenPct: margenPct(item.ingresosConCosteCents, item.costeCents, item.lineasConCoste),
  }));

  const porUnidades = [...todos]
    .sort((a, b) => b.unidades - a.unidades || b.ingresosCents - a.ingresosCents)
    .slice(0, limite);
  const porIngresos = [...todos]
    .sort((a, b) => b.ingresosCents - a.ingresosCents || b.unidades - a.unidades)
    .slice(0, limite);

  return { porUnidades, porIngresos };
}

/* ═══════════════════════════ Beneficio ═══════════════════════════ */

export type InformeBeneficio = {
  /** Venta de producto (precio × cantidad). El envío queda fuera a propósito. */
  ingresosCents: number;
  costeCents: number;
  beneficioCents: number | null;
  margenPct: number | null;
  lineasTotales: number;
  lineasConCoste: number;
  lineasSinCoste: number;
  unidadesSinCoste: number;
  /** Ingresos de las líneas con coste: la base real del margen. */
  ingresosConCosteCents: number;
  /** `false` en cuanto falta un solo coste. La pantalla debe avisarlo. */
  fiable: boolean;
};

/**
 * Beneficio bruto = venta de producto − coste del producto.
 *
 * El envío cobrado no entra: no es margen, es un gasto que se repercute. Y el
 * margen se calcula **solo sobre las líneas que tienen coste**; las que no lo
 * tienen se cuentan aparte para que quede claro que el número está incompleto,
 * en vez de enseñar un 100 % que solo significa "no rellené el coste".
 */
export async function profitReport(desde: Date, hasta: Date): Promise<InformeBeneficio> {
  const lineas = await lineasVendidas({ desde, hasta });

  let ingresosCents = 0;
  let costeCents = 0;
  let ingresosConCosteCents = 0;
  let lineasConCoste = 0;
  let lineasSinCoste = 0;
  let unidadesSinCoste = 0;

  for (const l of lineas) {
    const ingresoLinea = l.priceCents * l.quantity;
    ingresosCents += ingresoLinea;
    if (l.costCents === null || l.costCents === undefined) {
      lineasSinCoste += 1;
      unidadesSinCoste += l.quantity;
    } else {
      lineasConCoste += 1;
      costeCents += l.costCents * l.quantity;
      ingresosConCosteCents += ingresoLinea;
    }
  }

  return {
    ingresosCents,
    costeCents,
    beneficioCents: lineasConCoste > 0 ? ingresosConCosteCents - costeCents : null,
    margenPct: margenPct(ingresosConCosteCents, costeCents, lineasConCoste),
    lineasTotales: lineas.length,
    lineasConCoste,
    lineasSinCoste,
    unidadesSinCoste,
    ingresosConCosteCents,
    fiable: lineas.length > 0 && lineasSinCoste === 0,
  };
}

/* ═══════════════════════════ Reparto ═══════════════════════════ */

export type Reparto = {
  clave: string;
  etiqueta: string;
  ingresosCents: number;
  pedidos: number;
  /** Porcentaje sobre el total del rango, con un decimal. */
  pct: number;
};

const CANALES: Record<string, string> = {
  online: "Tienda web",
  pos: "Mostrador de la boutique",
};

const METODOS: Record<string, string> = {
  stripe: "Tarjeta",
  dm: "DM de Instagram",
  pickup: "Recogida en tienda",
  cash: "Efectivo",
};

async function reparto(
  rango: Rango,
  campo: "channel" | "paymentMethod",
  etiquetas: Record<string, string>,
  clavesFijas: string[],
): Promise<Reparto[]> {
  const where = whereVentas(rango);
  const filas =
    campo === "channel"
      ? await db.order.groupBy({ by: ["channel"], where, _sum: { totalCents: true }, _count: { _all: true } })
      : await db.order.groupBy({ by: ["paymentMethod"], where, _sum: { totalCents: true }, _count: { _all: true } });

  const crudas = filas.map((f) => ({
    clave: campo === "channel" ? (f as { channel: string }).channel : (f as { paymentMethod: string }).paymentMethod,
    ingresosCents: f._sum.totalCents ?? 0,
    pedidos: f._count._all,
  }));

  const total = crudas.reduce((acc, f) => acc + f.ingresosCents, 0);
  if (total === 0 && crudas.length === 0) return [];

  const porClave = new Map(crudas.map((f) => [f.clave, f]));
  // Las claves fijas se pintan aunque estén a cero: saber que por el mostrador
  // no entró nada es información, no un hueco.
  const claves = [...new Set([...clavesFijas, ...porClave.keys()])];

  return claves
    .map((clave) => {
      const f = porClave.get(clave);
      const ingresosCents = f?.ingresosCents ?? 0;
      return {
        clave,
        etiqueta: etiquetas[clave] ?? clave,
        ingresosCents,
        pedidos: f?.pedidos ?? 0,
        pct: total > 0 ? Math.round((ingresosCents / total) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.ingresosCents - a.ingresosCents);
}

/** Cuánto entra por la web y cuánto por el mostrador. */
export function salesByChannel(desde: Date, hasta: Date): Promise<Reparto[]> {
  return reparto({ desde, hasta }, "channel", CANALES, ["online", "pos"]);
}

/** Reparto por forma de pago. Solo se listan las que tuvieron movimiento. */
export function byPaymentMethod(desde: Date, hasta: Date): Promise<Reparto[]> {
  return reparto({ desde, hasta }, "paymentMethod", METODOS, []);
}

/* ═══════════════════════════ Clientas ═══════════════════════════ */

export type ClientaTop = {
  customerId: string | null;
  nombre: string;
  email: string;
  pedidos: number;
  gastadoCents: number;
  esNueva: boolean;
};

export type EstadisticasClientas = {
  /** Personas distintas que compraron en el rango (solo las identificables). */
  compradoras: number;
  nuevas: number;
  recurrentes: number;
  ingresosNuevasCents: number;
  ingresosRecurrentesCents: number;
  /**
   * Ventas de mostrador sin correo. No son "una clienta": son varias personas
   * anónimas, y meterlas en el mismo saco inventaría una compradora fantasma
   * con el gasto de todo el barrio.
   */
  pedidosSinCorreo: number;
  ingresosSinCorreoCents: number;
  top: ClientaTop[];
};

/**
 * Nuevas frente a recurrentes.
 *
 * "Nueva" = su primera compra pagada de toda la historia de la tienda cae dentro
 * del rango. Se comprueba buscando si esa dirección de correo ya había comprado
 * **antes** del rango; agrupar por correo y no por `customerId` es a propósito:
 * una misma persona puede haber comprado como invitada y luego con cuenta.
 *
 * Los pedidos **sin correo** (las ventas de mostrador que se cobran y ya) se
 * apartan y se cuentan solo como total: no se puede saber si quien pagó en
 * efectivo el jueves es la misma que volvió el sábado.
 */
export async function customerStats(desde: Date, hasta: Date, limite = 8): Promise<EstadisticasClientas> {
  const rango: Rango = { desde, hasta };

  const pedidos = await db.order.findMany({
    where: whereVentas(rango),
    select: { email: true, name: true, customerId: true, totalCents: true },
  });

  // Mostrador sin correo: se cuentan aparte, nunca como una compradora más.
  const anonimos = pedidos.filter((p) => p.email.trim() === "");
  const identificados = pedidos.filter((p) => p.email.trim() !== "");
  const pedidosSinCorreo = anonimos.length;
  const ingresosSinCorreoCents = anonimos.reduce((acc, p) => acc + p.totalCents, 0);

  if (identificados.length === 0) {
    return {
      compradoras: 0,
      nuevas: 0,
      recurrentes: 0,
      ingresosNuevasCents: 0,
      ingresosRecurrentesCents: 0,
      pedidosSinCorreo,
      ingresosSinCorreoCents,
      top: [],
    };
  }

  type Acumulado = { nombre: string; email: string; customerId: string | null; pedidos: number; gastadoCents: number };
  const porEmail = new Map<string, Acumulado>();
  for (const p of identificados) {
    const email = p.email.trim().toLowerCase();
    const item = porEmail.get(email) ?? {
      nombre: p.name || "—",
      email,
      customerId: p.customerId,
      pedidos: 0,
      gastadoCents: 0,
    };
    item.pedidos += 1;
    item.gastadoCents += p.totalCents;
    if (!item.customerId && p.customerId) item.customerId = p.customerId;
    if (item.nombre === "—" && p.name) item.nombre = p.name;
    porEmail.set(email, item);
  }

  // Una sola consulta acotada a los correos implicados: nada de traerse el
  // histórico entero de la tienda para responder "¿ya había comprado antes?".
  const previos = await db.order.findMany({
    where: {
      paymentStatus: "paid",
      email: { in: [...porEmail.keys()] },
      OR: [{ paidAt: { lt: rango.desde } }, { AND: [{ paidAt: null }, { createdAt: { lt: rango.desde } }] }],
    },
    select: { email: true },
  });
  const yaCompraban = new Set(previos.map((p) => p.email.trim().toLowerCase()));

  let nuevas = 0;
  let recurrentes = 0;
  let ingresosNuevasCents = 0;
  let ingresosRecurrentesCents = 0;

  const lista: ClientaTop[] = [];
  for (const [email, item] of porEmail) {
    const esNueva = !yaCompraban.has(email);
    if (esNueva) {
      nuevas += 1;
      ingresosNuevasCents += item.gastadoCents;
    } else {
      recurrentes += 1;
      ingresosRecurrentesCents += item.gastadoCents;
    }
    lista.push({
      customerId: item.customerId,
      nombre: item.nombre,
      email: item.email,
      pedidos: item.pedidos,
      gastadoCents: item.gastadoCents,
      esNueva,
    });
  }

  return {
    compradoras: porEmail.size,
    nuevas,
    recurrentes,
    ingresosNuevasCents,
    ingresosRecurrentesCents,
    pedidosSinCorreo,
    ingresosSinCorreoCents,
    top: lista.sort((a, b) => b.gastadoCents - a.gastadoCents || b.pedidos - a.pedidos).slice(0, limite),
  };
}

/* ═══════════════════════════ Exportación a CSV ═══════════════════════════ */

/** Escapa un campo: comillas dobladas y todo entre comillas, que el dinero lleva comas. */
function celda(valor: string | number | null | undefined): string {
  let texto = valor === null || valor === undefined ? "" : String(valor);
  // Anti-inyección de fórmulas: Excel y Google Sheets EJECUTAN una celda que
  // empieza por = + - @ (o tab/retorno). Los títulos vienen del proveedor
  // (AliExpress) y el nombre y correo son de la clienta, así que un
  // `=HYPERLINK("http://malo")` se ejecutaría al abrir el CSV. Un apóstrofo
  // delante la vuelve texto; las hojas de cálculo no lo muestran.
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}

function fila(...valores: (string | number | null | undefined)[]): string {
  return valores.map(celda).join(",");
}

export type DatosInforme = {
  etiqueta: string;
  resumen: Resumen;
  serie: PuntoDia[];
  productos: ProductoTop[];
  beneficio: InformeBeneficio;
  canales: Reparto[];
  metodos: Reparto[];
  clientas: EstadisticasClientas;
};

/**
 * Informe completo en CSV, en secciones separadas por una línea en blanco.
 *
 * El dinero va formateado con `formatCents()` ("$45.99"): Excel y Google Sheets
 * reconocen esa forma como moneda al abrirlo, y es lo que Madeline espera leer.
 * El fichero se genera desde los mismos agregados que se ven en pantalla, así
 * que nunca puede decir una cifra distinta a la de la gráfica.
 */
export function csvDelInforme(datos: DatosInforme): string {
  const l: string[] = [];
  const { resumen, beneficio } = datos;

  l.push(fila("Bloom by Madeline — informe de ventas"));
  l.push(fila("Periodo", datos.etiqueta));
  l.push(fila("Generado", new Date().toLocaleString("es-US")));
  l.push(fila("Solo se cuentan pedidos cobrados (pagados)"));
  l.push("");

  l.push(fila("RESUMEN", "Periodo", "Periodo anterior", "Variación"));
  l.push(
    fila(
      "Ingresos",
      formatCents(resumen.actual.ingresosCents),
      formatCents(resumen.anterior.ingresosCents),
      textoVariacion(resumen.variacion.ingresos),
    ),
  );
  l.push(
    fila("Pedidos", resumen.actual.pedidos, resumen.anterior.pedidos, textoVariacion(resumen.variacion.pedidos)),
  );
  l.push(
    fila(
      "Ticket medio",
      resumen.actual.ticketMedioCents === null ? "—" : formatCents(resumen.actual.ticketMedioCents),
      resumen.anterior.ticketMedioCents === null ? "—" : formatCents(resumen.anterior.ticketMedioCents),
      textoVariacion(resumen.variacion.ticketMedio),
    ),
  );
  l.push(
    fila("Unidades", resumen.actual.unidades, resumen.anterior.unidades, textoVariacion(resumen.variacion.unidades)),
  );
  l.push("");

  l.push(fila("BENEFICIO BRUTO (venta de producto, sin envío)"));
  l.push(fila("Venta de producto", formatCents(beneficio.ingresosCents)));
  l.push(fila("Coste de producto", formatCents(beneficio.costeCents)));
  l.push(fila("Beneficio bruto", beneficio.beneficioCents === null ? "—" : formatCents(beneficio.beneficioCents)));
  l.push(fila("Margen", beneficio.margenPct === null ? "sin datos de coste" : `${beneficio.margenPct}%`));
  if (beneficio.lineasSinCoste > 0) {
    l.push(
      fila(
        "AVISO",
        `${beneficio.lineasSinCoste} de ${beneficio.lineasTotales} líneas vendidas no tienen coste apuntado: el margen solo cubre las ${beneficio.lineasConCoste} que sí lo tienen.`,
      ),
    );
  }
  l.push("");

  l.push(fila("VENTAS POR DÍA"));
  l.push(fila("Día", "Ingresos", "Pedidos"));
  for (const p of datos.serie) l.push(fila(p.dia, formatCents(p.ingresosCents), p.pedidos));
  l.push("");

  l.push(fila("PRODUCTOS MÁS VENDIDOS"));
  l.push(fila("Producto", "Unidades", "Ingresos", "Coste", "Margen", "Líneas sin coste"));
  for (const p of datos.productos) {
    l.push(
      fila(
        p.titulo,
        p.unidades,
        formatCents(p.ingresosCents),
        // Sin margen no hay ni una línea con coste: enseñar "$0.00" sería mentir.
        p.margenPct === null ? "—" : formatCents(p.costeCents),
        p.margenPct === null ? "—" : `${p.margenPct}%`,
        p.lineasSinCoste,
      ),
    );
  }
  l.push("");

  l.push(fila("POR CANAL"));
  l.push(fila("Canal", "Ingresos", "Pedidos", "% del total"));
  for (const c of datos.canales) l.push(fila(c.etiqueta, formatCents(c.ingresosCents), c.pedidos, `${c.pct}%`));
  l.push("");

  l.push(fila("POR MÉTODO DE PAGO"));
  l.push(fila("Método", "Ingresos", "Pedidos", "% del total"));
  for (const m of datos.metodos) l.push(fila(m.etiqueta, formatCents(m.ingresosCents), m.pedidos, `${m.pct}%`));
  l.push("");

  l.push(fila("CLIENTAS"));
  l.push(fila("Compradoras", datos.clientas.compradoras));
  l.push(fila("Nuevas", datos.clientas.nuevas, formatCents(datos.clientas.ingresosNuevasCents)));
  l.push(fila("Recurrentes", datos.clientas.recurrentes, formatCents(datos.clientas.ingresosRecurrentesCents)));
  if (datos.clientas.pedidosSinCorreo > 0) {
    l.push(
      fila(
        "Mostrador sin correo",
        `${datos.clientas.pedidosSinCorreo} pedidos`,
        formatCents(datos.clientas.ingresosSinCorreoCents),
        "no se pueden atribuir a ninguna clienta",
      ),
    );
  }
  l.push("");
  l.push(fila("Clienta", "Correo", "Pedidos", "Gastado", "Tipo"));
  for (const c of datos.clientas.top) {
    l.push(fila(c.nombre, c.email, c.pedidos, formatCents(c.gastadoCents), c.esNueva ? "Nueva" : "Recurrente"));
  }

  return l.join("\r\n");
}

/** "+12.5%", "-4%", "sin comparación". */
export function textoVariacion(v: Variacion): string {
  if (v.direccion === "nuevo") return "sin comparación (antes no hubo ventas)";
  if (v.pct === null) return "—";
  const signo = v.pct > 0 ? "+" : "";
  return `${signo}${v.pct}%`;
}
