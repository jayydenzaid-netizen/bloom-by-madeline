import type { ResultadoPrueba } from "./tipos";

/**
 * ¿Se ofrece o no este método después de sondear la pasarela?
 *
 * Vive aparte y es PURA por dos razones: porque la misma decisión se toma en dos
 * sitios (`conectarProveedor` y `pegarCredencial`) y ya se desincronizaron una
 * vez, y porque un fichero `"use server"` solo puede exportar funciones async —
 * así que la regla no se podía probar donde estaba.
 *
 * Las tres respuestas, y por qué:
 *
 *  · La pasarela dice que SÍ  → se hace lo que pidió la dueña.
 *  · La pasarela dice que NO  → apagado, aunque ella lo hubiera pedido encendido.
 *    Ofrecer una tarjeta que no cobra deja a la clienta con el pedido hecho, su
 *    talla apartada y sin forma de pagar.
 *  · La pasarela NO CONTESTA  → **como estaba antes**. Y esto es lo que hay que
 *    proteger: guardar apagado antes de sondear salva la credencial recién
 *    pegada, pero si luego no se puede preguntar, dejarlo apagado significa que
 *    un bajón ajeno de treinta segundos deja a la tienda sin cobro con tarjeta
 *    por tiempo indefinido. De un fallo de red no se concluye NADA.
 *
 * Este último caso ya se rompió una vez: al reescribir el panel se perdió, y la
 * pantalla además decía «tus llaves están guardadas y sin tocar» mientras el
 * cobro quedaba apagado en la base de datos.
 */
export function activacionTrasSondeo(
  quiereActivo: boolean,
  activoAntes: boolean,
  r: Pick<ResultadoPrueba, "ok" | "motivo">,
): boolean {
  if (r.ok) return quiereActivo;
  if (r.motivo === "red") return activoAntes;
  return false;
}
