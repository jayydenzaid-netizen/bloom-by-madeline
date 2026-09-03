import { headers } from "next/headers";
import Script from "next/script";
import { requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import { applyPricing, formatCents, margin } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { Badge, Button, Card, Ficha, Field, PageHeader, Paso } from "../_components/ui";
import { guardarContacto, guardarEnvio, guardarIdentidad, guardarPrecios, regenerarToken } from "./actions";

/**
 * Ajustes de la tienda. Cada sección es un formulario independiente con su
 * propia Server Action: guardar el envío no puede pisar los precios.
 *
 * La sección de precios lleva calculadora porque es el ajuste que más dinero
 * mueve: un ×2.6 mal puesto se replica en cada producto que se importe después.
 * Tiene que verse el precio final y el margen ANTES de guardar, sin leer nada.
 */

export const dynamic = "force-dynamic";

/**
 * Clave del token del bookmarklet en la tabla Setting. Se repite aquí porque un
 * fichero "use server" solo puede exportar funciones async; si cambia en
 * `actions.ts`, cambia también aquí.
 */
const IMPORT_TOKEN_KEY = "importToken";

/** Costes de ejemplo para la tabla de referencia (en centavos). */
const EJEMPLOS = [500, 1200, 2500, 4900];

const MENSAJES: Record<string, string> = {
  contacto: "Guardado. Así es como te encuentran ahora en la web.",
  identidad: "Nombre y lema guardados.",
  precios: "Regla de precios guardada. Se aplicará a las próximas importaciones.",
  envio: "Ajustes de envío guardados.",
  token: "Token nuevo generado. Vuelve a instalar el marcador en tu navegador.",
};

export default async function AjustesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireOwner("ajustes");

  const sp = await searchParams;
  const uno = (key: string): string => {
    const raw = sp[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };
  const guardado = uno("guardado");
  const error = uno("error");
  const mensajeError = uno("msg");

  const [settings, filaToken, cabeceras] = await Promise.all([getSettings(), leerToken(), headers()]);

  const host = cabeceras.get("host") ?? "localhost:4590";
  const protocolo = cabeceras.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const urlIngest = `${protocolo}://${host}/api/import/ingest`;

  const regla = settings.pricing;
  const costeEjemplo = 1200;
  const precioEjemplo = applyPricing(costeEjemplo, regla);
  const margenEjemplo = margin(precioEjemplo, costeEjemplo);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ESTILOS }} />

      <PageHeader title="Ajustes" subtitle="Cómo te encuentran, cómo te llamas, cuánto cobras por enviar y cómo pones los precios" />

      {guardado || error ? (
        <Card flush>
          <div className="adm-alerts">
            <div className="adm-alert">
              <span className="adm-alert-text">
                {error ? (
                  <>
                    <Badge tone="danger">No se guardó</Badge>
                    {mensajeError || "Revisa los datos e inténtalo otra vez."}
                  </>
                ) : (
                  <>
                    <Badge tone="success">Guardado</Badge>
                    {MENSAJES[guardado] ?? "Cambios guardados."}
                  </>
                )}
              </span>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="adm-pasos">
        {/* ───────── 1. cómo te encuentran ─────────
            Va primero porque es lo que más se toca y lo que más se nota fuera:
            estos seis campos son el pie de la web, el mapa y el botón de pedir
            por DM. Antes estaban mezclados con el nombre y el lema en una sola
            tarjeta llamada «Tienda». */}
        <Paso
          numero={1}
          titulo="¿Cómo te encuentran?"
          ayuda="Esto es lo que sale en el pie de la web, en el mapa de «Visítanos» y en el botón de pedir por Instagram. Lo que dejes vacío, sencillamente no se publica."
        >
          <form action={guardarContacto}>
            <div className="aju-cols">
              <Field label="Dirección de la boutique" htmlFor="address" hint="Sale en el pie y marca el mapa de la portada.">
                <input type="text" id="address" name="address" defaultValue={settings.address} maxLength={200} />
              </Field>
              <Field label="Horario" htmlFor="hours" hint="Tal cual quieres que lo lea una clienta.">
                <input type="text" id="hours" name="hours" defaultValue={settings.hours} maxLength={140} />
              </Field>
              <Field label="Instagram" htmlFor="instagram" hint="Solo el usuario, sin la arroba.">
                <input type="text" id="instagram" name="instagram" defaultValue={settings.instagram} maxLength={60} />
              </Field>
              <Field
                label="Enlace para escribirte por DM"
                htmlFor="instagramDm"
                hint="El botón «Pedir por DM» de toda la web lleva aquí."
              >
                <input
                  type="text"
                  id="instagramDm"
                  name="instagramDm"
                  defaultValue={settings.instagramDm}
                  placeholder="https://ig.me/m/…"
                  inputMode="url"
                />
              </Field>
              <Field label="Teléfono" htmlFor="phone" hint="Solo si quieres que aparezca en la web. Hoy no aparece ninguno.">
                <input type="tel" id="phone" name="phone" defaultValue={settings.phone} maxLength={40} inputMode="tel" />
              </Field>
              <Field label="Correo de contacto" htmlFor="email" hint="Déjalo vacío si prefieres que no se publique.">
                <input id="email" name="email" type="email" defaultValue={settings.email} placeholder="hola@…" inputMode="email" />
              </Field>
            </div>
            <div className="adm-paso-pie">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar cómo te encuentran
              </button>
            </div>
          </form>
        </Paso>

        {/* ───────── 2. cómo te llamas ───────── */}
        <Paso
          numero={2}
          titulo="¿Cómo se llama tu tienda?"
          ayuda="El nombre sale en la cabecera, en la pestaña del navegador y cuando alguien comparte el enlace por WhatsApp. El lema va justo debajo, en la portada."
        >
          <form action={guardarIdentidad}>
            <div className="aju-cols">
              <Field label="Nombre" htmlFor="storeName" required>
                <input type="text" id="storeName" name="storeName" defaultValue={settings.storeName} maxLength={80} />
              </Field>
              <Field label="Lema" htmlFor="tagline" hint="Una frase corta. Sale bajo el nombre en la portada.">
                <input type="text" id="tagline" name="tagline" defaultValue={settings.tagline} maxLength={160} />
              </Field>
            </div>
            <div className="adm-paso-pie">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar el nombre
              </button>
            </div>
          </form>
        </Paso>

        {/* ───────── 3. envío ───────── */}
        <Paso
          numero={3}
          titulo="¿Cuánto cobras por enviar?"
          ayuda="Es lo que ve una clienta al final de la compra. Para las zonas y las tarifas por estado hay una pantalla propia, «Envíos»."
        >
          <form action={guardarEnvio}>
            <div className="aju-cols">
              <Field
                label="Envío gratis a partir de"
                htmlFor="freeShippingOverCents"
                hint="Pon 0 y el envío será siempre gratis."
              >
                <input
                  type="text"
                  id="freeShippingOverCents"
                  name="freeShippingOverCents"
                  inputMode="decimal"
                  defaultValue={formatCents(settings.freeShippingOverCents)}
                />
              </Field>
              <Field label="Si no llega, cobras" htmlFor="flatShippingCents" hint="La tarifa plana de envío.">
                <input
                  type="text"
                  id="flatShippingCents"
                  name="flatShippingCents"
                  inputMode="decimal"
                  defaultValue={formatCents(settings.flatShippingCents)}
                />
              </Field>
            </div>

            {/* Ficha en vez de casilla: se toca con el pulgar y se ve encendida
                de un vistazo, sin acertarle a un cuadradito de 20px. */}
            <div className="adm-chips" style={{ margin: "4px 0 16px" }}>
              <Ficha name="localPickup" defaultChecked={settings.localPickup}>
                Puede recoger en la boutique
              </Ficha>
            </div>
            <p className="adm-paso-ayuda">
              {settings.localPickup
                ? `Si la marcas, en el checkout puede elegir venir a por ello a ${settings.address || "la boutique"}.`
                : "Ahora mismo no se ofrece recoger en tienda: todo pedido va por envío."}
            </p>

            <Field
              label="¿Cuánto tardas en mandarlo?"
              htmlFor="shippingNotice"
              hint="Se enseña en el carrito y en el checkout. Si algo viene del proveedor y tarda semanas, dilo aquí: es la promesa que ella va a recordar."
            >
              <textarea id="shippingNotice" name="shippingNotice" rows={2} defaultValue={settings.shippingNotice} maxLength={300} />
            </Field>

            <div className="adm-paso-pie">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar el envío
              </button>
            </div>
          </form>
        </Paso>

        {/* ───────── 4. la regla de precios ─────────
            Va la ULTIMA de los pasos porque es la que menos se toca: se pone
            una vez y ya. Pero es la que mas dinero mueve, y por eso conserva su
            calculadora — un x2.6 mal puesto se replica en cada producto que se
            importe despues. */}
        <Paso
          numero={4}
          titulo="¿Cuánto le sumas a lo que te cuesta?"
          ayuda="Solo afecta a lo que traes de AliExpress o Alibaba: convierte lo que te cuesta allí en el precio de tu tienda. Las prendas que subes tú llevan el precio que tú pongas."
        >
        <p className="adm-muted adm-small aju-intro">
          Cuando traes un producto de AliExpress o Alibaba, esta regla convierte lo que cuesta allí en el precio de
          tu tienda. Ahora mismo, algo que te cuesta{" "}
          {formatCents(costeEjemplo)} se vendería a <b>{formatCents(precioEjemplo)}</b>
          {margenEjemplo.percent !== null ? ` (margen del ${margenEjemplo.percent}%)` : ""}.
        </p>

        <form action={guardarPrecios} id="aju-precios">
          <div className="aju-cols">
            <Field label="Multiplicar el coste por" htmlFor="aju-multiplier" hint="2.6 significa venderlo a 2,6 veces lo que te costó.">
              <input
                type="text"
                id="aju-multiplier"
                name="multiplier"
                inputMode="decimal"
                defaultValue={String(regla.multiplier)}
                autoComplete="off"
              />
            </Field>
            <Field label="Y sumarle" htmlFor="aju-add" hint="Se suma al final. Sirve para cubrir el envío y el empaque.">
              <input type="text" id="aju-add" name="addCents" inputMode="decimal" defaultValue={formatCents(regla.addCents)} autoComplete="off" />
            </Field>
            <Field label="Terminar el precio en" htmlFor="aju-rounding">
              <select id="aju-rounding" name="rounding" defaultValue={regla.rounding}>
                <option value="none">Sin redondear</option>
                <option value="99">Terminar en .99</option>
                <option value="95">Terminar en .95</option>
                <option value="whole">Dólar entero</option>
              </select>
            </Field>
          </div>

          {/* La calculadora vive dentro del formulario para que reaccione a los
              campos de arriba antes de guardarlos. */}
          <div className="aju-calc">
            <div className="aju-calc-in">
              <Field label="Si un producto te cuesta" htmlFor="aju-coste">
                <input type="text" id="aju-coste" inputMode="decimal" defaultValue={formatCents(costeEjemplo)} autoComplete="off" />
              </Field>
              <p className="adm-small adm-muted">
                Este campo no se guarda: es solo para probar. Cambia también los números de arriba y mira cómo se
                mueve el precio.
              </p>
            </div>
            <div className="aju-calc-out">
              <div>
                <span className="aju-calc-lbl">Precio de venta</span>
                <b id="aju-precio">{formatCents(precioEjemplo)}</b>
              </div>
              <div>
                <span className="aju-calc-lbl">Te quedan</span>
                <b id="aju-margen">{margenEjemplo.cents !== null ? formatCents(margenEjemplo.cents) : "—"}</b>
              </div>
              <div>
                <span className="aju-calc-lbl">Margen</span>
                <b id="aju-margenpct">{margenEjemplo.percent !== null ? `${margenEjemplo.percent}%` : "—"}</b>
              </div>
            </div>
          </div>

          <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
            Guardar la regla de precios
          </button>
        </form>

        <table className="aju-tabla">
          <caption className="adm-small adm-muted">Con la regla ya guardada</caption>
          <thead>
            <tr>
              <th>Te cuesta</th>
              <th>Lo vendes a</th>
              <th>Te quedan</th>
              <th>Margen</th>
            </tr>
          </thead>
          <tbody>
            {EJEMPLOS.map((coste) => {
              const precio = applyPricing(coste, regla);
              const m = margin(precio, coste);
              return (
                <tr key={coste}>
                  <td>{formatCents(coste)}</td>
                  <td>
                    <b>{formatCents(precio)}</b>
                  </td>
                  <td>{m.cents !== null ? formatCents(m.cents) : "—"}</td>
                  <td>{m.percent !== null ? `${m.percent}%` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </Paso>
      </div>

      {/* ──────────────────────────── pagos ──────────────────────────── */}
      <Card title="¿Cómo te pagan?">
        <p className="adm-muted">
          Los cobros viven ahora en su propia página: ahí conectas tus cuentas de Stripe,
          PayPal y Square (pegando sus llaves, cifradas en la base de datos) y enciendes o
          apagas el DM y la recogida en tienda.
        </p>
        <div style={{ marginTop: 12 }}>
          <Button href="/admin/pagos" variant="primary">
            Abrir Pagos
          </Button>
        </div>
      </Card>

      {/* ───────────────────────── importación ───────────────────────── */}
      <Card title="Traer productos de AliExpress o Alibaba">
        <p className="adm-muted adm-small aju-intro">
          El marcador que arrastras a tu navegador manda a tu tienda lo que ves en AliExpress o Alibaba, a{" "}
          <code>{urlIngest}</code> firmados con este token. Trátalo como una contraseña: quien lo tenga puede meter
          productos en tu tienda.
        </p>

        {filaToken ? (
          <>
            <p className="adm-field-lbl">Token actual</p>
            <p className="aju-token">{filaToken}</p>
          </>
        ) : (
          <p className="adm-muted adm-small">
            Todavía no hay token. Genera uno para poder instalar el marcador en tu navegador.
          </p>
        )}

        <form action={regenerarToken} className="aju-token-form">
          <button
            type="submit"
            className="adm-btn adm-btn-ghost adm-btn-sm"
            data-confirmar={
              filaToken
                ? "Al generar un token nuevo, el marcador que ya tienes instalado deja de funcionar y hay que volver a arrastrarlo desde la pantalla de Importar. ¿Seguir?"
                : "Se generará el token para el marcador. ¿Seguir?"
            }
          >
            {filaToken ? "Regenerar token" : "Generar token"}
          </button>
          <span className="adm-muted adm-small">
            Regenerarlo obliga a reinstalar el marcador en todos los navegadores donde lo tengas.
          </span>
        </form>
      </Card>

      <Script id="aju-ui" strategy="afterInteractive">
        {SCRIPT_UI}
      </Script>
    </>
  );
}

/* ──────────────────────────── datos ──────────────────────────── */

/**
 * El token vive en la tabla Setting, fuera de StoreSettings: es un secreto de
 * infraestructura y no debe viajar nunca en la respuesta del escaparate, que sí
 * lee los ajustes de la tienda.
 */
async function leerToken(): Promise<string | null> {
  const fila = await db.setting.findUnique({ where: { key: IMPORT_TOKEN_KEY } });
  if (!fila) return null;
  try {
    const valor: unknown = JSON.parse(fila.value);
    return typeof valor === "string" ? valor : fila.value;
  } catch {
    // Guardado en crudo por otra parte del sistema: se acepta igual.
    return fila.value;
  }
}

/* ──────────────────────────── estilos ──────────────────────────── */

const ESTILOS = `
.aju-intro { margin: 0 0 16px; max-width: 68ch; }
.aju-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 18px; }
.aju-check {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 11px 0; border-bottom: 1px solid var(--adm-line-soft);
}
.aju-check:last-of-type { border-bottom: 0; }
.aju-check input { width: 18px; height: 18px; margin-top: 2px; flex: 0 0 auto; accent-color: var(--adm-accent); }
.aju-check span { display: flex; flex-direction: column; gap: 2px; }
.aju-check.is-off { opacity: 0.62; }

.aju-calc {
  display: grid; grid-template-columns: minmax(200px, 1fr) minmax(240px, 1.2fr); gap: 18px;
  background: var(--adm-surface-2); border-radius: var(--adm-r);
  padding: 14px 16px; margin: 6px 0 18px;
}
.aju-calc-out { display: flex; gap: 18px; align-items: flex-end; flex-wrap: wrap; }
.aju-calc-out > div { display: flex; flex-direction: column; gap: 2px; }
.aju-calc-lbl {
  font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--adm-muted);
}
.aju-calc-out b { font-size: 21px; color: var(--adm-accent); line-height: 1.2; }

.aju-tabla { width: 100%; border-collapse: collapse; margin-top: 4px; }
.aju-tabla caption { text-align: left; padding-bottom: 6px; }
.aju-tabla th {
  text-align: left; font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--adm-muted); font-weight: 500; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--adm-line);
}
.aju-tabla td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--adm-line-soft); font-size: 14px; }

.aju-token {
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 13px; word-break: break-all; background: var(--adm-surface-2);
  border-radius: var(--adm-r-sm); padding: 10px 12px; margin: 2px 0 14px;
}
.aju-token-form { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

@media (max-width: 640px) {
  .aju-calc { grid-template-columns: 1fr; }
}
`;

/* ──────────────────────────── script ──────────────────────────── */

// ESPEJO de applyPricing/margin/formatCents (lib/money.ts) para que la
// calculadora responda mientras se teclea, sin viaje al servidor. Si aquella
// lógica cambia, hay que cambiarla aquí: por eso la página NO recalcula al
// cargar — los números que se ven de entrada son los del servidor, y así una
// divergencia se nota al primer tecleo en vez de quedar disimulada.
const SCRIPT_UI = `
(function () {
  if (window.__bloomAjustesUI) return;
  window.__bloomAjustesUI = true;

  document.addEventListener("click", function (ev) {
    var origen = ev.target;
    if (!origen || !origen.closest) return;
    var confirmar = origen.closest("[data-confirmar]");
    if (confirmar && !window.confirm(confirmar.getAttribute("data-confirmar") || "¿Seguro?")) {
      ev.preventDefault();
    }
  });

  var form = document.getElementById("aju-precios");
  if (!form) return;

  var dinero = new Intl.NumberFormat("es-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

  function aCentavos(valor) {
    var limpio = String(valor || "")
      .replace(/[^0-9.,-]/g, "")
      .replace(/,([0-9]{1,2})$/, ".$1")
      .replace(/,/g, "");
    var numero = parseFloat(limpio);
    return isFinite(numero) ? Math.round(numero * 100) : 0;
  }

  function terminar(cents, ending) {
    var dolares = Math.floor(cents / 100);
    var candidato = dolares * 100 + ending;
    return candidato >= cents ? candidato : (dolares + 1) * 100 + ending;
  }

  function precioDe(costCents, mult, addCents, redondeo) {
    var coste = Math.max(0, Math.round(costCents || 0));
    var precio = Math.round(coste * mult) + Math.round(addCents || 0);
    if (redondeo === "99") precio = terminar(precio, 99);
    else if (redondeo === "95") precio = terminar(precio, 95);
    else if (redondeo === "whole") precio = Math.ceil(precio / 100) * 100;
    return Math.max(precio, coste + 1);
  }

  function pinta(id, texto) {
    var nodo = document.getElementById(id);
    if (nodo) nodo.textContent = texto;
  }

  function recalcular() {
    var coste = aCentavos((document.getElementById("aju-coste") || {}).value);
    var mult = parseFloat(String((document.getElementById("aju-multiplier") || {}).value || "0").replace(",", "."));
    var suma = aCentavos((document.getElementById("aju-add") || {}).value);
    var redondeo = (document.getElementById("aju-rounding") || {}).value;

    if (!isFinite(mult) || mult <= 0) {
      pinta("aju-precio", "—");
      pinta("aju-margen", "Multiplicador no válido");
      pinta("aju-margenpct", "—");
      return;
    }

    var precio = precioDe(coste, mult, suma, redondeo);
    var ganancia = precio - coste;
    var porcentaje = precio > 0 ? Math.round((ganancia / precio) * 1000) / 10 : 0;

    pinta("aju-precio", dinero.format(precio / 100));
    pinta("aju-margen", dinero.format(ganancia / 100));
    pinta("aju-margenpct", porcentaje + "%");
  }

  form.addEventListener("input", recalcular);
  form.addEventListener("change", recalcular);
})();
`;
