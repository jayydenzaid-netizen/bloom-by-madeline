// Bookmarklet «Traer a Bloom» — FUENTE LEGIBLE.
//
// Este fichero es el original comentado. Lo que Madeline arrastra a su barra de
// marcadores es la versión minificada que genera lib/importers/bookmarklet.ts,
// sustituyendo estos tres marcadores por los valores reales de la tienda:
//
//   __BLOOM_ENDPOINT__   URL absoluta de /api/import/ingest
//   __BLOOM_TOKEN__      token de la tienda (Setting 'importToken')
//   __BLOOM_PANEL__      URL absoluta de /admin/importar
//
// POR QUÉ EXISTE ESTA VÍA
// AliExpress y Alibaba bloquean las peticiones que salen de un servidor: reconocen
// las IP de centro de datos y devuelven un captcha. Pero no pueden bloquear al
// propio navegador de la usuaria, que está dentro de la ficha, con su sesión y su
// IP de casa. Este bookmarklet lee el estado que la página ya tiene cargado en
// memoria y lo manda a la tienda. Es lo mismo que hacen las extensiones de DSers o
// AutoDS, sin tener que publicar una extensión en la Chrome Web Store.
//
// REGLAS DE ESTILO OBLIGATORIAS EN ESTE FICHERO
// El minificador es un tokenizador pequeño que solo sabe de cadenas y comentarios.
// Para que no se equivoque:
//   1. Ninguna cadena de texto puede contener dos barras seguidas ni barra-asterisco.
//   2. Nada de expresiones regulares literales; usar indexOf/split.
//   3. Punto y coma al final de cada sentencia: al colapsar los saltos de línea no
//      queda inserción automática que valga.

(function () {
  var ENDPOINT = "__BLOOM_ENDPOINT__";
  var TOKEN = "__BLOOM_TOKEN__";
  var PANEL = "__BLOOM_PANEL__";

  // Vercel corta las peticiones por encima de 4,5 MB. Se deja margen.
  var MAX_BYTES = 3800000;

  // 1 ── ¿en qué proveedor estamos?
  function detectarProveedor(host) {
    var h = String(host || "").toLowerCase();
    if (h.indexOf("alibaba.") !== -1) return "alibaba";
    if (h.indexOf("aliexpress.") !== -1) return "aliexpress";
    return "";
  }

  // 2 ── el estado que la ficha ya tiene cargado.
  // Se recogen TODOS los que existan, no el primero que aparezca: cada versión de
  // la página deja el suyo y el parser del servidor sabe puntuar cuál trae más.
  function recogerEstado() {
    var fuentes = [
      ["runParams", function () { return window.runParams; }],
      ["dcData", function () { return window._d_c_ && window._d_c_.DCData; }],
      ["nextData", function () { return window.__NEXT_DATA__; }],
      ["detailData", function () { return window.detailData; }],
      ["initData", function () { return window.__INIT_DATA__; }],
      ["ssrData", function () { return window.__ssrData; }]
    ];
    var salida = {};
    var i;
    for (i = 0; i < fuentes.length; i++) {
      try {
        var valor = fuentes[i][1]();
        if (valor) { salida[fuentes[i][0]] = valor; }
      } catch (error) {
        // Una fuente que no existe no es un fallo: se prueba la siguiente.
      }
    }
    return salida;
  }

  // 3 ── serializar sin morir.
  // El estado del proveedor tiene referencias circulares y nodos del DOM dentro.
  // Se intenta primero el camino rápido; solo si revienta se paga el filtrado, que
  // pierde objetos repetidos y por eso no se usa siempre.
  function serializar(objeto) {
    try {
      return JSON.stringify(objeto);
    } catch (error) {
      var vistos = new Set();
      return JSON.stringify(objeto, function (clave, valor) {
        if (typeof valor === "function") { return undefined; }
        if (typeof Node !== "undefined" && valor instanceof Node) { return undefined; }
        if (valor && typeof valor === "object") {
          if (vistos.has(valor)) { return undefined; }
          vistos.add(valor);
        }
        return valor;
      });
    }
  }

  // 4 ── el aviso flotante.
  // Se pinta en la página del proveedor, así que todo va con estilos en línea: la
  // hoja de estilos de la tienda no existe aquí y el CSP de ellos no dejaría cargarla.
  function avisar(titulo, detalle, enlace, color) {
    var previo = document.getElementById("bloom-import-aviso");
    if (previo && previo.parentNode) { previo.parentNode.removeChild(previo); }

    var caja = document.createElement("div");
    caja.id = "bloom-import-aviso";
    caja.style.cssText = [
      "position:fixed",
      "top:18px",
      "right:18px",
      "z-index:2147483647",
      "max-width:340px",
      "padding:16px 18px",
      "border-radius:18px 4px 18px 4px",
      "background:#ECE1CD",
      "color:#2B2320",
      "font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif",
      "box-shadow:0 12px 40px rgba(0,0,0,.28)",
      "border-left:4px solid " + color
    ].join(";");

    var h = document.createElement("strong");
    h.textContent = titulo;
    h.style.cssText = "display:block;margin-bottom:6px;font-size:15px";
    caja.appendChild(h);

    var p = document.createElement("div");
    p.textContent = detalle;
    caja.appendChild(p);

    if (enlace) {
      var a = document.createElement("a");
      a.href = enlace;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Revisarlo en el panel";
      a.style.cssText = "display:inline-block;margin-top:10px;color:#77303E;font-weight:600";
      caja.appendChild(a);
    }

    var cerrar = document.createElement("button");
    cerrar.textContent = "×";
    cerrar.style.cssText =
      "position:absolute;top:6px;right:10px;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#77303E";
    cerrar.onclick = function () {
      if (caja.parentNode) { caja.parentNode.removeChild(caja); }
    };
    caja.appendChild(cerrar);

    document.documentElement.appendChild(caja);
    setTimeout(function () {
      if (caja.parentNode) { caja.parentNode.removeChild(caja); }
    }, 20000);
  }

  // 5 ── el envío.
  function enviar() {
    var proveedor = detectarProveedor(location.hostname);
    if (!proveedor) {
      avisar(
        "Aquí no hay nada que traer",
        "Este marcador solo funciona en una ficha de producto de AliExpress o de Alibaba.com.",
        null,
        "#8a6d3b"
      );
      return;
    }

    var carga = {
      provider: proveedor,
      url: location.href,
      title: document.title,
      token: TOKEN,
      data: recogerEstado()
    };

    var cuerpo = serializar(carga);
    if (!cuerpo) {
      avisar("No pude leer la página", "El navegador no dejó serializar los datos de la ficha.", null, "#77303E");
      return;
    }

    // El HTML entero es el plan B del servidor cuando el estado JSON no cuadra.
    // Solo se manda si cabe: vale más una importación con datos parciales que un
    // envío rechazado por tamaño.
    if (cuerpo.length < MAX_BYTES) {
      try {
        var conHtml = serializar({
          provider: carga.provider,
          url: carga.url,
          title: carga.title,
          token: carga.token,
          data: carga.data,
          html: document.documentElement.outerHTML
        });
        if (conHtml && conHtml.length < MAX_BYTES) { cuerpo = conHtml; }
      } catch (error) {
        // Sin HTML se sigue: el estado JSON suele bastar.
      }
    }

    if (cuerpo.length >= MAX_BYTES) {
      avisar(
        "La ficha pesa demasiado",
        "Esta página trae más datos de los que acepta la tienda. Copia el HTML a mano y pégalo en el panel.",
        PANEL,
        "#77303E"
      );
      return;
    }

    avisar("Enviando a Bloom…", "Leyendo la ficha y mandándola a la tienda.", null, "#77303E");

    // Content-Type de texto plano a propósito: convierte la petición en «simple»
    // para el navegador y se ahorra el preflight OPTIONS, que algunas redes
    // corporativas bloquean. El servidor la parsea igual como JSON.
    fetch(ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: cuerpo
    })
      .then(function (respuesta) {
        return respuesta.text().then(function (texto) {
          var datos = null;
          try { datos = JSON.parse(texto); } catch (error) { datos = null; }
          return { estado: respuesta.status, datos: datos, texto: texto };
        });
      })
      .then(function (resultado) {
        if (resultado.datos && resultado.datos.ok) {
          var d = resultado.datos;
          var detalle = d.title ? d.title : "Producto importado";
          if (d.variants) { detalle = detalle + " · " + d.variants + " variantes"; }
          if (d.images) { detalle = detalle + " · " + d.images + " fotos"; }
          if (d.duplicate) { detalle = detalle + " · ojo: ya lo tienes en el catálogo"; }
          avisar("Listo, está en Bloom", detalle, d.reviewUrl || PANEL, "#77303E");
          return;
        }
        var motivo =
          (resultado.datos && (resultado.datos.error || resultado.datos.hint)) ||
          "El servidor respondió " + resultado.estado + ".";
        avisar("No se pudo importar", motivo, PANEL, "#8a6d3b");
      })
      .catch(function (error) {
        avisar(
          "No se pudo contactar con la tienda",
          "Comprueba que la tienda está encendida. Detalle: " + (error && error.message ? error.message : error),
          PANEL,
          "#8a6d3b"
        );
      });
  }

  enviar();
})();
