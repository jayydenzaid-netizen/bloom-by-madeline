// Descarga de páginas de proveedor con pinta de navegador.
//
// Por qué existe este fichero teniendo cada adaptador su propio fetch: los
// adaptadores bajan HTML para *parsear*; aquí se resuelve el otro problema, el de
// **decirle a Madeline qué hacer cuando falla**. No es lo mismo "AliExpress te
// bloqueó" (→ usa el bookmarklet) que "no hubo internet" (→ reintenta) que "el
// producto ya no existe" (→ cambia el enlace). Si los tres fallos se pintan igual,
// la usuaria se queda mirando la pantalla sin saber qué tocar.
//
// De ahí que el resultado sea una unión de TRES estados y no un `string | null`:
// 'ok' | 'blocked' | 'error'. La UI enruta por `status`, no por adivinanza.

export type FetchOk = {
  status: "ok";
  html: string;
  httpStatus: number;
  /** URL final tras redirecciones: los proveedores redirigen mucho entre dominios de idioma. */
  finalUrl: string;
};

export type FetchBlocked = {
  status: "blocked";
  /** Qué pasó, en español y sin jerga. */
  reason: string;
  /** Qué puede hacer la usuaria ahora mismo. */
  hint: string;
  httpStatus: number;
};

export type FetchError = {
  status: "error";
  reason: string;
  hint: string;
};

export type FetchOutcome = FetchOk | FetchBlocked | FetchError;

export type FetchOptions = {
  /** Milisegundos antes de abortar. Los proveedores tardan, pero no eternamente. */
  timeoutMs?: number;
  /** Referer plausible. Por defecto la portada del propio proveedor. */
  referer?: string;
  /** Cabeceras extra o sobrescrituras (p. ej. Cookie de moneda). */
  headers?: Record<string, string>;
  /** Un reintento con espera está activado por defecto; se puede apagar en tests. */
  retry?: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_200;

/**
 * Un Chrome de escritorio actual. Da igual lo listo que sea el resto si el
 * User-Agent grita "soy un script": el anti-bot corta antes de mirar nada más.
 */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": CHROME_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-US,es;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"Windows"',
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

/** Pista repetida en media docena de mensajes: se escribe una vez. */
export const HINT_USE_BOOKMARKLET =
  "Abre el producto en tu navegador y pulsa el bookmarklet «Traer a Bloom»: extrae los datos desde tu propia sesión y el proveedor no lo puede bloquear. " +
  "Si prefieres, copia el HTML de la ficha (Ctrl+U → Ctrl+A → Ctrl+C) y pégalo en la pestaña «HTML pegado».";

const HINT_RETRY = "Vuelve a intentarlo en un momento; si sigue fallando, usa el bookmarklet.";

// ──────────────────────────── detección de bloqueo ────────────────────────────

export type BlockCheck = { blocked: boolean; reason: string | null };

const NOT_BLOCKED: BlockCheck = { blocked: false, reason: null };

/**
 * Huellas de "no te voy a enseñar la ficha". Se buscan solo en la cabecera del
 * documento: la palabra «captcha» aparece suelta en cualquier ficha larga (en
 * scripts de terceros, en reseñas) y un falso positivo obligaría a la usuaria a
 * hacer trabajo manual que no hacía falta.
 */
const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/_____tmd_____|x5secdata|\/punish\?|punish_page|nocaptcha|baxia|sec\.taobao/i,
    "El proveedor devolvió su página de verificación anti-bot en vez del producto."],
  [/login\.aliexpress\.com|passport\.aliexpress|login\.alibaba\.com\/newlogin|\bsignin\.alibaba\b/i,
    "El proveedor redirigió al inicio de sesión en vez de mostrar la ficha."],
  [/slide to verify|desliza para verificar|verify your identity|please verify you are a human/i,
    "El proveedor pidió resolver una verificación humana."],
  [/unusual traffic|access denied|request blocked|forbidden/i,
    "El proveedor bloqueó la petición por tráfico sospechoso."],
];

/** Cuántos caracteres tiene que tener como mínimo una ficha de verdad. */
const MIN_REAL_PAGE_LENGTH = 1_500;

/**
 * ¿Esta respuesta es un bloqueo disfrazado?
 *
 * Ojo con el HTML corto: los proveedores contestan a los servidores con un
 * documento de 300 bytes y HTTP 200. Sin esta comprobación el parser diría
 * "no encontré el producto" y la usuaria buscaría el fallo en el sitio equivocado.
 */
export function isBlocked(html: string, status = 200): BlockCheck {
  if (status === 403) return { blocked: true, reason: "El proveedor rechazó la petición (403): sabe que no viene de un navegador." };
  if (status === 429) return { blocked: true, reason: "El proveedor cortó por exceso de peticiones (429)." };
  if (status === 503) return { blocked: true, reason: "El proveedor respondió 503: es su escudo anti-bot, no una caída." };

  const text = typeof html === "string" ? html : "";
  const head = text.slice(0, 30_000);

  for (const [pattern, reason] of BLOCK_MARKERS) {
    if (pattern.test(head)) return { blocked: true, reason };
  }

  if (status === 200 && text.trim().length > 0 && text.trim().length < MIN_REAL_PAGE_LENGTH) {
    return {
      blocked: true,
      reason: "El proveedor devolvió una página casi vacía: es su respuesta típica a un servidor, no a un navegador.",
    };
  }

  return NOT_BLOCKED;
}

// ──────────────────────────────── la descarga ────────────────────────────────

function refererFor(url: URL, override?: string): string {
  if (override) return override;
  // Un visitante real llega a la ficha desde el buscador interno del propio sitio,
  // no desde la nada. Un Referer del mismo origen encaja con Sec-Fetch-Site: same-origin.
  return `${url.origin}/`;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "El proveedor tardó demasiado en responder.";
    return error.message;
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Estados HTTP en los que reintentar tiene sentido: son transitorios o de ritmo. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function attempt(url: URL, options: FetchOptions): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        ...BROWSER_HEADERS,
        Referer: refererFor(url, options.referer),
        ...(options.headers ?? {}),
      },
    });

    if (response.status === 404 || response.status === 410) {
      return {
        status: "error",
        reason: "Ese producto ya no existe en el proveedor (404).",
        hint: "Comprueba el enlace: puede que lo hayan retirado del catálogo.",
      };
    }

    if (!response.ok) {
      const check = isBlocked("", response.status);
      return {
        status: "blocked",
        httpStatus: response.status,
        reason: check.reason ?? `El proveedor respondió ${response.status}.`,
        hint: HINT_USE_BOOKMARKLET,
      };
    }

    const html = await response.text();
    const check = isBlocked(html, response.status);
    if (check.blocked) {
      return {
        status: "blocked",
        httpStatus: response.status,
        reason: check.reason ?? "El proveedor no devolvió la ficha del producto.",
        hint: HINT_USE_BOOKMARKLET,
      };
    }

    return { status: "ok", html, httpStatus: response.status, finalUrl: response.url || url.toString() };
  } catch (error) {
    return {
      status: "error",
      reason: `No se pudo conectar con el proveedor: ${describeNetworkError(error)}`,
      hint: HINT_RETRY,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Baja una página de proveedor. Un solo reintento, y solo cuando reintentar puede
 * cambiar algo: fallo de red o estado transitorio. Si el proveedor ya dijo "403,
 * eres un bot", insistir no lo convence — solo gasta tiempo de la usuaria.
 */
export async function fetchPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const url = toUrl(rawUrl);
  if (!url) {
    return {
      status: "error",
      reason: "Eso no parece una dirección web.",
      hint: "Pega el enlace completo de la ficha del producto, empezando por https://",
    };
  }

  const first = await attempt(url, options);
  if (first.status === "ok") return first;

  const retryEnabled = options.retry !== false;
  const worthRetrying =
    first.status === "error" || (first.status === "blocked" && RETRYABLE_STATUS.has(first.httpStatus));

  if (!retryEnabled || !worthRetrying) return first;

  // Espera con algo de ruido: dos peticiones idénticas separadas exactamente 1200 ms
  // son en sí mismas una firma de bot.
  await delay(RETRY_DELAY_MS + Math.floor(Math.random() * 400));

  const second = await attempt(url, options);
  // Si el segundo intento también falla, se devuelve el segundo: suele traer el
  // motivo más reciente y real (el primero pudo ser un corte de red puntual).
  return second;
}

export function toUrl(raw: string): URL | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}
