# Bloom by Madeline — Sitio web de la boutique

Página de ventas de una sola página para **Bloom by Madeline**, boutique de moda
femenina en **1305 Grand Blvd, Hamilton, OH 45011** (Instagram:
[@bloombymadelin](https://www.instagram.com/bloombymadelin/)).

Demo de prospección — hecha con la información, fotos y logo reales del
Instagram del negocio (perfil público, julio 2026).

## Stack

Sitio 100% estático: `index.html` + `styles.css` + `main.js`. Sin build, sin
dependencias. Tipografías de Google Fonts (Cormorant Garamond, Jost, Allura).

## Correr local

```
python -m http.server 4590 --directory D:/projectos/bloom-by-madeline
```

(o en este repo: preview `bloom` en `.claude/launch.json`).

- `/?static` → modo sin animaciones (para capturas de página completa).

## Deploy

🚀 **EN VIVO: https://bloom-by-madeline.vercel.app** (proyecto `bloom-by-madeline`,
cuenta Vercel `jayydenzaid-2655`).

Para actualizar: editar los archivos y correr desde esta carpeta:

```
npx vercel deploy --prod --yes
```

## Contenido real usado

- **Logo**: recreado en SVG (loto line-art + BLOOM + *by* MADELINE) a partir
  del letrero de la tienda; también en `favicon.svg`.
- **Fotos** (`assets/`): 12 publicaciones del Instagram + interior de la tienda.
- **Datos**: bio, dirección, horario (Jue–Sáb 1–8 PM), tallas S/M/L, envíos a
  todo USA vía DM y frases de la propia marca («Cada prenda cuenta una
  historia…», «Vestir con intención», «Elevamos tu estilo casual elegante»).
- **Productos**: nombrados como flores (Margarita, Salvia, Jazmín, Mimosa,
  Violeta, Lavanda, Amapola, Dalia) — sin precios inventados: CTA «Pedir por DM».

## Pendiente si la clienta dice que sí

- Dominio propio + deploy (Vercel).
- Fotos en alta resolución directas de ella (las del scrape son 640px).
- Confirmar horario exacto y teléfono/WhatsApp del negocio.
- Sección de reviews reales (el highlight «Review/Clientas» de su IG).
- Versión en inglés (mercado Hamilton/Cincinnati).
