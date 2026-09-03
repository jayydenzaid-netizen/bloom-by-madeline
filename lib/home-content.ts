import { db } from "@/lib/db";
import type { StoreSettings } from "@/lib/settings";

/**
 * El contenido de la portada, con el texto de HOY como valor por defecto.
 *
 * La regla que manda en este fichero: **si no hay nada configurado, la portada
 * tiene que verse exactamente como está en producción**. El diseño editorial se
 * pulió durante meses y no puede quedarse vacío ni a medias porque una tabla
 * esté vacía o porque alguien borre un bloque por error.
 *
 * Por eso el contenido de hoy no vive en el JSX: vive aquí, en la semilla, en el
 * mismo formato de siete huecos que usa la tabla `HomeBlock`. Ese formato es la
 * ÚNICA fuente de verdad y sirve para tres cosas a la vez:
 *
 *   1. es lo que se pinta cuando la base está vacía,
 *   2. es lo que escribe el botón «Traer los textos de mi web» del panel
 *      (así Madeline abre el editor y ve SUS textos, no cajas en blanco),
 *   3. es el valor al que cae cada campo que ella deje vacío.
 *
 * Como los tres caminos salen del mismo sitio, sembrar la portada no puede
 * cambiar ni una coma de lo que se ve: es una garantía estructural, no una
 * promesa que haya que recordar mantener.
 *
 * Lo que NO se puede editar desde el panel (la foto pequeña del hero, la
 * insignia circular, los rótulos «Dirección» / «Horario») se queda en las
 * constantes de más abajo: HomeBlock tiene siete huecos por bloque y añadirle
 * columnas exigiría una migración en producción.
 */

/* ═══════════════════════ tipos ═══════════════════════ */

/** Los bloques que existen, en el orden en que salen en el sitio. */
export const KINDS_PORTADA = [
  "hero",
  "marquee",
  "coleccion",
  "cita",
  "exclusividad",
  "filosofia",
  "boutique",
  "comoComprar",
  "visitanos",
  "instagram",
  "banner",
] as const;
export type KindPortada = (typeof KINDS_PORTADA)[number];

/**
 * Lo que se puede mover de sitio. El hero no está: es lo primero que se ve y una
 * portada que empieza por «Cómo comprar» no es una portada. La cinta tampoco,
 * porque va cosida dentro del hero (mismo `<section>`), aunque sí se puede
 * apagar.
 */
export const KINDS_ORDENABLES = [
  "coleccion",
  "cita",
  "exclusividad",
  "filosofia",
  "boutique",
  "comoComprar",
  "visitanos",
  "instagram",
  "banner",
] as const;
export type KindOrdenable = (typeof KINDS_ORDENABLES)[number];

/** Bloques que NO se pueden apagar: sin ellos la página deja de ser la página. */
export const KINDS_SIEMPRE_VISIBLES: readonly string[] = ["hero"];

/**
 * Las anclas de la portada: a qué `id` del HTML puede apuntar un enlace del menú.
 *
 * Existe porque un enlace `/#loquesea` no se puede validar «a ojo». La sección
 * de Filosofía se apagó desde el panel y el menú siguió ofreciendo «Filosofía»
 * durante días: la clienta pulsaba y no pasaba absolutamente nada. Esta lista es
 * la única fuente de verdad — la usan el menú (para no enseñar enlaces muertos)
 * y `/admin/menus` (para ofrecer solo destinos que existen).
 *
 * `kind: null` = el ancla no depende de ningún bloque apagable. Los bloques que
 * no salen aquí (cita, cómo comprar, Instagram, banner) se pintan sin `id`, así
 * que no se puede enlazar hacia ellos.
 *
 * ⚠️ Si cambias el `id` de una `<section>` en `HomeSections.tsx`, cámbialo aquí.
 */
export type AnclaPortada = {
  /** El `id` del HTML, sin almohadilla. */
  ancla: string;
  /** Cómo se llama en el desplegable del panel. */
  etiqueta: string;
  /** El bloque que la pinta, o `null` si sale siempre. */
  kind: KindOrdenable | null;
};

export const ANCLAS_PORTADA: readonly AnclaPortada[] = [
  { ancla: "inicio", etiqueta: "Arriba del todo", kind: null },
  { ancla: "coleccion", etiqueta: "Nuevas llegadas", kind: "coleccion" },
  { ancla: "escasez", etiqueta: "Últimas piezas", kind: "exclusividad" },
  { ancla: "filosofia", etiqueta: "Filosofía", kind: "filosofia" },
  { ancla: "boutique", etiqueta: "La boutique", kind: "boutique" },
  { ancla: "visitanos", etiqueta: "Visítanos", kind: "visitanos" },
];

/**
 * En qué estado está cada ancla:
 *  · `viva`    — la sección se está pintando, se puede enlazar.
 *  · `apagada` — alguien la apagó desde /admin/contenido.
 *  · `vacia`   — está encendida pero no tiene nada que enseñar, así que no se
 *                pinta. Hoy solo le pasa a la de piezas contadas.
 */
export type EstadoAncla = "viva" | "apagada" | "vacia";

/**
 * El estado de cada ancla de la portada, dado el orden de bloques encendidos que
 * devuelve `cargarPortada`.
 *
 * `hayEscasez` va aparte porque la sección de piezas contadas se apaga sola
 * cuando no queda nada por debajo del umbral: está «encendida» en el panel y aun
 * así no existe en el HTML (ver `Exclusividad`, que devuelve `null`).
 *
 * Puro a propósito: así se prueba sin base de datos.
 */
export function anclasDePortada(
  orden: readonly KindOrdenable[],
  hayEscasez: boolean,
): Map<string, EstadoAncla> {
  const encendidos = new Set<string>(orden);
  const estados = new Map<string, EstadoAncla>();
  for (const { ancla, kind } of ANCLAS_PORTADA) {
    if (kind === null) {
      estados.set(ancla, "viva"); // el hero se pinta siempre
    } else if (!encendidos.has(kind)) {
      estados.set(ancla, "apagada");
    } else if (kind === "exclusividad" && !hayEscasez) {
      estados.set(ancla, "vacia");
    } else {
      estados.set(ancla, "viva");
    }
  }
  return estados;
}

export type Foto = { url: string; alt: string };
/** Un par «título | explicación»: ventajas, pasos… */
export type ParTexto = { titulo: string; texto: string };
/** Una de las tres cifras del hero: «2,880+ / seguidoras». */
export type Dato = { valor: string; etiqueta: string };

export type ContenidoHero = {
  overline: string;
  /** Un renglón por línea; una línea entre asteriscos sale en la cursiva serif. */
  titulo: string;
  parrafo: string;
  ctaLabel: string;
  ctaUrl: string;
  foto: Foto;
  polaroid: Foto;
  insignia: string;
  pastilla: string;
  datos: Dato[];
};

export type ContenidoMarquee = { visible: boolean; frases: string[] };

export type ContenidoColeccion = {
  visible: boolean;
  overline: string;
  titulo: string;
  nota: string;
  /** Remate cuando hay catálogo publicado. */
  tiendaNota: string;
  tiendaLabel: string;
  tiendaUrl: string;
  /** Remate cuando todavía no hay nada publicado: se vende por DM. */
  dmNota: string;
  dmLabel: string;
  dmUrl: string;
};

export type ContenidoCita = { visible: boolean; texto: string };

/**
 * Bloque de ESCASEZ. No lleva las piezas dentro: las pone la portada leyendo el
 * stock de verdad (ver app/(shop)/page.tsx). Aquí solo vive el texto, para que
 * Madeline pueda cambiarlo desde /admin/contenido sin tocar el inventario.
 */
export type ContenidoExclusividad = {
  visible: boolean;
  overline: string;
  titulo: string;
  intro: string;
  /** Cuántas unidades como mucho para considerar que una pieza «vuela». */
  umbral: number;
};

export type ContenidoFilosofia = {
  visible: boolean;
  overline: string;
  titulo: string;
  /** La frase corta entre paréntesis, encima del párrafo largo. */
  intro: string;
  texto: string;
  palabras: string[];
};

export type ContenidoBoutique = {
  visible: boolean;
  overline: string;
  titulo: string;
  texto: string;
  foto: Foto;
  fotoPequena: Foto;
  ventajas: ParTexto[];
};

export type ContenidoComoComprar = {
  visible: boolean;
  overline: string;
  titulo: string;
  pasos: ParTexto[];
};

export type ContenidoVisitanos = {
  visible: boolean;
  overline: string;
  titulo: string;
  nota: string;
  mapaLabel: string;
  mapaUrl: string;
  dmLabel: string;
  dmUrl: string;
};

export type ContenidoInstagram = {
  visible: boolean;
  overline: string;
  titulo: string;
  subtitulo: string;
  fotos: Foto[];
  ctaLabel: string;
  ctaUrl: string;
};

export type ContenidoBanner = {
  visible: boolean;
  texto: string;
  linkLabel: string;
  linkUrl: string;
};

export type Portada = {
  hero: ContenidoHero;
  marquee: ContenidoMarquee;
  coleccion: ContenidoColeccion;
  cita: ContenidoCita;
  exclusividad: ContenidoExclusividad;
  filosofia: ContenidoFilosofia;
  boutique: ContenidoBoutique;
  comoComprar: ContenidoComoComprar;
  visitanos: ContenidoVisitanos;
  instagram: ContenidoInstagram;
  banner: ContenidoBanner;
  /** Las secciones movibles, ya ordenadas y ya filtradas por visibilidad. */
  orden: KindOrdenable[];
};

/* ═══════════════════════ la semilla ═══════════════════════ */

/** Un bloque en el formato de la tabla: siete huecos y una lista. */
export type SlotBloque = {
  kind: KindPortada;
  position: number;
  isVisible: boolean;
  title: string;
  subtitle: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  linkLabel: string;
  items: string[];
};

/** Espacio fino (U+2009) de la cita, tal cual estaba en el sitio viejo. Escapado
 *  a propósito: un carácter invisible se pierde en la primera copia y pega. */
const FINO = " ";
/** Espacio duro (U+00A0): «casual elegante» y «para ti» no se parten en dos. */
const DURO = " ";

/**
 * Comodines que se rellenan solos con lo que hay en Ajustes.
 *
 * Sin ellos, sembrar la portada congelaría la dirección de hoy dentro de un
 * texto: Madeline la cambiaría en Ajustes y la cinta seguiría anunciando la
 * calle antigua durante meses. Se escriben con llaves porque cualquiera entiende
 * `{dirección}` sin que se lo expliquen, y si alguien los borra no pasa nada: se
 * queda el texto tal cual.
 */
export const COMODINES = ["{dirección}", "{horario}", "{instagram}", "{dm}"] as const;

type Comodines = { direccion: string; horario: string; instagram: string; dm: string };

/**
 * El contenido que hoy está en producción, palabra por palabra. Nada de esto es
 * inventado: sale del JSX de `HomeSections.tsx`, que a su vez venía de
 * `legacy/index.html`.
 */
const SEMILLA: (Partial<SlotBloque> & { kind: KindPortada })[] = [
  {
    kind: "hero",
    subtitle: "Boutique de moda femenina · Hamilton, Ohio",
    // Un renglón por línea, y el último en cursiva: así se lee en la web.
    title: `Elevamos\ntu estilo\n*casual${DURO}elegante.*`,
    body:
      "Tendencias exclusivas seleccionadas a mano, nuevas llegadas cada semana y una atención que se siente como ir de compras con tu mejor amiga.",
    imageUrl: "/assets/post-03-vestido-negro-olivo.jpg",
    linkLabel: "Ver nuevas llegadas",
    linkUrl: "/#coleccion",
    items: ["2,880+ | seguidoras", "S · M · L | tallas disponibles", "USA | envíos a todo el país"],
  },
  {
    kind: "marquee",
    items: [
      "Nuevas llegadas cada semana",
      "Tallas S · M · L",
      "Envíos a todo USA",
      "Pedidos por Instagram DM",
      "{dirección}",
    ],
  },
  {
    kind: "coleccion",
    subtitle: "01 — La Colección",
    title: "Nuevas *llegadas*",
    body:
      "Cada pieza nombrada como una flor,\nporque aquí todo florece.\n**Pedidos por DM · respuesta el mismo día.**",
    linkLabel: "Escríbenos por DM y te lo apartamos",
    linkUrl: "{dm}",
  },
  {
    kind: "cita",
    body: `«${FINO}Cada prenda cuenta una historia…\n*haz que la tuya brille con estilo.*${FINO}»`,
  },
  {
    kind: "exclusividad",
    subtitle: "02 — Piezas contadas",
    title: "Cuando vuela, *no vuelve*",
    body:
      "Madeline trae poquitas de cada talla, elegidas a mano y sin reposición. Lo de aquí abajo es, literalmente, lo que queda en la boutique ahora mismo.",
  },
  {
    kind: "filosofia",
    isVisible: false,
    subtitle: "02 — Nuestra Filosofía",
    title: "Vestir con *intención*",
    body:
      "(No es moda… es presencia.)\n\nEn Bloom no seguimos tendencias por seguirlas. Seleccionamos cada pieza pensando en la mujer que la va a llevar: su día, su cuerpo, su momento. Porque cuando te vistes con intención, no entras a un lugar — *floreces en él*.",
    items: ["Coherencia", "Identidad", "Presencia", "Intención"],
  },
  {
    kind: "boutique",
    subtitle: "03 — La Boutique",
    title: `Un espacio pensado *para${DURO}ti*`,
    body:
      "En pleno Grand Blvd de Hamilton, nuestra boutique es ese lugar donde entras «solo a mirar» y sales sintiéndote otra. Pruébate todo, pide opinión y deja que armemos tu outfit juntas.",
    imageUrl: "/assets/boutique-interior.jpg",
    items: [
      "Atención personalizada | Te ayudamos a encontrar tu look, sin prisa y sin presión.",
      "Pruébatelo antes de llevarlo | Probador en tienda para que salgas segura de tu compra.",
      "Nuevas llegadas semanales | Cada semana llegan piezas nuevas — y vuelan rápido.",
      "Apartados por DM | ¿La viste en Instagram? Escríbenos y te la reservamos.",
    ],
  },
  {
    kind: "comoComprar",
    subtitle: "04 — Cómo Comprar",
    title: "Tan fácil como *enamorarse*",
    items: [
      "Visítanos en la boutique | {dirección}. Pruébate todo lo que quieras — {horario}.",
      "O pide por Instagram DM | ¿Viste una pieza en nuestro perfil? Mándanos un mensaje con la foto y tu talla, y te confirmamos al momento.",
      "Envíos a todo USA | ¿No estás en Ohio? No importa. Hacemos envíos a todo Estados Unidos — tu look llega hasta tu puerta.",
    ],
  },
  {
    kind: "visitanos",
    subtitle: "05 — Visítanos",
    title: "Te esperamos\nen *Hamilton*",
    body: "El horario puede variar — confírmalo siempre en nuestro Instagram.",
    linkLabel: "Cómo llegar",
    linkUrl: "https://www.google.com/maps/search/?api=1&query={dirección}",
  },
  {
    kind: "instagram",
    subtitle: "Síguenos",
    title: "*Enamórate* en Instagram",
    body: "Únete a más de **2,880 seguidoras** que ven las nuevas llegadas antes que nadie.",
    linkLabel: "Seguir a @{instagram}",
    linkUrl: "https://www.instagram.com/{instagram}/",
    // «ruta | descripción de la foto»: la descripción es lo que oye quien no ve
    // la imagen, y perderla al editar sería empeorar el sitio.
    items: [
      "/assets/post-02-tendencia.jpg | Publicación de Instagram: set de lunares",
      "/assets/post-08-look-perfecto.jpg | Publicación de Instagram: top de plumas lila",
      "/assets/post-10-vestido-orange.jpg | Publicación de Instagram: vestido naranja",
      "/assets/post-12-vestido-coral.jpg | Publicación de Instagram: vestido durazno",
    ],
  },
  {
    // La franja de aviso no existe en el sitio de hoy: se siembra APAGADA y en
    // blanco. Inventarle un «¡Envío gratis!» sería prometer algo que Madeline no
    // ha dicho.
    kind: "banner",
    isVisible: false,
  },
];

/** La semilla completa, con todos los huecos rellenos y su posición. */
export function semillaPortada(): SlotBloque[] {
  return SEMILLA.map((b, i) => ({
    kind: b.kind,
    position: i,
    isVisible: b.isVisible ?? true,
    title: b.title ?? "",
    subtitle: b.subtitle ?? "",
    body: b.body ?? "",
    imageUrl: b.imageUrl ?? "",
    linkUrl: b.linkUrl ?? "",
    linkLabel: b.linkLabel ?? "",
    items: b.items ?? [],
  }));
}

/** La semilla de un bloque suelto, para restaurarlo desde el panel. */
export function semillaDeBloque(kind: string): SlotBloque | undefined {
  return semillaPortada().find((s) => s.kind === kind);
}

/* ═══════════ lo que no cabe en HomeBlock (y por qué) ═══════════ */

/**
 * Textos y fotos que se quedan fijos: el modelo tiene siete huecos por bloque y
 * estos son el octavo. Están aquí, juntos y localizables, en vez de escondidos
 * en el JSX, para que se vea de un vistazo qué NO puede tocar Madeline todavía.
 */
const FIJOS = {
  heroFotoAlt:
    "Vestido midi a rayas oliva y crema en maniquí dentro de la boutique Bloom by Madeline",
  heroPolaroid: {
    url: "/assets/post-05-vestido-blanco.jpg",
    alt: "Vestido mini verde lima en la boutique",
  },
  heroInsignia: "ENVÍOS A TODO USA · BLOOM ·",
  heroPastilla: "Nuevas llegadas esta semana",
  coleccionTiendaNota: "Esto es solo una parte — en la tienda está todo.",
  coleccionTiendaLabel: "Ver toda la tienda",
  coleccionTiendaUrl: "/tienda",
  coleccionDmNota: "¿Viste algo en nuestro Instagram que te enamoró?",
  boutiqueFotoAlt:
    "Interior de la boutique Bloom by Madeline: logo de loto en la pared y mostrador",
  boutiqueFotoPequena: {
    url: "/assets/post-09-coleccion-exclusiva.jpg",
    alt: "Escaparate de Bloom by Madeline con letrero de neón OPEN",
  },
  visitanosDmLabel: "Enviar DM",
} as const;

/* ═══════════════════════ carga y fusión ═══════════════════════ */

/** Lo que hace falta de una fila de HomeBlock. */
export type FilaBloque = {
  kind: string;
  title: string;
  subtitle: string;
  body: string;
  imageUrl: string | null;
  linkUrl: string | null;
  linkLabel: string;
  dataJson: string;
  position: number;
  isVisible: boolean;
};

/**
 * Lee los bloques guardados y los funde SOBRE el contenido de hoy, campo a
 * campo. Un campo vacío no borra nada: cae al valor por defecto.
 *
 * Si la consulta falla (una tabla que todavía no existe en producción, la base
 * caída un segundo) la portada se pinta igual con los valores por defecto:
 * preferimos el escaparate entero con los textos de siempre antes que un 500 en
 * la cara de una clienta.
 */
export async function cargarPortada(settings: StoreSettings): Promise<Portada> {
  let filas: FilaBloque[] = [];
  try {
    filas = await db.homeBlock.findMany({
      orderBy: [{ position: "asc" }, { kind: "asc" }],
      select: {
        kind: true,
        title: true,
        subtitle: true,
        body: true,
        imageUrl: true,
        linkUrl: true,
        linkLabel: true,
        dataJson: true,
        position: true,
        isVisible: true,
      },
    });
  } catch {
    filas = [];
  }
  return construirPortada(filas, settings);
}

/** Separado de la consulta para poder probarlo sin base de datos. */
export function construirPortada(filas: FilaBloque[], settings: StoreSettings): Portada {
  const guardados = new Map<string, FilaBloque>();
  for (const f of filas) if (!guardados.has(f.kind)) guardados.set(f.kind, f);

  const slots = new Map<KindPortada, SlotBloque>();
  for (const s of semillaPortada()) slots.set(s.kind, fusionar(s, guardados.get(s.kind)));
  const sacar = (k: KindPortada): SlotBloque => slots.get(k) as SlotBloque;

  const instagram = settings.instagram.replace(/^@/, "");
  const comunes: Comodines = {
    direccion: settings.address,
    horario: settings.hours,
    instagram,
    dm: settings.instagramDm,
  };

  const hero = sacar("hero");
  const marquee = sacar("marquee");
  const coleccion = sacar("coleccion");
  const cita = sacar("cita");
  const exclusividad = sacar("exclusividad");
  const filosofia = sacar("filosofia");
  const boutique = sacar("boutique");
  const comoComprar = sacar("comoComprar");
  const visitanos = sacar("visitanos");
  const ig = sacar("instagram");
  const banner = sacar("banner");

  // La filosofía guarda dos párrafos en un solo campo: la frase corta arriba y
  // el párrafo largo debajo, separados por una línea en blanco (es justo lo que
  // dice la ayuda del formulario). Si solo hay uno, es la frase corta.
  const parrafos = filosofia.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    hero: {
      overline: texto(hero.subtitle, comunes),
      titulo: texto(hero.title, comunes),
      parrafo: texto(hero.body, comunes),
      ctaLabel: texto(hero.linkLabel, comunes),
      ctaUrl: enlace(hero.linkUrl, comunes),
      foto: foto(hero.imageUrl, FIJOS.heroFotoAlt, settings.storeName),
      polaroid: { ...FIJOS.heroPolaroid },
      insignia: FIJOS.heroInsignia,
      pastilla: FIJOS.heroPastilla,
      datos: hero.items.map(partir).map((p) => ({ valor: p.titulo, etiqueta: p.texto })),
    },

    marquee: {
      visible: marquee.isVisible,
      // La dirección se escribe con puntos medios en vez de comas: es lo que
      // hace respirar a la cinta, y ya se hacía así en el sitio viejo.
      frases: marquee.items.map((f) =>
        texto(f, { ...comunes, direccion: settings.address.replace(/,\s*/g, " · ") }),
      ),
    },

    coleccion: {
      visible: coleccion.isVisible,
      overline: texto(coleccion.subtitle, comunes),
      titulo: texto(coleccion.title, comunes),
      nota: texto(coleccion.body, comunes),
      tiendaNota: FIJOS.coleccionTiendaNota,
      tiendaLabel: FIJOS.coleccionTiendaLabel,
      tiendaUrl: FIJOS.coleccionTiendaUrl,
      dmNota: FIJOS.coleccionDmNota,
      dmLabel: texto(coleccion.linkLabel, comunes),
      dmUrl: enlace(coleccion.linkUrl, comunes),
    },

    cita: { visible: cita.isVisible, texto: texto(cita.body, comunes) },

    exclusividad: {
      visible: exclusividad.isVisible,
      overline: texto(exclusividad.subtitle, comunes),
      titulo: texto(exclusividad.title, comunes),
      intro: texto(exclusividad.body, comunes),
      // 3 = «quedan pocas» para una boutique que trae 3 por talla. Si Madeline
      // trae más, lo sube desde /admin/contenido sin tocar código.
      umbral: 3,
    },

    filosofia: {
      visible: filosofia.isVisible,
      overline: texto(filosofia.subtitle, comunes),
      titulo: texto(filosofia.title, comunes),
      intro: texto(parrafos[0] ?? "", comunes),
      texto: texto(parrafos.slice(1).join("\n\n"), comunes),
      palabras: filosofia.items,
    },

    boutique: {
      visible: boutique.isVisible,
      overline: texto(boutique.subtitle, comunes),
      titulo: texto(boutique.title, comunes),
      texto: texto(boutique.body, comunes),
      foto: foto(boutique.imageUrl, FIJOS.boutiqueFotoAlt, settings.storeName),
      fotoPequena: { ...FIJOS.boutiqueFotoPequena },
      ventajas: boutique.items.map(partir),
    },

    comoComprar: {
      visible: comoComprar.isVisible,
      overline: texto(comoComprar.subtitle, comunes),
      titulo: texto(comoComprar.title, comunes),
      pasos: comoComprar.items.map(partir).map((p) => ({
        titulo: texto(p.titulo, comunes),
        // El horario va en minúsculas dentro de la frase: «— jueves a sábado…».
        texto: texto(p.texto, { ...comunes, horario: settings.hours.toLowerCase() }),
      })),
    },

    visitanos: {
      visible: visitanos.isVisible,
      overline: texto(visitanos.subtitle, comunes),
      titulo: texto(visitanos.title, comunes),
      nota: texto(visitanos.body, comunes),
      mapaLabel: texto(visitanos.linkLabel, comunes),
      mapaUrl: enlace(visitanos.linkUrl, comunes),
      dmLabel: FIJOS.visitanosDmLabel,
      dmUrl: settings.instagramDm,
    },

    instagram: {
      visible: ig.isVisible,
      overline: texto(ig.subtitle, comunes),
      titulo: texto(ig.title, comunes),
      subtitulo: texto(ig.body, comunes),
      fotos: ig.items.map((linea) => {
        const p = partir(linea);
        return {
          url: p.titulo,
          // Sin descripción propia, una genérica y honesta antes que ninguna.
          alt: p.texto || `Publicación de Instagram de @${instagram}`,
        };
      }),
      ctaLabel: texto(ig.linkLabel, comunes),
      ctaUrl: enlace(ig.linkUrl, comunes),
    },

    banner: {
      visible: banner.isVisible,
      texto: texto(banner.body, comunes),
      linkLabel: texto(banner.linkLabel, comunes),
      linkUrl: enlace(banner.linkUrl, comunes),
    },

    orden: ordenar(slots, guardados),
  };
}

/* ═══════════════════════ piezas ═══════════════════════ */

/** Un campo guardado solo gana si tiene algo escrito. */
function fusionar(base: SlotBloque, fila: FilaBloque | undefined): SlotBloque {
  if (!fila) return base;
  const items = leerItems(fila.dataJson);
  return {
    kind: base.kind,
    position: fila.position,
    // El hero no se puede apagar ni tocando la base a mano.
    isVisible: KINDS_SIEMPRE_VISIBLES.includes(base.kind) ? true : fila.isVisible,
    title: preferir(fila.title, base.title),
    subtitle: preferir(fila.subtitle, base.subtitle),
    body: preferir(fila.body, base.body),
    imageUrl: preferir(fila.imageUrl ?? "", base.imageUrl),
    linkUrl: preferir(fila.linkUrl ?? "", base.linkUrl),
    linkLabel: preferir(fila.linkLabel, base.linkLabel),
    items: items.length > 0 ? items : base.items,
  };
}

function preferir(guardado: string, porDefecto: string): string {
  const v = guardado.trim();
  return v.length > 0 ? v : porDefecto;
}

/** `dataJson` guarda `{ items: string[] }`. Un JSON roto no tumba la portada. */
export function leerItems(dataJson: string): string[] {
  try {
    const crudo: unknown = JSON.parse(dataJson || "{}");
    if (crudo && typeof crudo === "object" && Array.isArray((crudo as { items?: unknown }).items)) {
      return (crudo as { items: unknown[] }).items
        .filter((i): i is string => typeof i === "string")
        .map((i) => i.trim())
        .filter(Boolean);
    }
  } catch {
    /* se pinta el texto de siempre antes que dejar el hueco vacío */
  }
  return [];
}

/** «Título | explicación» → sus dos mitades. Sin barra, todo es el título. */
function partir(linea: string): ParTexto {
  const corte = linea.indexOf("|");
  if (corte < 0) return { titulo: linea.trim(), texto: "" };
  return { titulo: linea.slice(0, corte).trim(), texto: linea.slice(corte + 1).trim() };
}

/** Texto normal con los comodines de Ajustes ya rellenados. */
function texto(valor: string, v: Comodines): string {
  return sustituir(valor, v, false);
}

/** Igual, pero para un `href`: ahí una coma o un espacio sin codificar rompe. */
function enlace(valor: string, v: Comodines): string {
  return sustituir(valor, v, true);
}

function sustituir(valor: string, v: Comodines, paraUrl: boolean): string {
  if (!valor.includes("{")) return valor;
  return valor.replace(/\{(dirección|direccion|horario|instagram|dm)\}/gi, (entero, clave: string) => {
    const k = clave.toLowerCase();
    const bruto =
      k === "horario" ? v.horario : k === "instagram" ? v.instagram : k === "dm" ? v.dm : v.direccion;
    // Un ajuste vacío no puede dejar un hueco raro: se queda el comodín visible,
    // que al menos dice qué falta por rellenar en Ajustes.
    if (bruto === "") return entero;
    // `{dm}` ya es una dirección completa: codificarla la rompería.
    return paraUrl && k !== "dm" ? encodeURIComponent(bruto) : bruto;
  });
}

/**
 * La foto de un bloque. Si Madeline cambia la imagen, la descripción de la vieja
 * dejaría de ser cierta —y una descripción falsa es peor que una genérica—, así
 * que en ese caso se usa una neutra. HomeBlock no tiene campo para el texto
 * alternativo; el día que lo tenga, esto se cae solo.
 */
function foto(url: string, altOriginal: string, tienda: string): Foto {
  if (!url) return { url: "", alt: altOriginal };
  const esLaDeSiempre = semillaPortada().some((s) => s.imageUrl === url);
  return { url, alt: esLaDeSiempre ? altOriginal : `Foto de ${tienda}` };
}

/**
 * El orden de las secciones movibles. Se respeta la `position` de lo guardado y,
 * para lo que no esté todavía en la base, la posición que tiene hoy en la web.
 */
function ordenar(
  slots: Map<KindPortada, SlotBloque>,
  guardados: Map<string, FilaBloque>,
): KindOrdenable[] {
  const base = semillaPortada();
  return KINDS_ORDENABLES.map((kind) => {
    const slot = slots.get(kind) as SlotBloque;
    const fila = guardados.get(kind);
    const porDefecto = base.findIndex((s) => s.kind === kind);
    return { kind, visible: slot.isVisible, position: fila ? fila.position : porDefecto, porDefecto };
  })
    .filter((s) => s.visible)
    // Dos bloques con la misma posición (pasa si alguien tocó la base a mano):
    // desempata el orden original de la web, nunca el azar.
    .sort((a, b) => a.position - b.position || a.porDefecto - b.porDefecto)
    .map((s) => s.kind);
}
