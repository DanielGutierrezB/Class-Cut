'use strict';
/**
 * captura.js — El audio que entra, escrito a disco mientras entra.
 *
 * La ventana abre el dispositivo (es la única que puede: `getUserMedia` vive en
 * el navegador) y manda el PCM para acá. Este archivo solo escribe, y escribe de
 * la forma más aburrida posible a propósito: un WAV de 16 bits, sin buffers
 * grandes ni compresión, porque lo que se está grabando no se puede repetir.
 *
 * **La cabecera se reescribe en cada pedazo.** Un WAV declara en sus primeros 44
 * bytes cuánto mide, y eso no se sabe hasta cerrarlo. Si la app se cayera con la
 * cabecera en cero, el archivo tendría el audio adentro y ningún programa lo
 * abriría.
 *
 * Se hacía cada tres segundos, que parecía suficiente y no lo era: el ciclo de
 * señales pide justo los últimos segundos de audio, y ffmpeg le cree a la
 * cabecera, así que pedía un tramo que el archivo todavía declaraba inexistente y
 * se llevaba un WAV vacío. Whisper sobre un WAV vacío termina bien y no escribe
 * nada, y lo que se veía era "no dejó un JSON legible" cada pocos segundos —con
 * las señales de ese tramo perdidas—. Lo encontró `tools/simular-grabacion.js`
 * pasándole el Live-Mix de una clase de verdad.
 *
 * Escribirla siempre son 44 bytes más por pedazo, unas doce veces por segundo.
 * No se nota, y a cambio el archivo es legible en todo momento y por cualquiera.
 *
 * **Una sesión, un archivo.** Parar de escuchar y seguir abre otro WAV en vez de
 * dejar un hueco de silencio adentro de uno: el hueco sería mentira —el reloj de
 * pared siguió andando pero el archivo no— y cualquier tiempo medido sobre él
 * quedaría corrido de ahí en adelante. Los tiempos viven en la hora del día
 * (`notas-vivo.js`), no en la posición dentro del archivo.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const paths = require('./paths');
const workspace = require('./workspace');

const BITS = 16;

const sesiones = new Map();
let proxima = 0;

function cabecera(bytesDeDatos, sampleRate, canales) {
    const buf = Buffer.alloc(44);
    const bloque = canales * BITS / 8;
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + bytesDeDatos, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM sin comprimir
    buf.writeUInt16LE(canales, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * bloque, 28);
    buf.writeUInt16LE(bloque, 32);
    buf.writeUInt16LE(BITS, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(bytesDeDatos, 40);
    return buf;
}

/**
 * Abre una sesión de escucha.
 *
 * @param {object} params { dir, nombre, sampleRate, canales, desdeMs }
 * @returns {{id:number, archivo:string, desdeMs:number}}
 */
function abrir(params) {
    const p = params || {};
    const dir = p.dir;
    if (!dir) throw new Error('Falta la carpeta donde escribir el audio.');
    workspace.ensureDir(dir);

    const sampleRate = Math.round(p.sampleRate || 48000);
    const canales = Math.max(1, Math.min(2, Math.round(p.canales || 1)));
    const id = ++proxima;
    const archivo = path.join(dir, `${workspace.safeName(p.nombre || 'escucha')}-${id}.wav`);

    const fd = fs.openSync(archivo, 'w');
    fs.writeSync(fd, cabecera(0, sampleRate, canales), 0, 44, 0);

    const sesion = {
        id,
        archivo,
        fd,
        sampleRate,
        canales,
        bytes: 0,
        desdeMs: Number(p.desdeMs) || Date.now(),
        hastaMs: null
    };
    sesiones.set(id, sesion);
    return { id, archivo, desdeMs: sesion.desdeMs, sampleRate, canales };
}

/**
 * Escribe un pedazo de PCM.
 *
 * Llega en 16 bits ya convertido por la ventana: el `AudioWorklet` entrega coma
 * flotante y pasarla así por el puente duplicaría el tráfico para escribir la
 * mitad. La conversión es una multiplicación, y allá el dato ya está en la mano.
 *
 * @param {number} id
 * @param {Buffer|Uint8Array} pcm
 * @returns {{bytes:number, segundos:number}}
 */
function escribir(id, pcm) {
    const s = sesiones.get(id);
    if (!s) throw new Error(`No hay sesión de captura ${id}.`);
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer || pcm);
    if (buf.length) {
        fs.writeSync(s.fd, buf, 0, buf.length, 44 + s.bytes);
        s.bytes += buf.length;
        fs.writeSync(s.fd, cabecera(s.bytes, s.sampleRate, s.canales), 0, 44, 0);
    }
    return { bytes: s.bytes, segundos: segundosDe(s) };
}

function segundosDe(s) {
    return s.bytes / (s.sampleRate * s.canales * BITS / 8);
}

/** Cierra la sesión dejando la cabecera con el tamaño real. */
function cerrar(id, hastaMs) {
    const s = sesiones.get(id);
    if (!s) return null;
    try {
        fs.writeSync(s.fd, cabecera(s.bytes, s.sampleRate, s.canales), 0, 44, 0);
    } finally {
        try { fs.closeSync(s.fd); } catch (e) { /* ya estaba cerrado */ }
    }
    s.hastaMs = Number(hastaMs) || Date.now();
    sesiones.delete(id);
    return resumen(s);
}

function resumen(s) {
    return {
        id: s.id,
        archivo: s.archivo,
        desdeMs: s.desdeMs,
        hastaMs: s.hastaMs,
        sampleRate: s.sampleRate,
        canales: s.canales,
        segundos: Math.round(segundosDe(s) * 100) / 100
    };
}

/** Cierra lo que haya quedado abierto, con la cabecera al día: es lo de salir. */
function cerrarTodo() {
    return [...sesiones.keys()].map(id => cerrar(id));
}

/**
 * Dónde cae un momento del reloj de pared dentro de una sesión.
 *
 * @returns {number|null} segundos desde el principio del archivo, o null si ese
 *   momento no está en esta sesión
 */
function posicionDe(sesion, paredMs) {
    if (!sesion || sesion.desdeMs == null) return null;
    const seg = (Number(paredMs) - sesion.desdeMs) / 1000;
    if (seg < 0) return null;
    const total = sesion.segundos != null ? sesion.segundos : Infinity;
    if (seg > total + 0.5) return null;
    return seg;
}

/**
 * De varias sesiones de captura, la que tiene grabado ese momento.
 *
 * Una clase puede quedar en más de un archivo —parar y seguir abre otro WAV— y
 * una toma vive en uno solo. Sirve tanto para la grabación en curso (con el
 * archivo abierto) como para volver a leer una clase terminada desde lo que
 * quedó en el disco.
 *
 * @param {Array} sesiones como las deja `cerrar` o como está la abierta
 * @returns {object|null}
 */
function laQueContiene(sesiones, paredMs) {
    return (sesiones || []).find(s => posicionDe(s, paredMs) != null) || null;
}

/**
 * Corta un pedazo del audio capturado y lo deja como lo quiere Whisper.
 *
 * 16 kHz mono, que es lo que el motor ya usa en post: Whisper acepta cualquier
 * cosa y la convierte por dentro, pero tarda cuatro veces más (medido en
 * `transcribe.js`).
 *
 * @param {object} params { sesion, desdeMs, hastaMs, margenSec }
 * @returns {{archivo:string, desdeSec:number}|null}
 */
function recorte(params) {
    const p = params || {};
    const ffmpeg = paths.ffmpeg();
    if (!ffmpeg.path || !p.sesion) return null;

    const margen = p.margenSec || 0;
    const desde = posicionDe(p.sesion, p.desdeMs);
    const hasta = posicionDe(p.sesion, p.hastaMs);
    if (desde == null || hasta == null || hasta <= desde) return null;

    const ini = Math.max(0, desde - margen);
    const dur = (hasta - ini) + margen;
    const destino = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-vivo-')), 'toma.wav');

    const r = spawnSync(ffmpeg.path, [
        '-v', 'error', '-y',
        '-ss', String(ini),
        '-t', String(dur),
        '-i', p.sesion.archivo,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        destino
    ], { encoding: 'utf8' });

    if (r.status !== 0 || !fs.existsSync(destino)) return null;
    // `desdeSec` es qué momento del archivo quedó en el segundo 0 del recorte:
    // sin eso, los tiempos que devuelve Whisper no se pueden llevar a la hora del
    // día y todo el reloj se cae.
    return { archivo: destino, desdeSec: ini };
}

function tirar(recortado) {
    if (!recortado || !recortado.archivo) return;
    try {
        fs.rmSync(path.dirname(recortado.archivo), { recursive: true, force: true });
    } catch (e) { /* da igual */ }
}

module.exports = {
    cabecera,
    abrir,
    escribir,
    cerrar,
    cerrarTodo,
    posicionDe,
    laQueContiene,
    recorte,
    tirar
};
