// Empaquetador ZIP mínimo, sin dependencias.
//
// POR QUÉ NO SE USA `Compress-Archive` DE POWERSHELL
// Windows PowerShell 5.1 escribe los nombres de entrada con **barra invertida**
// (`assets\bloom.css`). El formato ZIP exige barra normal, y los descompresores
// estrictos —el de Shopify entre ellos— o rechazan el fichero o lo extraen como
// si fuera un solo archivo con barras en el nombre, dejando un tema sin carpetas.
// El síntoma en el panel es «no se pudo subir el tema» sin más explicación, que
// es de los errores más caros de diagnosticar.
//
// Aquí se escribe el ZIP a mano con `deflateRaw` de zlib, que ya viene en Node.
// Cien líneas y ninguna dependencia, a cambio de control total sobre el formato.

import { deflateRawSync } from "node:zlib";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/* ─────────────────────────── CRC-32 ─────────────────────────── */

/** Tabla estándar del polinomio 0xEDB88320, la que usa ZIP. */
const TABLA_CRC = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[i] = c >>> 0;
  }
  return tabla;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = TABLA_CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ─────────────────────────── fecha DOS ─────────────────────────── */

/** El ZIP guarda la fecha en el formato de MS-DOS: dos palabras de 16 bits. */
function fechaDos(fecha) {
  const anio = Math.max(1980, fecha.getFullYear());
  return {
    hora: (fecha.getHours() << 11) | (fecha.getMinutes() << 5) | (Math.floor(fecha.getSeconds() / 2) & 0x1f),
    dia: ((anio - 1980) << 9) | ((fecha.getMonth() + 1) << 5) | fecha.getDate(),
  };
}

/* ─────────────────────────── recorrido ─────────────────────────── */

/**
 * Lista todos los ficheros de una carpeta, con la ruta relativa ya en formato
 * ZIP (barras normales). Se ordena para que el zip sea reproducible: dos
 * ejecuciones seguidas con el mismo contenido dan el mismo listado.
 */
export async function listarRecursivo(raiz, prefijo = "") {
  const entradas = await readdir(path.join(raiz, prefijo), { withFileTypes: true });
  const salida = [];

  for (const entrada of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativa = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
    if (entrada.isDirectory()) {
      salida.push(...(await listarRecursivo(raiz, relativa)));
    } else if (entrada.isFile()) {
      salida.push(relativa);
    }
  }
  return salida;
}

/* ─────────────────────────── el zip ─────────────────────────── */

/**
 * Empaqueta el contenido de `carpeta` con las rutas colgando de la RAÍZ del zip.
 *
 * Que cuelguen de la raíz importa: Shopify rechaza un zip que empiece por una
 * carpeta contenedora. Dentro tiene que ver `layout/`, `sections/`, `assets/`…
 * directamente.
 */
export async function empaquetarCarpeta(carpeta, destino) {
  const ficheros = await listarRecursivo(carpeta);
  const trozos = [];
  const central = [];
  let desplazamiento = 0;
  let bytesOriginales = 0;

  for (const relativa of ficheros) {
    const completa = path.join(carpeta, relativa);
    const datos = await readFile(completa);
    const info = await stat(completa);
    const { hora, dia } = fechaDos(info.mtime);

    bytesOriginales += datos.length;
    const crc = crc32(datos);

    // Un fichero ya comprimido (jpg, png) no gana nada al desinflarse y a veces
    // crece. Se guarda tal cual (método 0) cuando comprimir no compensa.
    const comprimido = deflateRawSync(datos, { level: 9 });
    const usarDeflate = comprimido.length < datos.length;
    const cuerpo = usarDeflate ? comprimido : datos;
    const metodo = usarDeflate ? 8 : 0;

    const nombre = Buffer.from(relativa, "utf8");
    // Bit 11 = los nombres van en UTF-8. Sin él, un fichero con acento se
    // extraería con el nombre roto.
    const banderas = 0x0800;

    const cabecera = Buffer.alloc(30);
    cabecera.writeUInt32LE(0x04034b50, 0); // firma de cabecera local
    cabecera.writeUInt16LE(20, 4); // versión necesaria (2.0)
    cabecera.writeUInt16LE(banderas, 6);
    cabecera.writeUInt16LE(metodo, 8);
    cabecera.writeUInt16LE(hora, 10);
    cabecera.writeUInt16LE(dia, 12);
    cabecera.writeUInt32LE(crc, 14);
    cabecera.writeUInt32LE(cuerpo.length, 18);
    cabecera.writeUInt32LE(datos.length, 22);
    cabecera.writeUInt16LE(nombre.length, 26);
    cabecera.writeUInt16LE(0, 28); // sin campo extra

    trozos.push(cabecera, nombre, cuerpo);

    const entradaCentral = Buffer.alloc(46);
    entradaCentral.writeUInt32LE(0x02014b50, 0); // firma del directorio central
    entradaCentral.writeUInt16LE(20, 4); // creado por
    entradaCentral.writeUInt16LE(20, 6); // versión necesaria
    entradaCentral.writeUInt16LE(banderas, 8);
    entradaCentral.writeUInt16LE(metodo, 10);
    entradaCentral.writeUInt16LE(hora, 12);
    entradaCentral.writeUInt16LE(dia, 14);
    entradaCentral.writeUInt32LE(crc, 16);
    entradaCentral.writeUInt32LE(cuerpo.length, 20);
    entradaCentral.writeUInt32LE(datos.length, 24);
    entradaCentral.writeUInt16LE(nombre.length, 28);
    entradaCentral.writeUInt16LE(0, 30); // extra
    entradaCentral.writeUInt16LE(0, 32); // comentario
    entradaCentral.writeUInt16LE(0, 34); // disco
    entradaCentral.writeUInt16LE(0, 36); // atributos internos
    entradaCentral.writeUInt32LE(0, 38); // atributos externos
    entradaCentral.writeUInt32LE(desplazamiento, 42);

    central.push(entradaCentral, nombre);
    desplazamiento += cabecera.length + nombre.length + cuerpo.length;
  }

  const bloqueCentral = Buffer.concat(central);

  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); // firma de fin de directorio central
  fin.writeUInt16LE(0, 4); // número de disco
  fin.writeUInt16LE(0, 6); // disco donde empieza el directorio
  fin.writeUInt16LE(ficheros.length, 8);
  fin.writeUInt16LE(ficheros.length, 10);
  fin.writeUInt32LE(bloqueCentral.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  fin.writeUInt16LE(0, 20); // sin comentario

  const zip = Buffer.concat([...trozos, bloqueCentral, fin]);
  await writeFile(destino, zip);

  return { ficheros: ficheros.length, bytes: zip.length, bytesOriginales };
}
