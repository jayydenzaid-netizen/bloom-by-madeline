"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { USUARIO_MAX } from "@/lib/usuario";
import { loginAction, type LoginState } from "./actions";

/**
 * Entrada al panel.
 *
 * Es componente cliente porque el error tiene que aparecer bajo el formulario
 * sin recargar ni viajar por la URL: el usuario de Madeline no pinta nada en la
 * barra de direcciones ni en los logs del servidor.
 *
 * Ojo: esta pantalla también la pinta app/admin/layout.tsx cuando no hay sesión,
 * así que no debe depender de props ni de searchParams.
 */
export default function LoginPage() {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});
  useCorregirUrl();

  return (
    <div className="adm-auth-box">
      <div className="adm-auth-brand">
        <span className="adm-auth-script">Bloom</span>
        <span className="adm-auth-sub">Panel de administración</span>
      </div>

      {state.error ? (
        <p className="adm-auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <form action={formAction} noValidate>
        <div className="adm-field">
          <label className="adm-field-lbl" htmlFor="adm-usuario">
            Usuario
          </label>
          <input
            id="adm-usuario"
            name="usuario"
            type="text"
            autoComplete="username"
            /* El teclado del móvil pone mayúscula a la primera letra por su
               cuenta y el corrector "arregla" nombres que no son palabras: los
               dos han dejado a gente fuera de su propio panel. Aquí se apagan. */
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={USUARIO_MAX}
            autoFocus
            required
            placeholder="tu usuario"
          />
        </div>

        <div className="adm-field">
          <label className="adm-field-lbl" htmlFor="adm-password">
            Contraseña
          </label>
          <input id="adm-password" name="password" type="password" autoComplete="current-password" required />
        </div>

        <SubmitButton />
      </form>

      <p className="adm-auth-foot">
        <a href="/">Volver a la tienda</a>
      </p>
    </div>
  );
}

/**
 * Deja la barra de direcciones en /admin/login cuando esta pantalla se pintó
 * sobre otra URL (Next 15 no le pasa la ruta al layout en una carga directa,
 * así que el layout no puede redirigir en servidor sin arriesgar un bucle).
 *
 * Se usa history.replaceState y no router.replace a propósito: una navegación
 * real volvería a pedir el árbol al servidor y, si algo saliera mal, podría
 * encadenar redirecciones. Aquí solo se corrige la URL, una sola vez.
 */
function useCorregirUrl() {
  const hecho = useRef(false);
  useEffect(() => {
    if (hecho.current) return;
    hecho.current = true;

    // Si este formulario aparece dentro del panel es que la sesión ya vale
    // (el shell solo se pinta con sesión abierta): no se le pide la clave otra
    // vez a quien ya entró, se le manda al panel.
    if (document.querySelector(".adm-shell")) {
      window.location.replace("/admin");
      return;
    }

    if (window.location.pathname !== "/admin/login") {
      window.history.replaceState(null, "", "/admin/login");
    }
  }, []);
}

/** Componente aparte porque useFormStatus solo lee el <form> que lo envuelve. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="adm-btn adm-btn-primary adm-btn-md adm-btn-block" disabled={pending}>
      {pending ? "Entrando…" : "Entrar"}
    </button>
  );
}
