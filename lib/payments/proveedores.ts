import type { MetodoOnline } from "./config";
import type { CodigoDiagnostico } from "./tipos";

/**
 * El catálogo de procesadores de pago, descrito UNA vez.
 *
 * Por qué existe
 * ──────────────
 * Los tres proveedores estaban escritos a fuego en trece sitios distintos: el
 * tipo de la base de datos, el enum del checkout, el componente cliente, el
 * panel, la pantalla de pedidos… Añadir un cuarto significaba tocar los trece y
 * acordarse de todos. Y para la dueña el coste era peor: cada tarjeta del panel
 * pedía campos con nombres de programador y un desplegable de «Entorno» que es
 * el concepto más confuso de toda la pantalla.
 *
 * Aquí vive todo lo que la INTERFAZ necesita saber de un procesador: cómo se
 * llama, para qué sirve, dónde se saca la credencial, qué campos tiene y —lo
 * importante— **cómo reconocer una credencial pegada**. El panel y el checkout
 * se construyen leyendo esta lista.
 *
 * Lo que NO vive aquí a propósito: el código que cobra. Cada procesador sigue
 * teniendo su adaptador con tipos propios (`stripe.ts`, `paypal.ts`,
 * `square.ts`), porque genérico significaría cambiar los importes por un
 * `Record<string, string>` y esa es la parte que mueve dinero. No se toca por
 * comodidad de la pantalla.
 *
 * PARA AÑADIR UN PROCESADOR NUEVO hacen falta exactamente cuatro cosas:
 *   1. su adaptador (`lib/payments/<nombre>.ts`) con crear / verificar / probar,
 *   2. su tipo de configuración y su clave de Setting en `config.ts`,
 *   3. engancharlo en los tres `switch` de `index.ts` y `app/admin/pagos/actions.ts`,
 *   4. y una entrada en la lista de abajo.
 * Solo el paso 4 toca la interfaz: el panel y el checkout se enteran solos.
 */

/** Un campo de credencial tal y como se le pide a la dueña. */
export type CampoProveedor = {
  /** `name` del input. Coincide con la clave de la configuración. */
  nombre: string;
  /**
   * `id` del input, ESTABLE. Lo usan las comprobaciones automatizadas
   * (`qa/pagos.mjs` teclea en `#stripe-key`), así que no se renombra sin
   * actualizarlas: un selector roto no da error, simplemente deja de comprobar.
   */
  id: string;
  etiqueta: string;
  /** Se pinta como contraseña y solo se enseña su final. */
  secreto: boolean;
  /** Cómo se llama ESE campo en el sitio del proveedor. */
  ayuda: string;
  /** Marcador de posición: la forma que tiene la credencial. */
  ejemplo: string;
};

/** Lo que se deduce de un texto pegado. */
export type PistaPegado = {
  proveedor: MetodoOnline;
  /** A qué campo pertenece. */
  campo: string;
  /**
   * El entorno, SOLO si la forma de la credencial lo delata (Stripe lo pone en
   * la propia llave: sk_live_ / sk_test_). Cuando no se puede saber queda
   * `undefined` y lo decide la sonda preguntándole al proveedor, que es la
   * única fuente fiable — y así la dueña no tiene que elegirlo nunca.
   */
  entorno?: "real" | "pruebas";
  /** Un problema conocido con lo pegado (p. ej. es la llave publicable). */
  problema?: CodigoDiagnostico;
};

export type DefProveedor = {
  id: MetodoOnline;
  etiqueta: string;
  /** Para qué sirve, en la voz de la tienda. Sale bajo el nombre en el panel. */
  paraQue: string;
  /** Dos caracteres para el monograma de la tarjeta. */
  monograma: string;
  /** El camino exacto en el sitio del proveedor. Se usa en la ayuda y en los diagnósticos. */
  donde: string;
  /** Cómo se ofrece en el checkout. */
  enElCheckout: { label: string; description: string };
  campos: CampoProveedor[];
  /** `true` si su entorno se resuelve preguntándole al proveedor. */
  entornoSeDeduce: boolean;
};

export const PROVEEDORES: readonly DefProveedor[] = [
  {
    id: "stripe",
    etiqueta: "Stripe",
    paraQue: "Tarjeta, Apple Pay y Google Pay",
    monograma: "S",
    donde: "dashboard.stripe.com → Desarrolladores → Claves de API",
    enElCheckout: {
      label: "Pagar con tarjeta",
      description: "Pago seguro con tarjeta en la página de Stripe. Te devolvemos aquí al terminar.",
    },
    campos: [
      {
        nombre: "secretKey",
        id: "stripe-key",
        etiqueta: "Llave secreta",
        secreto: true,
        ayuda: "La que empieza por sk_live_. La que empieza por pk_ es la publicable y no cobra.",
        ejemplo: "sk_live_…",
      },
    ],
    // Stripe lo lleva escrito en la propia llave.
    entornoSeDeduce: false,
  },
  {
    id: "square",
    etiqueta: "Square",
    paraQue: "La misma cuenta que tu lector de mostrador",
    monograma: "□",
    donde: "developer.squareup.com → tu aplicación → Production",
    enElCheckout: {
      label: "Pagar con tarjeta",
      description: "Pago seguro con tarjeta en la página de Square. Te devolvemos aquí al terminar.",
    },
    campos: [
      {
        nombre: "accessToken",
        id: "sq-token",
        etiqueta: "Token de acceso",
        secreto: true,
        ayuda: "El «Access token» de la pestaña Production de tu aplicación.",
        ejemplo: "EAAA…",
      },
      {
        nombre: "locationId",
        id: "sq-location",
        etiqueta: "Local",
        secreto: false,
        ayuda: "Déjalo vacío: al comprobar se rellena solo si tu cuenta tiene un único local.",
        ejemplo: "se rellena solo",
      },
    ],
    // Los tokens de Square no dicen de qué entorno son: se averigua preguntando.
    entornoSeDeduce: true,
  },
  {
    id: "paypal",
    etiqueta: "PayPal",
    paraQue: "Cuenta de PayPal o tarjeta, sin registrarse",
    monograma: "PP",
    donde: "developer.paypal.com → Apps & Credentials → pestaña Live",
    enElCheckout: {
      label: "PayPal",
      description: "Paga con tu cuenta de PayPal o con tarjeta, en su página segura.",
    },
    campos: [
      {
        nombre: "clientId",
        id: "pp-id",
        etiqueta: "Client ID",
        secreto: false,
        ayuda: "El «Client ID» de tu app. Empieza por A.",
        ejemplo: "A21…",
      },
      {
        nombre: "clientSecret",
        id: "pp-secret",
        etiqueta: "Secret",
        secreto: true,
        ayuda: "El «Secret key» de la misma app. Empieza por E.",
        ejemplo: "EL…",
      },
    ],
    entornoSeDeduce: true,
  },
];

export function proveedorPorId(id: MetodoOnline): DefProveedor {
  const p = PROVEEDORES.find((x) => x.id === id);
  // No puede fallar: `MetodoOnline` y esta lista se mantienen juntas y hay un
  // test que comprueba que coinciden.
  if (!p) throw new Error(`Proveedor sin definir en PROVEEDORES: ${id}`);
  return p;
}

/* ═══════════════════════ reconocer una credencial ═══════════════════════ */

/**
 * De qué proveedor y de qué campo es un texto pegado.
 *
 * Esto es lo que permite que el panel tenga UNA caja donde pegar en vez de nueve
 * campos repartidos en tres tarjetas: la dueña copia lo que le dio su procesador
 * y aquí se decide dónde va.
 *
 * ⚠️ EL ORDEN IMPORTA y va de lo más específico a lo más general. El token de
 * Square empieza por `EAAA` y el secreto de PayPal empieza por `E`: si PayPal se
 * comprobara primero, todos los tokens de Square acabarían en la casilla
 * equivocada. Cada patrón nuevo se añade ARRIBA del que podría tragárselo.
 *
 * Lo que NO se hace aquí es adivinar el entorno cuando la credencial no lo dice:
 * eso lo resuelve la sonda preguntando al proveedor. Un acierto a medias en algo
 * así es peor que no acertar, porque manda a cobrar al sitio equivocado.
 */
const PATRONES: {
  re: RegExp;
  pista: (m: RegExpMatchArray) => PistaPegado;
}[] = [
  // ── Stripe ──
  {
    // Llave secreta o restringida. El entorno va dentro de la propia llave.
    re: /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/,
    pista: (m) => ({
      proveedor: "stripe",
      campo: "secretKey",
      entorno: m[2] === "live" ? "real" : "pruebas",
    }),
  },
  {
    // Publicable: se reconoce para poder decir POR QUÉ no sirve.
    re: /^pk_(live|test)_[A-Za-z0-9]{10,}$/,
    pista: () => ({ proveedor: "stripe", campo: "secretKey", problema: "llave-no-secreta" }),
  },
  // ── Square ── (antes que PayPal: `EAAA` también empieza por E)
  {
    re: /^EAAA[A-Za-z0-9_-]{20,}$/,
    pista: () => ({ proveedor: "square", campo: "accessToken" }),
  },
  {
    // Identificador de local: mayúsculas y dígitos tras una L.
    re: /^L[A-Z0-9]{10,29}$/,
    pista: () => ({ proveedor: "square", campo: "locationId" }),
  },
  // ── PayPal ──
  {
    re: /^A[A-Za-z0-9_.-]{50,}$/,
    pista: () => ({ proveedor: "paypal", campo: "clientId" }),
  },
  {
    re: /^E[A-Za-z0-9_.-]{50,}$/,
    pista: () => ({ proveedor: "paypal", campo: "clientSecret" }),
  },
];

/** El primer patrón que reconozca este texto exacto. */
function casar(texto: string): PistaPegado | null {
  for (const { re, pista } of PATRONES) {
    const m = texto.match(re);
    if (m) return pista(m);
  }
  return null;
}

/**
 * Reconoce UNA credencial. `null` = no se parece a nada conocido.
 *
 * La regla, que es la parte delicada: **se juntan los trozos solo si eso no
 * cambia el veredicto.**
 *
 *  · «Access token EAAA…»  → el trozo dice Square; juntándolo diría PayPal.
 *    Distinto veredicto ⇒ manda el trozo, y el token acaba donde debe.
 *  · una llave partida en dos líneas → el primer trozo dice Stripe y juntándola
 *    también dice Stripe. Mismo veredicto ⇒ se junta, y se guarda entera en vez
 *    de a medias.
 *
 * Y si nada casa por trozos, se prueba junto: cubre el pegado de un valor con
 * espacios sueltos dentro.
 */
export function reconocerCredencial(pegado: string): PistaPegado | null {
  const limpio = limpiarPegado(pegado);
  if (!limpio) return null;

  const trozos = limpio.split(/\s+/).filter(Boolean);
  const porTrozos = trozos.map((t) => casar(t)).find((x): x is PistaPegado => x !== null) ?? null;
  const juntos = trozos.length > 1 ? casar(trozos.join("")) : porTrozos;

  if (porTrozos && juntos) {
    const mismoVeredicto =
      porTrozos.proveedor === juntos.proveedor && porTrozos.campo === juntos.campo;
    return mismoVeredicto ? juntos : porTrozos;
  }
  return porTrozos ?? juntos;
}

/**
 * Quita lo que viaja pegado a una credencial cuando se copia de verdad: la
 * etiqueta de delante («Secret key: …», «STRIPE_SECRET_KEY=…») y las comillas de
 * un .env o de un JSON.
 *
 * Es seguro cortar por `:` y por `=` porque ninguna credencial de los tres
 * proveedores los contiene: son letras, dígitos y `_ . -`. Si aparece uno, es un
 * separador de etiqueta.
 *
 * Lo que NO hace es juntar los trozos separados por espacios. Eso parece útil
 * (un valor partido por el ancho de la ventana se arregla solo) pero es
 * peligroso: «Access token EAAA…», sin dos puntos, se convertía en
 * «AccesstokenEAAA…», que empieza por A y tiene la longitud justa para pasar por
 * un Client ID de PayPal. O sea, un token de Square leído como credencial de
 * OTRO proveedor. Juntar es una decisión de `reconocerCredencial`, que solo lo
 * hace cuando no cambia la respuesta.
 */
export function limpiarPegado(pegado: string): string {
  let t = (pegado ?? "").trim();
  t = t.replace(/^[A-Za-z0-9_ .\-]{0,40}[:=]\s*/, "");
  // Comillas Y la puntuación que las rodea en un JSON. La regla anterior exigía
  // que la comilla fuera el ÚLTIMO carácter, así que en `"EAAA…",` la coma la
  // dejaba fuera de juego: el token se quedaba con la coma pegada, no casaba con
  // su patrón, y el único valor que se reconocía del bloque era el ÚLTIMO (el
  // que no lleva coma). Pegar el JSON de Square guardaba solo el local.
  t = t.replace(/[,;]+$/, "");
  t = t.replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/[,;]+$/, "");
  return t.trim();
}

/** Una credencial reconocida, con el valor ya limpio y listo para guardar. */
export type PistaConValor = PistaPegado & { valor: string };

/**
 * Reconoce VARIAS credenciales de un pegado.
 *
 * Es el caso real: la dueña selecciona el bloque entero de la página de su
 * procesador y lo pega tal cual, con las dos credenciales y sus etiquetas
 * mezcladas. Se parte por espacios y saltos y se queda con lo que reconozca.
 *
 * Si el mismo campo aparece dos veces gana el PRIMERO: en esas páginas la
 * credencial real suele ir antes que cualquier ejemplo o repetición.
 */
export function reconocerConValores(pegado: string): PistaConValor[] {
  const trozos = (pegado ?? "")
    .split(/\s+/)
    .map((t) => limpiarPegado(t))
    // 12 es el corte: por debajo no hay ninguna credencial de verdad y solo
    // entrarían palabras de las etiquetas.
    .filter((t) => t.length >= 12);

  /**
   * Gana la primera credencial USABLE de cada campo, no la primera a secas.
   *
   * Importa por un caso muy real: el panel de Stripe enseña la llave publicable
   * ARRIBA y la secreta debajo, así que lo natural es seleccionar el bloque
   * entero y pegarlo. Con «gana la primera», la publicable se quedaba el sitio y
   * la respuesta era «esa no es la secreta» — teniendo la buena en el mismo
   * pegado. Una credencial con problema solo se conserva si no hay ninguna sana
   * para ese campo, porque entonces sí hay algo que explicar.
   */
  const porCampo = new Map<string, PistaConValor>();
  for (const trozo of trozos) {
    const pista = reconocerCredencial(trozo);
    if (!pista) continue;
    const clave = `${pista.proveedor}:${pista.campo}`;
    const previa = porCampo.get(clave);
    if (previa && !previa.problema) continue; // ya hay una sana: se queda
    if (previa && pista.problema) continue; // dos con problema: gana la primera
    porCampo.set(clave, { ...pista, valor: trozo });
  }

  /**
   * Una credencial PARTIDA en varias líneas se junta; un bloque con etiquetas, no.
   *
   * `reconocerCredencial` ya sabe juntar trozos, pero aquí nunca llegaba a
   * hacerlo: se partía por espacios ANTES de llamarla, así que una llave que
   * venía cortada por el ancho de un correo se guardaba TRUNCADA — y encima de
   * la que estaba cobrando.
   *
   * La condición de seguridad: solo se junta si el pegado entero reconoce UN
   * único campo. Con dos o más (el bloque de PayPal, o el de Stripe con sus dos
   * llaves) hay etiquetas de por medio y juntar pegaría palabras al valor. Y aun
   * así el veredicto tiene que coincidir: «Access token EAAA…» junto daría
   * PayPal, distinto de Square, y se descarta.
   */
  if (porCampo.size === 1 && trozos.length > 1) {
    const [clave, actual] = [...porCampo.entries()][0];
    const juntos = reconocerCredencial(trozos.join(""));
    if (juntos && `${juntos.proveedor}:${juntos.campo}` === clave) {
      const entero = trozos.join("");
      if (entero.length > actual.valor.length && !juntos.problema) {
        porCampo.set(clave, { ...juntos, valor: entero });
      }
    }
  }

  return [...porCampo.values()];
}
