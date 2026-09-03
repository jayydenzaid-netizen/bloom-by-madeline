"use client";

import { useActionState, useRef, useState } from "react";
import { crearPrenda, type EstadoPrenda } from "../actions";

/**
 * Alta de una prenda en el móvil de la boutique.
 *
 * El orden es el orden en el que Madeline trabaja de verdad: primero hace las
 * fotos (con la prenda delante), luego le pone nombre y precio, y al final dice
 * cuántas tiene de cada talla. Nada de slug, SKU, SEO ni «nombres de opción»:
 * eso lo rellena el servidor.
 *
 * Las fotos se suben EN CUANTO se eligen, no al guardar. Con la cobertura de
 * una tienda, subir cinco fotos al pulsar «Publicar» parece que se ha colgado,
 * y si falla se pierde todo lo escrito. Así cada foto avisa de lo suyo y el
 * guardado final es instantáneo.
 */

const TALLAS = ["XS", "S", "M", "L", "XL", "Única"] as const;

type Foto = {
  /** Identificador local mientras sube. */
  clave: string;
  /** Miniatura inmediata (blob local) para que se vea al instante. */
  vistaPrevia: string;
  /** URL definitiva ya subida. null mientras viaja. */
  url: string | null;
  error?: string;
};

const ESTADO_INICIAL: EstadoPrenda = {};

export type Categoria = { id: string; title: string };

export default function PrendaRapida({
  recienCreada,
  categorias,
}: {
  recienCreada: { nombre: string; publicada: boolean; id: string } | null;
  categorias: Categoria[];
}) {
  const [estado, accion, enviando] = useActionState<EstadoPrenda, FormData>(crearPrenda, ESTADO_INICIAL);

  const [fotos, setFotos] = useState<Foto[]>([]);
  const [nombre, setNombre] = useState("");
  const [precio, setPrecio] = useState("");
  const [descripcion, setDescripcion] = useState("");
  // Arranca con las tres tallas de la boutique marcadas y 1 pieza de cada una:
  // es el caso normal, y así no hay que tocar nada para el 80 % de las prendas.
  const [tallas, setTallas] = useState<Record<string, number>>({ S: 1, M: 1, L: 1 });
  const [elegidas, setElegidas] = useState<string[]>([]);
  const entradaFoto = useRef<HTMLInputElement>(null);

  const subiendo = fotos.some((f) => !f.url && !f.error);
  const urls = fotos.filter((f) => f.url).map((f) => f.url as string);
  const tallasElegidas = Object.entries(tallas).map(([talla, piezas]) => ({ talla, piezas }));
  const totalPiezas = tallasElegidas.reduce((s, t) => s + t.piezas, 0);

  async function alElegirFotos(lista: FileList | null) {
    if (!lista || lista.length === 0) return;
    const nuevas: Foto[] = [...lista].map((file, i) => ({
      clave: `${Date.now()}-${i}-${file.name}`,
      vistaPrevia: URL.createObjectURL(file),
      url: null,
    }));
    setFotos((previas) => [...previas, ...nuevas]);

    // Una a una: si la número 3 falla, las otras ya están arriba.
    await Promise.all(
      [...lista].map(async (file, i) => {
        const clave = nuevas[i].clave;
        try {
          const cuerpo = new FormData();
          cuerpo.append("file", file);
          cuerpo.append("carpeta", "productos");
          const res = await fetch("/api/media/upload", { method: "POST", body: cuerpo });
          const json = await res.json();
          const resultado = json?.resultados?.[0];
          if (!json?.ok || !resultado?.ok || !resultado.asset?.url) {
            throw new Error(resultado?.error || json?.error || "No se pudo subir.");
          }
          setFotos((p) => p.map((f) => (f.clave === clave ? { ...f, url: resultado.asset.url } : f)));
        } catch (error) {
          setFotos((p) =>
            p.map((f) =>
              f.clave === clave
                ? { ...f, error: error instanceof Error ? error.message : "No se pudo subir." }
                : f,
            ),
          );
        }
      }),
    );
    if (entradaFoto.current) entradaFoto.current.value = "";
  }

  function alternarTalla(talla: string) {
    setTallas((previas) => {
      const copia = { ...previas };
      if (talla in copia) delete copia[talla];
      else copia[talla] = 1;
      return copia;
    });
  }

  function cambiarPiezas(talla: string, delta: number) {
    setTallas((previas) => ({ ...previas, [talla]: Math.max(0, (previas[talla] ?? 0) + delta) }));
  }

  const listaParaPublicar = nombre.trim().length >= 2 && precio.trim() !== "" && urls.length > 0 && totalPiezas >= 0;

  return (
    <form className="np-form" action={accion}>
      {/* Lo que viaja al servidor ya masticado: el formulario visible no tiene
          ni un campo técnico. */}
      <input type="hidden" name="fotosJson" value={JSON.stringify(urls)} />
      <input type="hidden" name="tallasJson" value={JSON.stringify(tallasElegidas)} />
      <input type="hidden" name="coleccionesJson" value={JSON.stringify(elegidas)} />
      <input type="hidden" name="descripcion" value={descripcion} />

      {recienCreada ? (
        <div className="np-exito" role="status">
          <strong>✓ «{recienCreada.nombre}» {recienCreada.publicada ? "ya está a la venta" : "guardada como borrador"}.</strong>
          <span>
            Puedes añadir otra prenda ahora mismo, o{" "}
            <a href={`/admin/productos/${recienCreada.id}`}>abrir su ficha</a> para afinar detalles.
          </span>
        </div>
      ) : null}

      {estado.error ? (
        <p className="np-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      {/* ─────────── 1. FOTOS ─────────── */}
      <section className="np-paso">
        <h2 className="np-titulo">
          <span className="np-num">1</span> Fotos de la prenda
        </h2>
        <p className="np-ayuda">La primera es la que sale en la tienda. Puedes elegir varias a la vez.</p>

        <div className="np-fotos">
          {fotos.map((foto, i) => (
            <div className={foto.error ? "np-foto np-foto-mal" : "np-foto"} key={foto.clave}>
              {/* eslint-disable-next-line @next/next/no-img-element -- miniatura local o del almacén de fotos */}
              <img src={foto.url ?? foto.vistaPrevia} alt="" />
              {i === 0 && foto.url ? <span className="np-portada">Portada</span> : null}
              {!foto.url && !foto.error ? <span className="np-subiendo">Subiendo…</span> : null}
              {foto.error ? <span className="np-foto-error">{foto.error}</span> : null}
              <button
                type="button"
                className="np-quitar-foto"
                onClick={() => setFotos((p) => p.filter((f) => f.clave !== foto.clave))}
                aria-label="Quitar esta foto"
              >
                ✕
              </button>
            </div>
          ))}

          <label className="np-anadir-foto">
            <input
              ref={entradaFoto}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => alElegirFotos(e.target.files)}
            />
            <span aria-hidden="true">＋</span>
            <span>Añadir fotos</span>
          </label>
        </div>
      </section>

      {/* ─────────── 2. NOMBRE Y PRECIO ─────────── */}
      <section className="np-paso">
        <h2 className="np-titulo">
          <span className="np-num">2</span> Nombre y precio
        </h2>

        <label className="np-campo">
          <span>¿Qué es?</span>
          <input
            name="nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Vestido Amapola"
            autoComplete="off"
            enterKeyHint="next"
          />
        </label>

        <label className="np-campo">
          <span>Precio</span>
          <div className="np-precio">
            <em>$</em>
            <input
              name="precio"
              value={precio}
              onChange={(e) => setPrecio(e.target.value)}
              placeholder="45.99"
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
        </label>

        <label className="np-campo">
          <span>Descripción (opcional)</span>
          <textarea
            rows={3}
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            placeholder="Tela fresca, corte midi, ideal para un evento de día."
          />
        </label>
      </section>

      {/* ─────────── 3. CATEGORÍA ─────────── */}
      <section className="np-paso">
        <h2 className="np-titulo">
          <span className="np-num">3</span> ¿Qué tipo de prenda es?
        </h2>
        <p className="np-ayuda">
          Es lo que hace que salga en «Vestidos», «Tops» o «Shorts» de la tienda. Puedes marcar
          más de una.
        </p>
        <div className="np-tallas">
          {categorias.map((c) => (
            <button
              key={c.id}
              type="button"
              className={elegidas.includes(c.id) ? "np-talla np-talla-on np-cat" : "np-talla np-cat"}
              onClick={() =>
                setElegidas((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))
              }
              aria-pressed={elegidas.includes(c.id)}
            >
              {c.title}
            </button>
          ))}
        </div>
        {elegidas.length === 0 ? (
          <p className="np-ayuda np-ayuda-mal" style={{ marginTop: 12, marginBottom: 0 }}>
            Sin categoría la prenda no aparece en ninguna sección de la tienda.
          </p>
        ) : null}
      </section>

      {/* ─────────── 4. TALLAS ─────────── */}
      <section className="np-paso">
        <h2 className="np-titulo">
          <span className="np-num">4</span> Tallas y cuántas tienes
        </h2>
        <p className="np-ayuda">Toca una talla para añadirla o quitarla.</p>

        <div className="np-tallas">
          {TALLAS.map((talla) => (
            <button
              key={talla}
              type="button"
              className={talla in tallas ? "np-talla np-talla-on" : "np-talla"}
              onClick={() => alternarTalla(talla)}
              aria-pressed={talla in tallas}
            >
              {talla}
            </button>
          ))}
        </div>

        {tallasElegidas.length > 0 ? (
          <ul className="np-cantidades">
            {tallasElegidas.map(({ talla, piezas }) => (
              <li key={talla}>
                <span className="np-cant-talla">Talla {talla}</span>
                <div className="np-contador">
                  <button type="button" onClick={() => cambiarPiezas(talla, -1)} aria-label={`Una menos de la talla ${talla}`}>
                    −
                  </button>
                  <strong>{piezas}</strong>
                  <button type="button" onClick={() => cambiarPiezas(talla, 1)} aria-label={`Una más de la talla ${talla}`}>
                    +
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="np-ayuda np-ayuda-mal">Marca al menos una talla.</p>
        )}
      </section>

      {/* ─────────── 5. GUARDAR ─────────── */}
      <div className="np-guardar">
        <p className="np-resumen">
          {urls.length > 0 ? `${urls.length} ${urls.length === 1 ? "foto" : "fotos"}` : "Sin fotos"} ·{" "}
          {totalPiezas} {totalPiezas === 1 ? "pieza" : "piezas"} en {tallasElegidas.length}{" "}
          {tallasElegidas.length === 1 ? "talla" : "tallas"}
        </p>

        <button
          className="np-btn np-btn-primario"
          type="submit"
          name="publicar"
          value="si"
          disabled={enviando || subiendo || !listaParaPublicar}
        >
          {enviando ? "Guardando…" : subiendo ? "Esperando a las fotos…" : "Ponerla a la venta"}
        </button>

        <button className="np-btn np-btn-suave" type="submit" name="publicar" value="no" disabled={enviando || subiendo}>
          Guardar como borrador
        </button>

        {!listaParaPublicar && !subiendo ? (
          <p className="np-ayuda">
            Para ponerla a la venta hacen falta una foto, el nombre y el precio.
          </p>
        ) : null}
      </div>
    </form>
  );
}
