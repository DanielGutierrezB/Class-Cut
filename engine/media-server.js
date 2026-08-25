'use strict';
/**
 * media-server.js — Le pasa los archivos de cámara a la ventana, por pedazos.
 *
 * El reproductor necesita saltar a cualquier momento de un MP4 de 15 GB. Eso
 * solo funciona si el que sirve el archivo entiende de rangos: Chromium pide
 * "dame del byte 4.100.000.000 al 4.101.000.000", y si le contestan con el
 * archivo entero desde el principio, se queda esperando para siempre. Es
 * exactamente lo que pasa con `net.fetch` sobre `file://`, que ignora el
 * `Range` y devuelve un 200 con todo: el video nunca llega a mostrar un cuadro.
 *
 * Así que las respuestas se arman a mano: 206 con `Content-Range` y un stream
 * del pedazo justo. Se lee del disco solo lo pedido, que es lo que hace que
 * saltar de bloque a bloque cueste milisegundos y no gigabytes.
 *
 * La lista de rutas permitidas es una frontera de seguridad, no una comodidad:
 * la ventana pide por url, y sin lista podría pedir cualquier archivo del disco.
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const TIPOS = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg'
};

/** `bytes=100-199`, `bytes=100-` o `bytes=-500` → índices concretos. */
function pedazoPedido(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!match) return null;

    const [, desdeTxt, hastaTxt] = match;
    if (desdeTxt === '' && hastaTxt === '') return null;

    // `bytes=-500` son los últimos 500, que es como Chromium busca el índice de
    // un MP4 cuando el `moov` quedó al final del archivo.
    if (desdeTxt === '') {
        const cuantos = Math.min(Number(hastaTxt), size);
        return cuantos > 0 ? { desde: size - cuantos, hasta: size - 1 } : null;
    }

    const desde = Number(desdeTxt);
    if (desde >= size) return { fueraDeRango: true };
    const hasta = hastaTxt === '' ? size - 1 : Math.min(Number(hastaTxt), size - 1);
    return hasta < desde ? { fueraDeRango: true } : { desde, hasta };
}

/**
 * Contesta un pedido del reproductor.
 *
 * @param {Request} request
 * @param {Set<string>} permitidas rutas absolutas que se pueden servir
 * @returns {Response}
 */
function responder(request, permitidas) {
    let file;
    try {
        // La ruta viaja codificada entera para que los espacios y acentos de
        // "Clase 02 - Default…" lleguen tal cual.
        const url = new URL(request.url);
        file = path.resolve(decodeURIComponent(url.pathname.replace(/^\//, '')));
    } catch (e) {
        return new Response('url ilegible', { status: 400 });
    }

    if (!permitidas.has(file)) {
        return new Response('no permitido', { status: 403 });
    }

    let size;
    try {
        size = fs.statSync(file).size;
    } catch (e) {
        return new Response('no está', { status: 404 });
    }

    const tipo = TIPOS[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const rango = pedazoPedido(request.headers.get('range'), size);

    if (rango && rango.fueraDeRango) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
        });
    }

    const desde = rango ? rango.desde : 0;
    const hasta = rango ? rango.hasta : size - 1;
    const cuerpo = Readable.toWeb(fs.createReadStream(file, { start: desde, end: hasta }));

    return new Response(cuerpo, {
        status: rango ? 206 : 200,
        headers: Object.assign({
            'Content-Type': tipo,
            'Content-Length': String(hasta - desde + 1),
            // Sin esto Chromium ni intenta pedir por rangos y no deja buscar.
            'Accept-Ranges': 'bytes'
        }, rango ? { 'Content-Range': `bytes ${desde}-${hasta}/${size}` } : {})
    });
}

module.exports = { responder, pedazoPedido, TIPOS };
