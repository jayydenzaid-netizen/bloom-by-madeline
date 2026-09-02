/**
 * Tipos compartidos de la capa de pagos.
 *
 * Los tres proveedores (Stripe, PayPal, Square) trabajan igual desde fuera:
 * reciben los datos YA CONGELADOS del pedido (nunca del carrito ni del
 * navegador), crean una página de pago hosted y devuelven { ref, url }.
 * La verificación pregunta al proveedor por esa ref con la llave secreta:
 * la vuelta del navegador jamás se cree por sí sola.
 */

/** Una línea del pedido, tal cual quedó congelada en OrderItem. */
export type LineaPago = {
  titulo: string;
  cantidad: number;
  precioCents: number;
};

/** Todo lo que hace falta para crear una sesión de cobro. Importes de la fila Order. */
export type DatosPago = {
  numero: string; // BLM-1042
  email: string;
  /** "USD" — de settings.currency, en mayúsculas. */
  currency: string;
  lineas: LineaPago[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  /** Etiqueta del impuesto ("Impuesto OH 6.5 %") para el recibo del proveedor. */
  taxLabel: string;
  urlRetorno: string;
  urlCancelacion: string;
};

export type SesionPago = {
  /** Id con el que luego se verifica (sesión de Stripe, orden de PayPal/Square). */
  ref: string;
  /** Página de pago hosted a la que se manda a la clienta. */
  url: string;
  /**
   * Id para ANULAR la sesión (expirarla) cuando se reintenta o se cancela el
   * pedido: en Stripe es la propia sesión, en Square el id del payment link
   * (distinto del order_id), y PayPal no lo necesita (invoice_id ya bloquea
   * un segundo cobro del mismo pedido).
   */
  cancelRef?: string;
};

export type Verificacion =
  /** El proveedor confirma el cobro y el importe cuadra con el pedido. */
  | { estado: "pagado"; referencia: string }
  /** Aún no hay cobro (sesión abierta, abandonada o pago en proceso). */
  | { estado: "pendiente" }
  /** Hay un cobro pero NO cuadra (importe/moneda/pedido): no se marca pagado solo. */
  | { estado: "no-coincide"; detalle: string }
  /** No se pudo preguntar (red, credencial mala). */
  | { estado: "error"; detalle: string };

/** fetch inyectable: los tests lo sustituyen por un stub sin tocar la red. */
export type FetchLike = typeof fetch;

/**
 * Fallo de una pasarela, distinguiendo QUIÉN falló.
 *
 * `credencial: true` = la pasarela contestó y rechazó las llaves (token malo,
 * caducado, de otro entorno). `false` = no llegamos a preguntar (red, timeout):
 * de eso NO se puede concluir que las llaves estén mal, y por tanto nunca debe
 * apagarse un cobro que quizá funciona.
 */
export class ErrorPasarela extends Error {
  constructor(
    message: string,
    readonly credencial: boolean,
  ) {
    super(message);
    this.name = "ErrorPasarela";
  }
}

/** Resultado de «probar conexión». `motivo` explica un fallo para poder actuar. */
export type ResultadoPrueba = {
  ok: boolean;
  detalle: string;
  /** credencial = las llaves están mal · red = no se pudo preguntar. */
  motivo?: "credencial" | "red";
};

/** 1234 -> "12.34". PayPal quiere decimales en texto; con Int de centavos es exacto. */
export function centavosADecimales(cents: number): string {
  return (cents / 100).toFixed(2);
}
