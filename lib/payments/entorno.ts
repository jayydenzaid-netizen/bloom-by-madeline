import type { ConfigPagos, MetodoOnline } from "./config";

/**
 * ¿Las credenciales que hay guardadas cobran DINERO DE VERDAD, o son de pruebas?
 *
 * Es la única señal que separa «tu tienda está cobrando» de «tu tienda manda a
 * las clientas a una página donde toda tarjeta real se rechaza». Y estaba a
 * medias en tres sitios:
 *
 *  · Stripe solo miraba `sk_test_`, así que una llave RESTRINGIDA de pruebas
 *    (`rk_test_…`) se etiquetaba como real y la insignia «En pruebas» —el único
 *    aviso de la pantalla— no salía nunca.
 *  · PayPal y Square lo leían del campo «entorno», que ya no se pregunta: ahora
 *    lo deduce la sonda, así que hay que leerlo de la configuración ya resuelta.
 *
 * Puro a propósito: así se prueba sin base de datos y sin red.
 */
export function esDePruebas(proveedor: MetodoOnline, cfg: ConfigPagos): boolean {
  if (proveedor === "stripe") {
    // Vale tanto para la secreta normal como para la restringida.
    return /^(sk|rk)_test_/.test(cfg.stripe.secretKey);
  }
  if (proveedor === "paypal") return cfg.paypal.entorno === "sandbox";
  return cfg.square.entorno === "sandbox";
}
