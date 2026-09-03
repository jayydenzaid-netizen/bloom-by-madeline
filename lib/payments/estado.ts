import { db } from "@/lib/db";
import type { MetodoOnline } from "./config";
import type { CodigoDiagnostico } from "./tipos";

/**
 * La SALUD de cada pasarela: la última vez que hablamos con ella y qué contestó.
 *
 * Por qué existe
 * ──────────────
 * El panel de pagos enseñaba estado de GUARDADO, no de CONEXIÓN. Sus tres
 * insignias salían de medir la longitud de una cadena: ninguna había hablado
 * nunca con la pasarela. «Probar conexión» producía la única verdad de la
 * pantalla y la tiraba en un `?hecho=` que moría al recargar. De ahí que el panel
 * pudiera pintar «Sin conectar» y «Guardado el 3 sept» a diez píxeles, o un verde
 * «ACTIVO EN EL CHECKOUT» con unas llaves que la pasarela ya rechaza — que es el
 * estado más caro posible: la clienta rellena sus datos, el pedido se crea con su
 * talla apartada, y el cobro no ocurre nunca.
 *
 * Guardando la salud, «conectado como Bloom by Madeline · comprobado hace 2 h»
 * pasa a ser un hecho que sobrevive a recargar la página.
 *
 * Por qué en su PROPIA fila y SIN cifrar
 * ──────────────────────────────────────
 * Es una decisión de forma de datos, no de comodidad:
 *
 *  · No toca `ConfigStripe`/`ConfigPaypal`/`ConfigSquare`, así que no toca el
 *    contrato que usan el checkout y los tests.
 *  · No toca `guardar()`, que reescribe el blob entero sin candado. La sonda y el
 *    guardado escriben filas distintas: cero carreras nuevas.
 *  · Sobrevive a un cambio de `SESSION_SECRET`. Es lo ÚNICO que puede decir la
 *    verdad sobre unas credenciales que ya no se pueden descifrar.
 *  · Se puede borrar sin perder las credenciales.
 *
 * ⚠️ REGLA DURA: aquí solo entran CÓDIGOS, FECHAS y el NOMBRE DEL COMERCIO. Ni un
 * `detail` crudo de la pasarela, ni un mensaje de error, ni nada derivado de una
 * llave. Esta fila viaja sin cifrar en las copias de seguridad. `limpiar()` lo
 * hace cumplir descartando cualquier campo que no esté previsto, y hay un test
 * que falla si alguien añade uno.
 */

/** La clave de la fila en Setting. Fuera de los tres blobs cifrados. */
const CLAVE = "paymentsEstado";

export type ResultadoSalud =
  /** La pasarela contestó y las llaves valen. */
  | "ok"
  /** La pasarela contestó y RECHAZÓ las llaves. Esto no se arregla solo. */
  | "rechazada"
  /** No se pudo preguntar (red, timeout, pasarela caída). No dice nada de las llaves. */
  | "sin-respuesta";

export type SaludProveedor = {
  resultado: ResultadoSalud;
  codigo: CodigoDiagnostico;
  /** Cuándo se comprobó, en ISO. */
  en: string;
  /** Nombre del comercio según la pasarela: «Bloom by Madeline». Nunca un secreto. */
  cuenta?: string;
  /** El entorno DEDUCIDO de la respuesta, no el que dice el desplegable. */
  entornoReal?: "real" | "pruebas";
};

export type SaludPagos = Partial<Record<MetodoOnline, SaludProveedor>>;

const RESULTADOS: ResultadoSalud[] = ["ok", "rechazada", "sin-respuesta"];

/**
 * Deja pasar solo lo previsto. Es lo que hace cumplible la regla dura de arriba:
 * si mañana alguien mete el `detail` de la pasarela en el objeto, aquí se cae.
 */
export function limpiarSalud(x: unknown): SaludProveedor | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const resultado = RESULTADOS.find((r) => r === o.resultado);
  if (!resultado) return null;
  const codigo = typeof o.codigo === "string" ? (o.codigo as CodigoDiagnostico) : "credencial-invalida";
  const en = typeof o.en === "string" ? o.en : "";
  if (!en) return null;
  const limpio: SaludProveedor = { resultado, codigo, en };
  // Se recorta a 60: es un nombre de negocio, no un campo libre.
  if (typeof o.cuenta === "string" && o.cuenta.trim()) limpio.cuenta = o.cuenta.trim().slice(0, 60);
  if (o.entornoReal === "real" || o.entornoReal === "pruebas") limpio.entornoReal = o.entornoReal;
  return limpio;
}

/**
 * La salud guardada de las tres pasarelas.
 *
 * Si la fila no existe o el JSON está roto, se devuelve `{}`: «no lo hemos
 * comprobado nunca», que es la verdad y el panel sabe decirlo. Nunca lanza —
 * esto lo lee también el checkout, y una tabla que falta no puede tumbar la
 * tienda.
 */
export async function leerSalud(): Promise<SaludPagos> {
  try {
    const fila = await db.setting.findUnique({ where: { key: CLAVE } });
    if (!fila?.value) return {};
    const crudo = JSON.parse(fila.value) as Record<string, unknown>;
    const salida: SaludPagos = {};
    for (const p of ["stripe", "paypal", "square"] as MetodoOnline[]) {
      const limpio = limpiarSalud(crudo[p]);
      if (limpio) salida[p] = limpio;
    }
    return salida;
  } catch {
    return {};
  }
}

/**
 * Apunta lo que acaba de contestar una pasarela.
 *
 * Se lee y se reescribe el objeto entero porque son tres claves y cabe en una
 * fila; el riesgo de pisarse es irrelevante (dos sondas simultáneas del mismo
 * proveedor escriben lo mismo) y a cambio no hace falta candado.
 */
export async function anotarSalud(proveedor: MetodoOnline, salud: SaludProveedor): Promise<void> {
  const limpio = limpiarSalud(salud);
  if (!limpio) return;
  try {
    const previo = await leerSalud();
    const value = JSON.stringify({ ...previo, [proveedor]: limpio });
    await db.setting.upsert({
      where: { key: CLAVE },
      create: { key: CLAVE, value },
      update: { value },
    });
  } catch (err) {
    // Apuntar la salud es informativo: si falla, no puede tumbar el cobro que
    // la estaba generando.
    console.error("[pagos] no se pudo guardar el estado de la pasarela:", err);
  }
}

/** Olvida lo que sabíamos de un proveedor (al desconectarlo). */
export async function olvidarSalud(proveedor: MetodoOnline): Promise<void> {
  try {
    const previo = await leerSalud();
    if (!previo[proveedor]) return;
    delete previo[proveedor];
    await db.setting.upsert({
      where: { key: CLAVE },
      create: { key: CLAVE, value: JSON.stringify(previo) },
      update: { value: JSON.stringify(previo) },
    });
  } catch (err) {
    console.error("[pagos] no se pudo limpiar el estado de la pasarela:", err);
  }
}

/* ────────────────────────── lectura para la interfaz ────────────────────────── */

/**
 * ¿Hay que fiarse de esta pasarela ahora mismo?
 *
 * `false` SOLO cuando la pasarela rechazó las llaves de forma explícita. Un
 * «sin-respuesta» no veta nada: la pasarela puede haber tenido un bajón y las
 * llaves ser perfectas, y apagar el cobro por eso sería cerrarle la tienda a
 * alguien por un timeout ajeno.
 */
export function saludPermiteCobrar(salud: SaludProveedor | undefined): boolean {
  return salud?.resultado !== "rechazada";
}

/** Cuántos días hace de la última comprobación. `null` = nunca se comprobó. */
export function diasDesde(salud: SaludProveedor | undefined, ahora: Date): number | null {
  if (!salud) return null;
  const cuando = Date.parse(salud.en);
  if (Number.isNaN(cuando)) return null;
  return Math.floor((ahora.getTime() - cuando) / 86_400_000);
}
