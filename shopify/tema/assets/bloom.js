/* ══════════════════════════════════════════════════════════════════════════
   BLOOM BY MADELINE — comportamiento del tema

   Dos reglas que gobiernan todo este fichero:

   1. NADA de lo imprescindible depende de este script. El formulario de
      producto envía a /cart/add, el carrito se actualiza con submits normales y
      los filtros son un GET. Este código MEJORA la experiencia; si falla, la
      tienda sigue vendiendo. En una tienda real «no se pudo comprar porque un
      script petó» no es un fallo aceptable.

   2. Todo va por DELEGACIÓN de eventos en document. El cajón del carrito se
      vuelve a pintar entero desde el servidor cada vez que cambia algo, así que
      cualquier listener atado a un nodo concreto moriría en la primera
      actualización. Delegando, el HTML nuevo funciona sin volver a enganchar nada.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var raiz = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

  /**
   * Los textos traducidos que necesita este script. Los pinta Liquid en un
   * <script type="application/json"> del layout, así que están en el idioma que
   * tenga puesto la tienda. Los valores de reserva son el último recurso para
   * que, si el bloque faltara, se vea una palabra y no "undefined".
   */
  var TEXTOS = (function () {
    var reserva = {
      anadida: 'Añadida al carrito',
      anadir: 'Añadir al carrito',
      agotado: 'Agotado',
      errorAnadir: 'No se pudo añadir. Vuelve a intentarlo.',
      ahorras: 'Ahorras',
      quedanUna: 'Queda 1 disponible',
      quedanVarias: 'Quedan 9 disponibles'
    };
    var nodo = document.getElementById('textos-bloom');
    if (!nodo) return reserva;
    try {
      var leidos = JSON.parse(nodo.textContent);
      Object.keys(reserva).forEach(function (clave) {
        if (typeof leidos[clave] === 'string' && leidos[clave]) reserva[clave] = leidos[clave];
      });
    } catch (e) {
      /* JSON roto: se usan los de reserva. */
    }
    return reserva;
  })();

  /** "Quedan 9 disponibles" + 3  →  "Quedan 3 disponibles". */
  function conCantidad(plantilla, cuantas) {
    return String(plantilla).replace(/\d+/, String(cuantas));
  }

  /* ─────────────────────────── utilidades ─────────────────────────── */

  function $(selector, dentro) {
    return (dentro || document).querySelector(selector);
  }
  function $$(selector, dentro) {
    return Array.prototype.slice.call((dentro || document).querySelectorAll(selector));
  }

  var temporizadorToast = null;
  function avisar(mensaje) {
    var toast = $('#toast');
    if (!toast) return;
    toast.textContent = mensaje;
    toast.classList.add('show');
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(function () {
      toast.classList.remove('show');
    }, 2600);
  }

  /* ═════════════════════════ barra superior ═════════════════════════ */

  var nav = $('#nav');
  if (nav) {
    var ultimoScroll = -1;
    var pendiente = false;

    function pintarNav() {
      pendiente = false;
      var y = window.scrollY;
      if (y === ultimoScroll) return;
      ultimoScroll = y;
      nav.classList.toggle('scrolled', y > 24);
    }

    window.addEventListener(
      'scroll',
      function () {
        // Un rAF por frame como mucho: el scroll dispara decenas de eventos por
        // segundo y tocar clases en cada uno provoca tirones en móviles lentos.
        if (!pendiente) {
          pendiente = true;
          requestAnimationFrame(pintarNav);
        }
      },
      { passive: true }
    );
    pintarNav();
  }

  /* ═════════════════════════ menú móvil ═════════════════════════ */

  function abrirMenu(abrir) {
    var menu = $('#menu-movil');
    var boton = $('[data-abrir-menu]');
    if (!menu || !boton) return;

    menu.classList.toggle('open', abrir);
    menu.setAttribute('aria-hidden', abrir ? 'false' : 'true');
    boton.classList.toggle('open', abrir);
    boton.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    document.body.style.overflow = abrir ? 'hidden' : '';

    // Fuera del menú cerrado no debe haber paradas de tabulador: quien navega
    // con teclado se quedaría dando saltos por enlaces invisibles.
    $$('a', menu).forEach(function (enlace) {
      enlace.setAttribute('tabindex', abrir ? '0' : '-1');
    });
  }

  document.addEventListener('click', function (evento) {
    var boton = evento.target.closest('[data-abrir-menu]');
    if (boton) {
      abrirMenu(!boton.classList.contains('open'));
      return;
    }
    // Un enlace del menú cierra el menú: en una SPA no haría falta, pero aquí la
    // navegación es normal y el menú se quedaría abierto un instante feo.
    if (evento.target.closest('#menu-movil a')) abrirMenu(false);
  });

  /* ═════════════════════════ cajón del carrito ═════════════════════════ */

  function cajon() {
    return $('#carrito-cajon');
  }

  function abrirCarrito(abrir) {
    var contenedor = cajon();
    if (!contenedor) return;
    var panel = $('.cart', contenedor);
    var fondo = $('.cart-backdrop', contenedor);
    if (!panel || !fondo) return;

    panel.classList.toggle('open', abrir);
    fondo.classList.toggle('open', abrir);
    document.body.style.overflow = abrir ? 'hidden' : '';
    if (abrir) panel.focus();
  }

  /**
   * Vuelve a pedirle al servidor el cajón entero y lo sustituye.
   *
   * Es una llamada de más frente a montar el HTML en el cliente, pero a cambio
   * el marcado del carrito existe en UN solo sitio (el Liquid) y siempre está de
   * acuerdo con lo que Shopify cree que hay dentro: descuentos aplicados,
   * precios con impuestos, límites de inventario. Reconstruirlo a mano es
   * exactamente donde aparecen los carritos que enseñan un total y cobran otro.
   */
  function refrescarCarrito(dejarAbierto) {
    return fetch(raiz + '?sections=carrito-cajon', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) {
        return r.json();
      })
      .then(function (datos) {
        var html = datos['carrito-cajon'];
        if (!html) return;

        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nuevo = doc.querySelector('#carrito-cajon');
        var viejo = cajon();
        if (!nuevo || !viejo) return;

        viejo.replaceWith(nuevo);

        var cantidad = Number(nuevo.getAttribute('data-cantidad') || '0');
        var contador = $('[data-contador-carrito]');
        if (contador) {
          contador.textContent = cantidad;
          contador.hidden = cantidad === 0;
        }

        if (dejarAbierto) abrirCarrito(true);
      })
      .catch(function () {
        // Si falla la recarga, se recarga la página: peor experiencia, pero el
        // carrito que ve la clienta nunca queda desincronizado del real.
        window.location.reload();
      });
  }

  document.addEventListener('click', function (evento) {
    if (evento.target.closest('[data-abrir-carrito]')) {
      evento.preventDefault();
      abrirCarrito(true);
      return;
    }
    if (evento.target.closest('[data-cerrar-carrito]')) {
      evento.preventDefault();
      abrirCarrito(false);
      return;
    }

    // Cambiar la cantidad de una línea desde el cajón.
    var botonLinea = evento.target.closest('[data-linea-key]');
    if (botonLinea) {
      evento.preventDefault();
      var clave = botonLinea.getAttribute('data-linea-key');
      var nueva = Number(botonLinea.getAttribute('data-cantidad'));
      if (!clave || Number.isNaN(nueva) || nueva < 0) return;

      botonLinea.disabled = true;
      fetch(raiz + 'cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: clave, quantity: nueva })
      })
        .then(function () {
          return refrescarCarrito(true);
        })
        .catch(function () {
          window.location.reload();
        });
    }
  });

  document.addEventListener('keydown', function (evento) {
    if (evento.key !== 'Escape') return;
    abrirCarrito(false);
    abrirMenu(false);
  });

  /* ═════════════════════════ acciones irreversibles ═════════════════════════ */

  // Borrar una dirección guardada no se puede deshacer. Sin JavaScript el botón
  // sigue funcionando (y sin preguntar), que es el comportamiento por defecto de
  // Shopify; con JavaScript, al menos se pregunta.
  document.addEventListener('click', function (evento) {
    var boton = evento.target.closest('[data-confirmar]');
    if (!boton) return;
    if (!window.confirm(boton.getAttribute('data-confirmar'))) evento.preventDefault();
  });

  /* ═════════════════════════ ficha de producto ═════════════════════════ */

  var formulario = $('[data-form-producto]');

  if (formulario) {
    var selector = $('[data-selector-variante]', formulario);

    /** Título de variante que compone Shopify: los valores unidos por " / ". */
    function tituloElegido() {
      var valores = $$('[data-opcion-radio]:checked', formulario)
        .sort(function (a, b) {
          return Number(a.getAttribute('data-posicion')) - Number(b.getAttribute('data-posicion'));
        })
        .map(function (radio) {
          return radio.value;
        });
      return valores.join(' / ');
    }

    function sincronizarVariante() {
      if (!selector) return;

      var buscado = tituloElegido();
      if (!buscado) return;

      var opcion = null;
      $$('option', selector).forEach(function (o) {
        if (o.textContent.trim() === buscado) opcion = o;
      });

      // Combinación que no existe (una talla que solo hay en otro color): no se
      // toca nada y se deja el botón deshabilitado con su aviso.
      var boton = $('[data-boton-anadir]', formulario);
      var textoBoton = $('[data-texto-anadir]', formulario);
      var avisoAgotado = $('[data-aviso-agotado]');
      var avisoPocas = $('[data-aviso-pocas]');

      if (!opcion) {
        if (boton) boton.disabled = true;
        if (textoBoton) textoBoton.textContent = textoAgotado();
        if (avisoAgotado) avisoAgotado.hidden = false;
        return;
      }

      selector.value = opcion.value;

      var disponible = opcion.getAttribute('data-disponible') === 'true';
      if (boton) boton.disabled = !disponible;
      if (textoBoton) textoBoton.textContent = disponible ? textoAnadir() : textoAgotado();
      if (avisoAgotado) avisoAgotado.hidden = disponible;

      // Precio.
      var precio = $('[data-precio]');
      var tachado = $('[data-precio-tachado]');
      var ahorro = $('[data-ahorro]');
      var desde = $('.pf-desde');

      if (precio) precio.textContent = opcion.getAttribute('data-precio') || precio.textContent;
      if (desde) desde.hidden = true;

      var comparado = opcion.getAttribute('data-precio-comparado') || '';
      var hayRebaja = comparado && comparado !== opcion.getAttribute('data-precio') && comparado.replace(/[^\d]/g, '') !== '0';

      if (tachado) {
        tachado.textContent = hayRebaja ? comparado : '';
        tachado.hidden = !hayRebaja;
      }
      if (ahorro) {
        if (hayRebaja) {
          var aNum = function (t) {
            return Number(String(t).replace(/[^\d.]/g, '')) || 0;
          };
          var base = aNum(comparado);
          var ahora = aNum(opcion.getAttribute('data-precio'));
          var pct = base > 0 ? Math.round(((base - ahora) / base) * 100) : 0;
          ahorro.textContent = TEXTOS.ahorras + ' ' + pct + '%';
          ahorro.hidden = pct <= 0;
        } else {
          ahorro.hidden = true;
        }
      }

      // Poca existencia: solo si Shopify sigue el inventario de verdad. En
      // dropshipping no lo sigue, y anunciar «quedan 0» sería mentira.
      if (avisoPocas) {
        var sigue = opcion.getAttribute('data-seguimiento');
        var quedan = Number(opcion.getAttribute('data-inventario'));
        if (sigue === 'shopify' && disponible && quedan > 0 && quedan <= 3) {
          avisoPocas.textContent = quedan === 1 ? TEXTOS.quedanUna : conCantidad(TEXTOS.quedanVarias, quedan);
          avisoPocas.hidden = false;
        } else {
          avisoPocas.hidden = true;
        }
      }

      // Foto propia de la variante.
      var imagenId = opcion.getAttribute('data-imagen-id');
      if (imagenId) mostrarFoto(imagenId);

      // La dirección refleja la variante elegida: así se puede compartir por DM
      // el enlace de «este vestido en talla M» y llega ya seleccionado.
      if (window.history && window.history.replaceState) {
        var url = new URL(window.location.href);
        url.searchParams.set('variant', opcion.value);
        window.history.replaceState({}, '', url.toString());
      }

      var sku = $('[data-sku]');
      if (sku) {
        var textoSku = opcion.getAttribute('data-sku');
        if (textoSku) sku.textContent = textoSku;
      }
    }

    function textoAnadir() {
      var b = $('[data-texto-anadir]');
      return TEXTOS.anadir;
    }
    function textoAgotado() {
      var b = $('[data-texto-anadir]');
      return TEXTOS.agotado;
    }

    document.addEventListener('change', function (evento) {
      var radio = evento.target.closest('[data-opcion-radio]');
      if (!radio) return;

      // El chip elegido se marca por clase: el input real está oculto.
      var grupo = radio.closest('.lb-tallas');
      if (grupo) {
        $$('label.talla-chip', grupo).forEach(function (etiqueta) {
          etiqueta.classList.remove('sel');
        });
        var etiqueta = grupo.querySelector('label[for="' + radio.id + '"]');
        if (etiqueta) etiqueta.classList.add('sel');
      }
      sincronizarVariante();
    });

    // Cantidad.
    document.addEventListener('click', function (evento) {
      var mas = evento.target.closest('[data-cantidad-mas]');
      var menos = evento.target.closest('[data-cantidad-menos]');
      if (!mas && !menos) return;
      evento.preventDefault();

      var campo = $('[data-cantidad-valor]', formulario);
      if (!campo) return;
      var valor = Number(campo.value) || 1;
      campo.value = Math.max(1, valor + (mas ? 1 : -1));
    });

    // Añadir al carrito sin recargar.
    formulario.addEventListener('submit', function (evento) {
      // Sin fetch (navegadores muy viejos) se deja el envío normal: funciona igual.
      if (!window.fetch || !window.DOMParser) return;

      evento.preventDefault();
      var boton = $('[data-boton-anadir]', formulario);
      if (boton && boton.disabled) return;
      if (boton) boton.disabled = true;

      fetch(raiz + 'cart/add.js', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(formulario)
      })
        .then(function (r) {
          return r.json().then(function (datos) {
            return { ok: r.ok, datos: datos };
          });
        })
        .then(function (resultado) {
          if (!resultado.ok) {
            // Shopify manda aquí «solo quedan 2» y cosas así: es información
            // útil, no un error genérico.
            avisar(resultado.datos.description || resultado.datos.message || TEXTOS.errorAnadir);
            return;
          }
          avisar(TEXTOS.anadida);
          return refrescarCarrito(true);
        })
        .catch(function () {
          formulario.submit();
        })
        .finally(function () {
          if (boton) boton.disabled = false;
        });
    });

    sincronizarVariante();
  }

  /* ═════════════════════════ galería ═════════════════════════ */

  function mostrarFoto(imagenId) {
    var principal = $('[data-imagen-principal]');
    var miniatura = $('[data-miniatura][data-imagen-id="' + imagenId + '"]');
    if (!principal || !miniatura) return;

    var src = miniatura.getAttribute('data-src');
    if (src) {
      principal.removeAttribute('srcset');
      principal.src = src;
    }
    $$('[data-miniatura]').forEach(function (m) {
      m.classList.toggle('sel', m === miniatura);
    });
  }

  document.addEventListener('click', function (evento) {
    var miniatura = evento.target.closest('[data-miniatura]');
    if (!miniatura) return;
    evento.preventDefault();
    mostrarFoto(miniatura.getAttribute('data-imagen-id'));
  });

  /* ═════════════════════════ filtros del catálogo ═════════════════════════ */

  document.addEventListener('click', function (evento) {
    var boton = evento.target.closest('[data-abrir-filtros]');
    if (!boton) return;
    var panel = $('[data-panel-filtros]');
    if (!panel) return;
    var abierto = panel.classList.toggle('open');
    boton.setAttribute('aria-expanded', abierto ? 'true' : 'false');
  });

  document.addEventListener('change', function (evento) {
    // Cambiar el orden aplica al momento: nadie espera tener que pulsar
    // «Aplicar» después de elegir «más barato primero».
    var orden = evento.target.closest('[data-orden]');
    if (!orden) return;
    var formulario = orden.closest('form');
    if (formulario) formulario.submit();
  });

  /* ═════════════════════════ recomendaciones ═════════════════════════ */

  var caja = $('[data-recomendaciones]');
  if (caja && caja.getAttribute('data-url')) {
    fetch(caja.getAttribute('data-url'))
      .then(function (r) {
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var bloque = doc.querySelector('.pf-rel');
        if (bloque) {
          caja.replaceWith(bloque);
          observarRevelados();
        }
      })
      .catch(function () {
        // Sin recomendaciones la ficha está completa igual.
      });
  }

  /* ═════════════════════════ revelado al hacer scroll ═════════════════════════ */

  var observador = null;

  function observarRevelados() {
    var elementos = $$('.reveal:not(.in)');
    if (!elementos.length) return;

    // Sin IntersectionObserver, se enseña todo de golpe: mejor sin animación
    // que con contenido invisible para siempre.
    if (!('IntersectionObserver' in window)) {
      elementos.forEach(function (el) {
        el.classList.add('in');
      });
      return;
    }

    if (!observador) {
      observador = new IntersectionObserver(
        function (entradas) {
          entradas.forEach(function (entrada) {
            if (!entrada.isIntersecting) return;
            entrada.target.classList.add('in');
            observador.unobserve(entrada.target);
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
      );
    }
    elementos.forEach(function (el) {
      observador.observe(el);
    });
  }

  // Quien pide menos movimiento no lo recibe: la animación es adorno y para
  // algunas personas es un problema real de mareo.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $$('.reveal').forEach(function (el) {
      el.classList.add('in');
    });
  } else {
    observarRevelados();
  }

  /* ═════════════════════════ editor de temas ═════════════════════════ */

  // Cuando alguien arrastra una sección en el editor, el contenido nuevo aparece
  // sin pasar por el arranque de este script. Estos eventos lo vuelven a activar.
  document.addEventListener('shopify:section:load', function () {
    observarRevelados();
  });
  document.addEventListener('shopify:section:select', function (evento) {
    if (evento.target.id === 'shopify-section-carrito-cajon') abrirCarrito(true);
  });
  document.addEventListener('shopify:section:deselect', function (evento) {
    if (evento.target.id === 'shopify-section-carrito-cajon') abrirCarrito(false);
  });
})();
