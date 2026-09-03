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
  /**
   * No se pudo preguntar (red, pasarela caída, credencial mala).
   *
   * `credencial: true` = la pasarela contestó y rechazó las llaves. Esa
   * distinción importa mucho aquí: con las llaves rotas, TODOS los pedidos
   * cobrados de verdad se quedan sin poder confirmarse, y alguien tiene que
   * enterarse. Un timeout suelto, en cambio, se arregla solo al reintentar.
   */
  | { estado: "error"; detalle: string; credencial?: boolean };

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
    /**
     * El código de error TAL CUAL lo devolvió la pasarela
     * (`ACCESS_TOKEN_EXPIRED`, `UNAUTHORIZED`…). Es lo único que distingue un
     * token caducado de uno revocado o de uno sin permisos: el texto legible
     * que acompaña a los tres es el mismo genérico.
     */
    readonly codigo?: string,
    /** La familia del error según la pasarela (`AUTHENTICATION_ERROR`…). */
    readonly categoria?: string,
  ) {
    super(message);
    this.name = "ErrorPasarela";
  }
}

/**
 * Por qué falló una conexión, en un código estable.
 *
 * Existe porque hasta ahora el panel elegía sus dos mejores mensajes con una
 * expresión regular sobre prosa en español (`/PRUEBAS \(Sandbox\)/`): cambiar una
 * tilde rompía el diagnóstico sin que nadie se enterara. Un código no se rompe al
 * reescribir un texto, y además se puede guardar y volver a enseñar días después.
 *
 * Es corto a propósito: cada valor tiene que traducirse a UNA instrucción que la
 * dueña pueda seguir. Si no sabes qué decirle, es `credencial-invalida`.
 */
export type CodigoDiagnostico =
  /** Todo bien. */
  | "ok"
  /** La pasarela contestó y rechazó las llaves, sin más detalle. */
  | "credencial-invalida"
  /** El token existió pero ya caducó. */
  | "token-caducado"
  /** Alguien lo revocó desde el panel del proveedor. */
  | "token-revocado"
  /** Las llaves valen pero les faltan permisos para cobrar. */
  | "permisos-insuficientes"
  /** La aplicación del proveedor está desactivada o suspendida. */
  | "aplicacion-desactivada"
  /** El token es del otro entorno (pruebas contra real, o al revés). */
  | "entorno-cruzado"
  /** La cuenta no tiene ningún local activo con el que cobrar. */
  | "sin-locales"
  /** El identificador de local guardado no es de esta cuenta. */
  | "local-ajeno"
  /** La cuenta tiene varios locales y no se ha elegido ninguno. */
  | "local-sin-elegir"
  /** Se pegó una llave publicable donde iba la secreta. */
  | "llave-no-secreta"
  /** No se pudo ni preguntar: red, timeout, o la pasarela caída. */
  | "sin-respuesta";

/** Resultado de «probar conexión». `motivo` y `codigo` explican un fallo para poder actuar. */
export type ResultadoPrueba = {
  ok: boolean;
  detalle: string;
  /** credencial = las llaves están mal · red = no se pudo preguntar. */
  motivo?: "credencial" | "red";
  /** Diagnóstico estable, para guardarlo y para elegir el mensaje del panel. */
  codigo?: CodigoDiagnostico;
  /** Nombre del comercio según el proveedor: sirve para confirmar CUÁL cuenta quedó conectada. */
  cuenta?: string;
};

/** 1234 -> "12.34". PayPal quiere decimales en texto; con Int de centavos es exacto. */
export function centavosADecimales(cents: number): string {
  return (cents / 100).toFixed(2);
}
