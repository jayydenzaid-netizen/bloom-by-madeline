import { ETIQUETA_PROVEEDOR, type MetodoOnline } from "./config";
import type { CodigoDiagnostico } from "./tipos";

/**
 * Un código de diagnóstico convertido en algo que la dueña pueda HACER.
 *
 * La regla de este fichero: si un caso no se puede cerrar con una instrucción
 * concreta, no merece un código propio. «Square rechazó el token» es verdad y no
 * sirve de nada; «ese token caducó, saca uno nuevo en developer.squareup.com →
 * tu aplicación → Production» sí.
 *
 * Vive separado de la pantalla porque el mismo diagnóstico se guarda (en
 * `paymentsEstado`) y se vuelve a enseñar días después: el texto tiene que poder
 * reescribirse sin tocar lo guardado, y por eso lo guardado es el CÓDIGO.
 *
 * Sustituye a la expresión regular sobre prosa en español que decidía esto antes
 * (`/PRUEBAS \(Sandbox\)/.test(detalle)`), que se rompía en silencio en cuanto
 * alguien cambiaba una tilde del mensaje.
 */

export type Diagnostico = {
  /** Qué pasa, en una frase. */
  titulo: string;
  /** Qué tiene que hacer ella. Vacío si no hay nada que hacer. */
  queHacer: string;
  /** `true` = esto no se arregla esperando. */
  urgente: boolean;
};

/** Dónde saca cada proveedor sus credenciales, para poder decirlo sin adivinar. */
const DONDE: Record<MetodoOnline, string> = {
  stripe: "dashboard.stripe.com → Desarrolladores → Claves de API",
  paypal: "developer.paypal.com → Apps & Credentials → pestaña Live",
  square: "developer.squareup.com → tu aplicación → Production",
};

export function explicarDiagnostico(
  proveedor: MetodoOnline,
  codigo: CodigoDiagnostico,
): Diagnostico {
  const marca = ETIQUETA_PROVEEDOR[proveedor];
  const donde = DONDE[proveedor];

  switch (codigo) {
    case "ok":
      return { titulo: "La conexión funciona.", queHacer: "", urgente: false };

    case "token-caducado":
      return {
        titulo: `Ese token de ${marca} está caducado.`,
        queHacer: `No es que esté mal escrito: ha vencido. Entra en ${donde}, genera uno nuevo y pégalo aquí.`,
        urgente: true,
      };

    case "token-revocado":
      return {
        titulo: `Ese token de ${marca} fue revocado.`,
        queHacer: `Alguien lo anuló desde el panel de ${marca} (o se regeneró la aplicación). Entra en ${donde}, saca uno nuevo y pégalo aquí.`,
        urgente: true,
      };

    case "permisos-insuficientes":
      return {
        titulo: `Las llaves de ${marca} valen, pero les faltan permisos para cobrar.`,
        queHacer: `En ${donde}, revisa los permisos de la aplicación: necesita poder crear cobros y leer pedidos. Después vuelve a comprobar aquí.`,
        urgente: true,
      };

    case "aplicacion-desactivada":
      return {
        titulo: `La aplicación de ${marca} está desactivada.`,
        queHacer: `${marca} la ha suspendido o alguien la apagó. Entra en ${donde} y comprueba el estado de la aplicación.`,
        urgente: true,
      };

    case "entorno-cruzado":
      return {
        titulo: `Ese token es del otro entorno de ${marca}.`,
        queHacer:
          "Tienes un token de pruebas con el entorno en «Real», o al revés. Dos salidas: cambia el entorno para ensayar sin cobrar, o pega el token real para cobrar de verdad.",
        urgente: true,
      };

    case "sin-locales":
      return {
        titulo: `El token vale, pero esa cuenta de ${marca} no tiene ningún local activo.`,
        queHacer: `Entra en ${marca} y activa tu local (el de la boutique). Sin local no hay dónde ingresar el cobro.`,
        urgente: true,
      };

    case "local-ajeno":
      return {
        titulo: "El identificador de local guardado no es de esta cuenta.",
        queHacer:
          "Deja el campo del local vacío y vuelve a comprobar: si la cuenta tiene un solo local, se rellena solo con el correcto.",
        urgente: true,
      };

    case "llave-no-secreta":
      return {
        titulo: "Esa es la llave publicable, no la secreta.",
        queHacer: `La publicable (empieza por pk_) no puede cobrar. En ${donde}, copia la que empieza por sk_.`,
        urgente: true,
      };

    case "sin-respuesta":
      return {
        titulo: `No pudimos hablar con ${marca}.`,
        queHacer:
          // No se afirma si el cobro está encendido: este texto no sabe si lo
          // estaba, y decirlo cuando no lo está contradice a los botones de su
          // propia tarjeta.
          "Puede ser un bajón suyo o de la red. No se ha tocado nada —ni tus llaves ni si se ofrece o no—: vuelve a comprobar en un rato.",
        urgente: false,
      };

    case "credencial-invalida":
    default:
      return {
        titulo: `${marca} rechazó esas llaves.`,
        queHacer: `Comprueba que las copiaste enteras y del sitio correcto: ${donde}.`,
        urgente: true,
      };
  }
}

/** «hace 2 horas», «hace 3 días», «ahora mismo». Para la línea de estado. */
export function haceCuanto(iso: string, ahora: Date): string {
  const cuando = Date.parse(iso);
  if (Number.isNaN(cuando)) return "en algún momento";
  const minutos = Math.floor((ahora.getTime() - cuando) / 60_000);
  if (minutos < 2) return "ahora mismo";
  if (minutos < 60) return `hace ${minutos} minutos`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} ${horas === 1 ? "hora" : "horas"}`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return `hace ${dias} ${dias === 1 ? "día" : "días"}`;
  const meses = Math.floor(dias / 30);
  return `hace ${meses} ${meses === 1 ? "mes" : "meses"}`;
}
