"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Field } from "../../_components/ui";

/**
 * La vía fiable: el marcador que Madeline arrastra a su barra del navegador.
 *
 * Es cliente por dos motivos que no se pueden resolver en el servidor:
 *
 *  1. El `href` es una URL `javascript:`. React sanea esos href al renderizar
 *     (los bloquea como riesgo de XSS), así que se pone a mano con `setAttribute`
 *     una vez montado el enlace. No es un truco sucio: es exactamente lo mismo que
 *     hace la página de instalación de cualquier bookmarklet, y el código que se
 *     inyecta es nuestro, servido desde /bookmarklet.js para poder auditarlo.
 *  2. Copiar al portapapeles necesita el navegador.
 */
export default function BookmarkletCard({
  href,
  code,
  token,
  endpoint,
  error,
}: {
  href: string;
  code: string;
  token: string;
  endpoint: string;
  /** Si el paquete no se pudo fabricar (fichero ausente, base de datos caída). */
  error?: string | null;
}) {
  const enlace = useRef<HTMLAnchorElement | null>(null);
  const [copiado, setCopiado] = useState<"" | "codigo" | "token">("");

  useEffect(() => {
    if (enlace.current && href) enlace.current.setAttribute("href", href);
  }, [href]);

  // El aviso de "copiado" se borra solo: un mensaje que se queda fijo deja de
  // significar nada a la segunda vez que se pulsa.
  useEffect(() => {
    if (!copiado) return;
    const t = setTimeout(() => setCopiado(""), 2200);
    return () => clearTimeout(t);
  }, [copiado]);

  async function copiar(texto: string, que: "codigo" | "token") {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(que);
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS) no se puede copiar por código:
      // se deja el texto seleccionable para que lo haga a mano.
      setCopiado("");
      window.prompt("Copia esto con Ctrl+C:", texto);
    }
  }

  if (error) {
    return (
      <div className="imp-aviso imp-aviso-danger">
        <div className="imp-aviso-cuerpo">
          <b>No se pudo preparar el marcador.</b>
          <p>{error}</p>
          <p>Mientras tanto, la pestaña «Pegar HTML» hace exactamente lo mismo a mano y no depende de esto.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className="imp-nota">
        <b>Es la vía fiable.</b> El marcador se ejecuta dentro de tu navegador, en la propia página del proveedor y con
        tu sesión abierta: para AliExpress eres tú mirando el producto, no un servidor pidiéndolo. Por eso no hay
        bloqueo que valga. Es lo mismo que hacen las extensiones de DSers o AutoDS, sin instalar ninguna extensión.
      </p>

      <div className="imp-marcador-zona">
        {/* href se rellena en useEffect; sin él el enlace no navega a ningún sitio. */}
        <a ref={enlace} className="imp-marcador" href="#" onClick={(e) => e.preventDefault()} draggable>
          <span aria-hidden="true">🌸</span> Traer a Bloom
        </a>
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <b>Arrastra este botón a tu barra de marcadores.</b>
          <div className="adm-small adm-muted">
            Si no ves la barra: <kbd>Ctrl</kbd> + <kbd>Mayús</kbd> + <kbd>B</kbd> en Chrome y Edge.
          </div>
        </div>
      </div>

      <ol className="imp-pasos-lista">
        <li>
          Arrastra el botón rosa de arriba hasta la <b>barra de marcadores</b> (la fila de accesos que va justo debajo
          de la barra de direcciones). Aparecerá ahí como un marcador más, llamado «Traer a Bloom».
        </li>
        <li>
          Abre en otra pestaña el producto que quieras traer, en <b>aliexpress.com</b> o <b>alibaba.com</b>. Tiene que
          ser la ficha del producto, no la lista de resultados de búsqueda.
        </li>
        <li>
          Con esa ficha delante, pulsa el marcador <b>«Traer a Bloom»</b>. Sale un aviso confirmando el envío y el
          producto aparece aquí abajo, en el historial, listo para revisar.
        </li>
      </ol>

      <div className="imp-aviso imp-aviso-info">
        <div className="imp-aviso-cuerpo">
          <b>Este marcador es la llave de tu tienda.</b>
          <p>
            Lleva dentro un token que autoriza a crear importaciones en Bloom. No lo compartas ni lo publiques: quien lo
            tenga puede meter productos en el panel. Si alguna vez crees que se ha filtrado, se cambia desde Ajustes y
            el marcador antiguo deja de funcionar (habrá que volver a arrastrar el nuevo).
          </p>
        </div>
      </div>

      <Field label="Token de esta tienda" hint={`Se envía a ${endpoint}`}>
        <code className="imp-token">{token}</code>
      </Field>

      <div className="adm-row">
        <Button variant="ghost" size="sm" type="button" onClick={() => copiar(code, "codigo")}>
          {copiado === "codigo" ? "Código copiado" : "Copiar el código del marcador"}
        </Button>
        <Button variant="ghost" size="sm" type="button" onClick={() => copiar(token, "token")}>
          {copiado === "token" ? "Token copiado" : "Copiar el token"}
        </Button>
        {/* Ancla y no <Button href>: la primitiva tipa el resto de props como las
            de un <button> y no acepta target. La clase da el mismo aspecto. */}
        <a className="adm-btn adm-btn-ghost adm-btn-sm" href="/bookmarklet.js" target="_blank" rel="noreferrer">
          Ver qué hace por dentro
        </a>
      </div>
    </>
  );
}
