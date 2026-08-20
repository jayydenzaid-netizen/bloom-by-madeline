import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

// Nunca cachear: cerrar sesión tiene que ejecutarse siempre de verdad.
export const dynamic = "force-dynamic";

/**
 * Cierra la sesión y devuelve al login.
 *
 * Solo POST: si fuera GET, cualquier precarga de enlace del navegador (o una
 * imagen incrustada en un correo) echaría a Madeline de su propio panel.
 * El 303 obliga al navegador a pedir el login con GET tras el POST.
 */
export async function POST(request: Request) {
  await destroySession();
  return NextResponse.redirect(new URL("/admin/login", request.url), 303);
}
