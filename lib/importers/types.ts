// Contrato único del importador.
//
// Todo proveedor (AliExpress, Alibaba, CSV, manual...) devuelve un NormalizedProduct.
// A partir de ahí el resto del sistema no sabe ni le importa de dónde vino el producto.

export type ProviderId = "aliexpress" | "alibaba" | "manual" | "csv";

/** Cómo se consiguieron los datos crudos. Importa para diagnosticar fallos. */
export type ImportMethod = "url" | "html" | "api" | "bookmarklet" | "csv" | "migracion";

export type NormalizedImage = {
  url: string;
  alt?: string;
};

export type NormalizedVariant = {
  /** "S / Negro" — se arma con los valores de opción si el proveedor no lo da. */
  title: string;
  /** Valores en el mismo orden que `optionNames`. */
  optionValues: string[];
  sku?: string;
  /** Lo que cuesta en el proveedor, en centavos USD. */
  costCents: number | null;
  /** Precio de venta sugerido, en centavos. Lo calcula la regla de pricing. */
  priceCents: number | null;
  compareAtCents?: number | null;
  stock?: number | null;
  imageUrl?: string | null;
};

export type NormalizedProduct = {
  provider: ProviderId;
  method: ImportMethod;

  /** Id del producto en el proveedor (para no importarlo dos veces). */
  sourceProductId: string | null;
  sourceUrl: string | null;

  title: string;
  description: string;
  /** Ficha técnica del proveedor: material, largo, composición... */
  attributes: Record<string, string>;

  images: NormalizedImage[];
  /** ["Talla", "Color"] */
  optionNames: string[];
  variants: NormalizedVariant[];

  /** Rango de costo del proveedor cuando no hay variantes con precio propio. */
  costCentsMin: number | null;
  costCentsMax: number | null;

  currency: string;
  vendor?: string;

  /** Todo lo que no encajó en el modelo, para poder re-parsear sin volver a pedir. */
  raw?: unknown;

  /** Problemas no fatales: campos que no se pudieron leer. Se enseñan en el admin. */
  warnings: string[];
};

export type ImportResult =
  | { ok: true; product: NormalizedProduct }
  | { ok: false; error: string; hint?: string; raw?: unknown };

/** Un adaptador sabe reconocer sus URLs y extraer el producto. */
export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  /** Dominios que reconoce, para el enrutado automático de URLs. */
  hostPatterns: RegExp[];
  matches(url: string): boolean;
  /** Extrae el id del producto de una URL del proveedor. */
  extractId(url: string): string | null;
  /** Intenta bajar y parsear a partir de la URL (puede fallar por anti-bot). */
  fromUrl(url: string): Promise<ImportResult>;
  /** Parsea el HTML de la ficha, pegado por el usuario o capturado por el bookmarklet. */
  fromHtml(html: string, sourceUrl?: string): ImportResult;
  /** Parsea el payload JSON que manda el bookmarklet desde la página del proveedor. */
  fromPayload?(payload: unknown, sourceUrl?: string): ImportResult;
}

export function emptyProduct(provider: ProviderId, method: ImportMethod): NormalizedProduct {
  return {
    provider,
    method,
    sourceProductId: null,
    sourceUrl: null,
    title: "",
    description: "",
    attributes: {},
    images: [],
    optionNames: [],
    variants: [],
    costCentsMin: null,
    costCentsMax: null,
    currency: "USD",
    warnings: [],
  };
}
