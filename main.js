/* ═══════════════════════════════════════════════
   BLOOM BY MADELINE — interacciones
   ═══════════════════════════════════════════════ */

(() => {
  "use strict";

  /* ── Modo estático (?static): sin animaciones, todo visible.
       Útil para capturas y para navegadores muy viejos. ── */
  if (new URLSearchParams(location.search).has("static")) {
    document.documentElement.classList.add("static");
    // cargar todas las imágenes de inmediato (capturas de página completa)
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      img.loading = "eager";
    });
  }

  /* ── Preloader ─────────────────────────────── */
  const preloader = document.getElementById("preloader");
  window.addEventListener("load", () => {
    setTimeout(() => preloader.classList.add("done"), 900);
  });
  // red de seguridad por si 'load' tarda (imágenes lentas)
  setTimeout(() => preloader.classList.add("done"), 3200);

  /* ── Nav + botón flotante DM al hacer scroll ── */
  const nav = document.getElementById("nav");
  const dmFab = document.querySelector(".dm-fab");
  const onScroll = () => {
    nav.classList.toggle("scrolled", window.scrollY > 30);
    if (dmFab) dmFab.classList.toggle("show", window.scrollY > 640);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ── Menú móvil ────────────────────────────── */
  const burger = document.getElementById("burger");
  const mobileMenu = document.getElementById("mobileMenu");
  const setMenu = (open) => {
    burger.classList.toggle("open", open);
    mobileMenu.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
    mobileMenu.setAttribute("aria-hidden", String(!open));
    document.body.style.overflow = open ? "hidden" : "";
  };
  burger.addEventListener("click", () =>
    setMenu(!mobileMenu.classList.contains("open"))
  );
  mobileMenu.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => setMenu(false))
  );

  /* ── Reveal on scroll ──────────────────────── */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* ── Parallax sutil en imágenes del hero ───── */
  const parallaxEls = document.querySelectorAll("[data-parallax]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isStatic = document.documentElement.classList.contains("static");
  if (parallaxEls.length && !reduceMotion && !isStatic) {
    let ticking = false;
    const applyParallax = () => {
      parallaxEls.forEach((el) => {
        const speed = parseFloat(el.dataset.parallax || "0.06");
        const rect = el.getBoundingClientRect();
        const offset = (rect.top + rect.height / 2 - window.innerHeight / 2) * speed;
        el.style.transform =
          (el.classList.contains("hero-polaroid") ? "rotate(-5deg) " : "") +
          `translateY(${offset * -1}px)`;
      });
      ticking = false;
    };
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          requestAnimationFrame(applyParallax);
          ticking = true;
        }
      },
      { passive: true }
    );
    applyParallax();
  }

  /* ── Lightbox de producto ──────────────────── */
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbName = document.getElementById("lbName");
  const lbDesc = document.getElementById("lbDesc");
  const lbMeta = document.getElementById("lbMeta");
  const lbClose = document.getElementById("lightboxClose");
  let lastFocus = null;
  let lbCurrent = null; // producto abierto en el lightbox (para el carrito)

  const openLightbox = (card) => {
    lastFocus = document.activeElement;
    lbCurrent = card;
    renderLbTallas(card);
    lbImg.src = card.dataset.img;
    lbImg.alt = card.dataset.name;
    lbName.textContent = card.dataset.name;
    lbDesc.textContent = card.dataset.desc;
    lbMeta.innerHTML = card.dataset.meta;
    lightbox.hidden = false;
    requestAnimationFrame(() => lightbox.classList.add("show"));
    document.body.style.overflow = "hidden";
    lbClose.focus();
  };

  const closeLightbox = () => {
    lightbox.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(() => {
      lightbox.hidden = true;
      if (lastFocus) lastFocus.focus();
    }, 400);
  };

  document.querySelectorAll(".product").forEach((card) => {
    card.addEventListener("click", () => openLightbox(card));
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Ver detalle: ${card.dataset.name}`);
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openLightbox(card);
      }
    });
  });

  lbClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (ev) => {
    if (ev.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !lightbox.hidden) closeLightbox();
  });

  /* ── Carrito de compras ─────────────────────── */
  const IG_DM = "https://ig.me/m/bloombymadelin";
  const CART_KEY = "bloom-cart";
  const cartEl = document.getElementById("cart");
  const cartBackdrop = document.getElementById("cartBackdrop");
  const cartBtn = document.getElementById("cartBtn");
  const cartClose = document.getElementById("cartClose");
  const cartBody = document.getElementById("cartBody");
  const cartFoot = document.getElementById("cartFoot");
  const cartTotal = document.getElementById("cartTotal");
  const cartCount = document.getElementById("cartCount");
  const cartSend = document.getElementById("cartSend");
  const cartHint = document.getElementById("cartHint");
  const lbTallas = document.getElementById("lbTallas");
  const lbAdd = document.getElementById("lbAdd");

  // el carrito sobrevive recargas (localStorage puede fallar en modo privado)
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { /* vacío */ }
  const saveCart = () => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* sin persistencia */ }
  };

  /* toast de aviso */
  const toastEl = document.getElementById("toast");
  let toastTimer;
  const toast = (msg) => {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  };

  /* chips de talla del lightbox */
  function renderLbTallas(card) {
    const sizes = (card.dataset.sizes || "S,M,L").split(",");
    lbTallas.innerHTML = "";
    sizes.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "talla-chip";
      b.textContent = s.trim();
      b.addEventListener("click", () => {
        lbTallas.querySelectorAll(".talla-chip").forEach((c) => c.classList.remove("sel"));
        b.classList.add("sel");
      });
      lbTallas.appendChild(b);
    });
  }

  const fmt = (n) => "$" + n.toFixed(2);

  const renderCart = () => {
    const n = cart.reduce((a, i) => a + i.qty, 0);
    cartCount.hidden = n === 0;
    cartCount.textContent = n;

    if (!cart.length) {
      cartBody.innerHTML =
        '<div class="cart-empty">' +
        '<svg viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>' +
        "<p>Tu carrito aún está por <em>florecer</em>.</p>" +
        '<button class="btn btn-ink" type="button" id="cartToShop">Ver la colección</button>' +
        "</div>";
      cartFoot.hidden = true;
      return;
    }

    cartBody.innerHTML = cart
      .map((i, idx) => {
        const precio = i.price != null ? `<span class="ci-precio">${fmt(i.price * i.qty)}</span>` : "";
        return (
          `<div class="cart-item" data-idx="${idx}">` +
          `<img src="${i.img}" alt="${i.name}">` +
          `<div class="ci-info"><h4>${i.name}</h4><p class="ci-meta">Talla ${i.size}</p>` +
          `<div class="ci-qty">` +
          `<button type="button" data-act="menos" aria-label="Quitar una">−</button>` +
          `<span>${i.qty}</span>` +
          `<button type="button" data-act="mas" aria-label="Añadir una">+</button>` +
          `</div></div>` +
          precio +
          `<button type="button" class="ci-del" data-act="del" aria-label="Eliminar del carrito">×</button>` +
          `</div>`
        );
      })
      .join("");

    // total en $ solo si TODAS las piezas tienen precio; si no, en piezas
    const conPrecio = cart.every((i) => i.price != null);
    cartTotal.textContent = conPrecio
      ? fmt(cart.reduce((a, i) => a + i.price * i.qty, 0))
      : `${n} ${n === 1 ? "pieza" : "piezas"}`;
    cartFoot.hidden = false;
    cartHint.hidden = true;
  };

  const openCart = () => {
    renderCart();
    cartEl.classList.add("open");
    cartBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    cartClose.focus();
  };
  const closeCart = () => {
    cartEl.classList.remove("open");
    cartBackdrop.classList.remove("open");
    document.body.style.overflow = "";
  };

  const addToCart = (card, size) => {
    const name = card.dataset.name;
    const found = cart.find((i) => i.name === name && i.size === size);
    if (found) found.qty += 1;
    else
      cart.push({
        name,
        size,
        qty: 1,
        img: card.dataset.img,
        price: card.dataset.price ? parseFloat(card.dataset.price) : null,
      });
    saveCart();
    renderCart();
  };

  lbAdd.addEventListener("click", () => {
    const sel = lbTallas.querySelector(".talla-chip.sel");
    if (!sel) {
      toast("Elige tu talla ✿");
      lbTallas.classList.add("shake");
      setTimeout(() => lbTallas.classList.remove("shake"), 500);
      return;
    }
    addToCart(lbCurrent, sel.textContent);
    closeLightbox();
    openCart();
  });

  /* acciones dentro del drawer (cantidad, eliminar, ir a la colección) */
  cartBody.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    if (btn.id === "cartToShop") {
      closeCart();
      document.getElementById("coleccion").scrollIntoView({ behavior: "smooth" });
      return;
    }
    const item = btn.closest(".cart-item");
    if (!item) return;
    const idx = +item.dataset.idx;
    if (btn.dataset.act === "mas") cart[idx].qty += 1;
    else if (btn.dataset.act === "menos") {
      cart[idx].qty -= 1;
      if (cart[idx].qty <= 0) cart.splice(idx, 1);
    } else if (btn.dataset.act === "del") cart.splice(idx, 1);
    saveCart();
    renderCart();
  });

  /* enviar pedido: copia el resumen y abre el DM de Instagram */
  cartSend.addEventListener("click", () => {
    if (!cart.length) return;
    const n = cart.reduce((a, i) => a + i.qty, 0);
    const conPrecio = cart.every((i) => i.price != null);
    const lineas = [
      "✿ Pedido — Bloom by Madeline",
      ...cart.map((i) => `${i.qty}× ${i.name} · Talla ${i.size}`),
      conPrecio
        ? `Total: ${fmt(cart.reduce((a, i) => a + i.price * i.qty, 0))}`
        : `Total: ${n} ${n === 1 ? "pieza" : "piezas"} — precios por confirmar`,
    ];
    try { navigator.clipboard.writeText(lineas.join("\n")); } catch { /* sin clipboard */ }
    cartHint.hidden = false;
    window.open(IG_DM, "_blank", "noopener");
  });

  cartBtn.addEventListener("click", openCart);
  cartClose.addEventListener("click", closeCart);
  cartBackdrop.addEventListener("click", closeCart);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && cartEl.classList.contains("open")) closeCart();
  });

  renderCart(); // contador al cargar (carrito persistido)
})();
