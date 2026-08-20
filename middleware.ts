import { NextResponse, type NextRequest } from "next/server";

/**
 * Portero del panel.
 *
 * Existe por un motivo de seguridad medido, no por gusto: en Next 15 un layout
 * NO recibe el pathname y, si decide "no pintar children", la página hija se
 * renderiza igual y viaja entera dentro del payload RSC de la respuesta. Es
 * decir: sin este fichero, una petición sin sesión a /admin devolvía el HTML
 * del login pero con el dashboard completo (ventas, pedidos) incrustado en el
 * flight payload. Verificado con curl, no supuesto.
 *
 * Aquí se corta antes: sin cookie de sesión no se llega ni a renderizar. Y se
 * inyecta `x-pathname` para que app/admin/layout.tsx pueda hacer un redirect de
 * verdad (que aborta el render) sabiendo si está o no en el login.
 *
 * Esto NO valida la sesión — el runtime del middleware no puede hablar con
 * Prisma. La validación real sigue estando en getAdmin() dentro del layout y de
 * cada página; esto solo evita que la petición anónima llegue a renderizarse.
 *
 * El nombre de la cookie está duplicado a mano porque importar lib/auth.ts
 * arrastraría node:crypto y Prisma al middleware, que no se pueden ejecutar ahí.
 * Si cambia SESSION_COOKIE en lib/auth.ts, hay que cambiarlo aquí.
 */
const SESSION_COOKIE = "bloom_admin";
const LOGIN_PATH = "/admin/login";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const headers = new Headers(request.headers);
  headers.set("x-pathname", pathname);

  const esLogin = pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);
  const tieneCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!esLogin && !tieneCookie) {
    return NextResponse.redirect(new URL(LOGIN_PATH, request.url));
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Solo el panel. El escaparate no pasa por aquí para no pagar el coste.
  matcher: ["/admin", "/admin/:path*"],
};
