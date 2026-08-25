'use strict';
/**
 * registro.js — El diario de la sesión, para poder contar qué pasó.
 *
 * Existe por una razón concreta: cuando algo sale mal, lo único que llega es
 * "no me anduvo". Los `console.log` del proceso principal no se ven desde la
 * app —salvo que se la abra desde la terminal, que nadie hace— y los de la
 * ventana viven en un inspector que hay que saber abrir. Con esto, reportar un
 * problema es apretar un botón y adjuntar un archivo.
 *
 * Tres decisiones que valen el comentario:
 *
 * **Tiene tope.** Una sesión larga con trece clases y cientos de consultas al
 * modelo puede escribir miles de líneas, y un array que solo crece dentro del
 * proceso que además tiene el modelo en memoria es una fuga con buenos modales.
 * Se guardan las últimas `TOPE` y se cuenta cuántas se tiraron, para que el
 * archivo no mienta por omisión.
 *
 * **No lleva secretos.** La clave de Anthropic vive en el Llavero y no puede
 * terminar en un archivo que el editor va a mandar por mail. `sanear` tapa todo
 * campo que se llame como un secreto y todo texto con forma de clave, y lo hace
 * al ANOTAR y no al escribir: si estuviera solo al escribir, el secreto habría
 * vivido en memoria hasta entonces y cualquier volcado lo tendría.
 *
 * **No lleva rutas enteras.** El nombre de usuario y el árbol completo de un
 * disco ajeno no ayudan a entender nada; los dos últimos tramos sí dicen de qué
 * clase se habla. Un log que se puede compartir sin pensarlo se comparte; uno
 * que hay que revisar antes, no.
 *
 * No sabe de Electron a propósito: la ventana anota por IPC y la carpeta de
 * Descargas se la pasa quien llama. Así se puede probar con `node tests/run.js`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cuántas líneas se guardan. Medido: una corrida de 13 clases con el criterio
// encendido anota del orden de 400 líneas, así que 3000 son varias corridas
// enteras y ocupan menos de un mega.
const TOPE = 3000;

// Campos cuyo contenido no se escribe nunca, se llamen como se llamen adentro.
const SECRETOS = /(clave|key|token|secret|password|contrase|authorization|bearer)/i;

// Texto con forma de credencial, por si viaja dentro de un mensaje de error en
// vez de en un campo con nombre.
const PARECE_CLAVE = /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

const OCULTO = '‹oculto›';

// Un valor de texto largo no aporta más que sus primeros caracteres, y sí
// engorda el archivo: un transcript entero en una línea de log no se lee.
const MAX_TEXTO = 240;

const lineas = [];
let descartadas = 0;
let empezoEn = Date.now();

/** Los dos últimos tramos de una ruta: `…/Clase 03/Live-Mix.wav`. */
function acortarRuta(texto) {
    const partes = String(texto).split(path.sep).filter(Boolean);
    if (partes.length <= 2) return texto;
    return `…/${partes.slice(-2).join('/')}`;
}

function pareceRuta(texto) {
    return texto.startsWith('/') || texto.startsWith('~/') || texto.includes(`${path.sep}`);
}

function sanearTexto(texto) {
    let limpio = String(texto).replace(PARECE_CLAVE, OCULTO);
    // La carpeta del usuario aparece en cada ruta y en cada mensaje de error del
    // sistema; sacarla es lo que hace que el archivo se pueda mandar sin leerlo.
    const casa = os.homedir();
    if (casa && casa.length > 3) limpio = limpio.split(casa).join('~');
    if (pareceRuta(limpio) && !limpio.includes(' ')) limpio = acortarRuta(limpio);
    return limpio.length > MAX_TEXTO ? `${limpio.slice(0, MAX_TEXTO)}…` : limpio;
}

/**
 * Los datos de una línea, sin nada que no se pueda compartir.
 *
 * Va en profundidad pero con freno: un objeto que se anida más de tres niveles
 * es un artefacto entero, y eso no es una línea de log.
 */
function sanear(valor, nivel) {
    const profundidad = nivel || 0;
    if (valor == null) return null;
    if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
    if (typeof valor === 'string') return sanearTexto(valor);
    if (profundidad >= 3) return '…';

    if (Array.isArray(valor)) {
        // Diez alcanzan para ver de qué se habla; una lista de trece clases
        // entera por línea no.
        const corta = valor.slice(0, 10).map(v => sanear(v, profundidad + 1));
        return valor.length > 10 ? [...corta, `… y ${valor.length - 10} más`] : corta;
    }
    if (typeof valor !== 'object') return String(valor);

    const salida = {};
    for (const [clave, v] of Object.entries(valor)) {
        salida[clave] = SECRETOS.test(clave) ? OCULTO : sanear(v, profundidad + 1);
    }
    return salida;
}

/**
 * Anota algo que pasó.
 *
 * @param {string} origen 'main' o 'ventana': de qué lado se hizo
 * @param {string} evento qué pasó, en dos palabras ('carpeta.agregada')
 * @param {object} [datos] lo que haga falta para entenderlo
 * @returns {object} la línea, ya saneada
 */
function anotar(origen, evento, datos) {
    const linea = {
        ts: Date.now(),
        origen: String(origen || '?'),
        evento: String(evento || '?'),
        datos: datos == null ? null : sanear(datos, 0)
    };
    lineas.push(linea);
    // Se recorta de a una y no de golpe: así el tope es un techo de verdad y no
    // "el techo más lo que se acumule hasta la próxima limpieza".
    while (lineas.length > TOPE) {
        lineas.shift();
        descartadas++;
    }
    return linea;
}

/** Todo lo anotado, en orden. Copia: nadie de afuera edita el registro. */
function todo() {
    return lineas.slice();
}

function estado() {
    return { lineas: lineas.length, descartadas, tope: TOPE, empezoEn };
}

/** Vaciar. Lo usan las pruebas; la app no borra su propio diario. */
function limpiar() {
    lineas.length = 0;
    descartadas = 0;
    empezoEn = Date.now();
}

function reloj(ts) {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

/** Una línea, tal como se lee en el archivo. */
function comoTexto(linea) {
    const base = `[${reloj(linea.ts)}] ${linea.origen.padEnd(7)} ${linea.evento}`;
    if (linea.datos == null) return base;
    if (typeof linea.datos !== 'object') return `${base} · ${linea.datos}`;
    const partes = Object.entries(linea.datos).map(([k, v]) =>
        `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return partes.length ? `${base} · ${partes.join(' ')}` : base;
}

/**
 * El archivo entero.
 * @param {object} [cabecera] { version, electron, plataforma, arquitectura }
 */
function texto(cabecera) {
    const c = cabecera || {};
    const encabezado = [
        '# Class Cut — registro de la sesión',
        `# generado: ${reloj(Date.now())}`,
        `# sesión desde: ${reloj(empezoEn)}`,
        `# app: ${c.version || '?'} · Electron ${c.electron || '?'} · ${c.plataforma || '?'} ${c.arquitectura || ''}`.trim(),
        `# líneas: ${lineas.length}${descartadas ? ` (se descartaron ${descartadas} por el tope de ${TOPE})` : ''}`,
        '# sin claves ni rutas completas: mirá engine/registro.js',
        ''
    ];
    return `${encabezado.concat(lineas.map(comoTexto)).join('\n')}\n`;
}

/** El nombre del archivo lleva la fecha para que dos descargas no se pisen. */
function nombreDeArchivo(cuando) {
    const d = new Date(cuando || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return `class-cut-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}

/**
 * Escribe el registro en una carpeta. Atómico, como todo lo que escribe la app:
 * un cierre a mitad deja el archivo anterior y no medio archivo que se reporta
 * como si fuera entero.
 *
 * @param {string} dir carpeta destino (Descargas, se la pasa `main.js`)
 * @param {object} [cabecera] lo que va arriba del archivo
 * @returns {{ok: boolean, archivo?: string, lineas?: number, error?: string}}
 */
function escribir(dir, cabecera) {
    if (!dir) return { ok: false, error: 'No se sabe dónde escribir el registro.' };
    const destino = path.join(dir, nombreDeArchivo());
    try {
        fs.mkdirSync(dir, { recursive: true });
        const temporal = `${destino}.tmp-${process.pid}`;
        fs.writeFileSync(temporal, texto(cabecera));
        fs.renameSync(temporal, destino);
        return { ok: true, archivo: destino, lineas: lineas.length };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    TOPE, OCULTO,
    anotar, todo, estado, limpiar, sanear, texto, comoTexto, escribir, nombreDeArchivo
};
