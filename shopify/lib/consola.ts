// Salida por consola de los scripts de Shopify.
//
// Está en su propio fichero por dos razones prácticas. La primera: los tres
// scripts (verificar, importar, migrar) hablan el mismo idioma visual, y si cada
// uno define sus colores acaban divergiendo. La segunda, menos evidente: los
// códigos ANSI se escriben aquí con `\x1b` y NUNCA con el carácter de escape
// crudo — un byte 0x1B invisible dentro del código fuente sobrevive mal a copias,
// editores y revisiones de diff.
//
// Si la salida no va a una terminal (por ejemplo `npm run ... > registro.txt`),
// los colores se apagan solos: un fichero lleno de "[32m" no lo lee nadie.

const HAY_COLOR =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

function tinte(codigo: string): (texto: string) => string {
  if (!HAY_COLOR) return (texto: string) => texto;
  return (texto: string) => `\x1b[${codigo}m${texto}\x1b[0m`;
}

export const verde = tinte("32");
export const rojo = tinte("31");
export const amarillo = tinte("33");
export const gris = tinte("90");
export const negrita = tinte("1");
export const cian = tinte("36");

/** Una línea con marca de correcto. */
export const bien = (texto: string): void => console.log(`  ${verde("✓")} ${texto}`);
/** Una línea con marca de fallo. */
export const mal = (texto: string): void => console.log(`  ${rojo("✗")} ${texto}`);
/** Algo que no impide seguir pero que hay que leer. */
export const ojo = (texto: string): void => console.log(`  ${amarillo("!")} ${texto}`);
/** Detalle secundario, sangrado bajo la línea anterior. */
export const nota = (texto: string): void => console.log(`    ${gris(texto)}`);
/** Cabecera de sección. */
export const titulo = (texto: string): void => console.log(`\n${negrita(texto)}`);
/** Regla horizontal. */
export const regla = (ancho = 58): void => console.log(gris("─".repeat(ancho)));

/**
 * Barra de progreso de una línea, para las migraciones largas.
 * Se reescribe sobre sí misma en terminal; fuera de terminal imprime hitos, para
 * que un registro redirigido a fichero no acabe con diez mil líneas iguales.
 */
export function progreso(hechos: number, total: number, etiqueta: string): void {
  if (total <= 0) return;

  if (!process.stdout.isTTY) {
    // Un hito cada 10% y siempre el último.
    const paso = Math.max(1, Math.floor(total / 10));
    if (hechos % paso !== 0 && hechos !== total) return;
    console.log(`  ${hechos}/${total} · ${etiqueta}`);
    return;
  }

  const ancho = 24;
  const llenos = Math.round((hechos / total) * ancho);
  const barra = "█".repeat(llenos) + "░".repeat(ancho - llenos);
  const porcentaje = String(Math.round((hechos / total) * 100)).padStart(3);
  const texto = `  ${barra} ${porcentaje}%  ${hechos}/${total}  ${etiqueta}`;

  process.stdout.write(`\r${" ".repeat(Math.min(120, process.stdout.columns || 100))}\r`);
  process.stdout.write(texto.slice(0, (process.stdout.columns || 100) - 1));
  if (hechos === total) process.stdout.write("\n");
}
