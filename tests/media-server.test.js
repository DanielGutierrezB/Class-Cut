'use strict';
/**
 * Que el reproductor pueda pedir un pedazo de un archivo enorme y que no pueda
 * pedir nada más.
 *
 * Las dos mitades importan igual. Si los rangos se calculan mal, el video se
 * queda negro esperando bytes que no llegan —cuesta media hora darse cuenta de
 * por qué—. Y si la lista de permitidas no se respeta, la ventana pasa a poder
 * leer cualquier archivo del disco por url.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const media = require('../engine/media-server');

/** Un pedido como el que arma Chromium para un video. */
function pedido(file, range) {
    return {
        url: `clase://media/${encodeURIComponent(file)}`,
        headers: new Headers(range ? { Range: range } : {})
    };
}

function archivoDe(bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-media-'));
    const file = path.join(dir, 'camara 1.mp4');
    fs.writeFileSync(file, Buffer.alloc(bytes, 9));
    return file;
}

module.exports = async t => {

    t.group('leer el pedido de rango');

    t.test('un tramo con principio y fin', () => {
        t.deep(media.pedazoPedido('bytes=100-199', 1000), { desde: 100, hasta: 199 });
    });

    t.test('sin fin se sirve hasta el final del archivo', () => {
        t.deep(media.pedazoPedido('bytes=900-', 1000), { desde: 900, hasta: 999 });
    });

    t.test('los últimos bytes, que es donde este MP4 tiene su índice', () => {
        // Los archivos del Rodecaster traen el `moov` al final: lo primero que
        // hace Chromium es pedir la cola. Si esto se calcula mal, el video no
        // abre nunca.
        t.deep(media.pedazoPedido('bytes=-500', 1000), { desde: 500, hasta: 999 });
    });

    t.test('pedir más de lo que hay se recorta al tamaño real', () => {
        t.deep(media.pedazoPedido('bytes=0-99999', 1000), { desde: 0, hasta: 999 });
    });

    t.test('sin cabecera de rango no hay tramo', () => {
        t.deep(media.pedazoPedido(undefined, 1000), null);
        t.deep(media.pedazoPedido('', 1000), null);
        t.deep(media.pedazoPedido('bytes=-', 1000), null);
    });

    t.test('empezar más allá del final es fuera de rango', () => {
        t.ok(media.pedazoPedido('bytes=1000-', 1000).fueraDeRango);
    });

    t.group('servir el archivo');

    t.test('sin rango va entero y avisa que acepta rangos', async () => {
        // Sin `Accept-Ranges` Chromium ni intenta buscar, y el reproductor
        // no podría saltar de bloque a bloque.
        const file = archivoDe(1000);
        const res = media.responder(pedido(file), new Set([file]));
        t.eq(res.status, 200);
        t.eq(res.headers.get('accept-ranges'), 'bytes');
        t.eq(res.headers.get('content-length'), '1000');
        t.eq(res.headers.get('content-type'), 'video/mp4');
    });

    t.test('con rango contesta 206 y solo ese pedazo', async () => {
        const file = archivoDe(1000);
        const res = media.responder(pedido(file, 'bytes=100-199'), new Set([file]));
        t.eq(res.status, 206);
        t.eq(res.headers.get('content-range'), 'bytes 100-199/1000');
        t.eq(res.headers.get('content-length'), '100');
        const cuerpo = await res.arrayBuffer();
        t.eq(cuerpo.byteLength, 100, 'tiene que mandar 100 bytes, no el archivo entero');
    });

    t.test('el pedazo que llega es el que se pidió', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-media-'));
        const file = path.join(dir, 'v.mp4');
        fs.writeFileSync(file, Buffer.from('0123456789'));
        const res = media.responder(pedido(file, 'bytes=3-5'), new Set([file]));
        t.eq(Buffer.from(await res.arrayBuffer()).toString(), '345');
    });

    t.test('pedir más allá del final se contesta 416 y no se cuelga', async () => {
        const file = archivoDe(1000);
        const res = media.responder(pedido(file, 'bytes=5000-'), new Set([file]));
        t.eq(res.status, 416);
        t.eq(res.headers.get('content-range'), 'bytes */1000');
    });

    t.group('lo que no se puede pedir');

    t.test('un archivo que no está en la lista no se sirve', async () => {
        const file = archivoDe(100);
        const res = media.responder(pedido(file), new Set());
        t.eq(res.status, 403);
    });

    t.test('no se puede salir de la lista con ../', async () => {
        // Si esto pasara, la ventana podría leer cualquier archivo del disco.
        const file = archivoDe(100);
        const vecino = path.join(path.dirname(file), '..', 'otro.mp4');
        const res = media.responder(pedido(vecino), new Set([file]));
        t.eq(res.status, 403);
    });

    t.test('estar en la lista pero ya no en el disco da 404, no un cuelgue', async () => {
        const file = archivoDe(100);
        fs.unlinkSync(file);
        const res = media.responder(pedido(file), new Set([file]));
        t.eq(res.status, 404);
    });

    t.test('los nombres con espacios y guiones llegan enteros', async () => {
        // "Clase 02 - Default_2026-08-18" es el nombre real de las carpetas.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-media-'));
        const sub = path.join(dir, 'Clase 02 - Default_2026-08-18_2_13-56-35');
        fs.mkdirSync(sub);
        const file = path.join(sub, '1_CAMERA 1.mp4');
        fs.writeFileSync(file, Buffer.alloc(50, 1));
        const res = media.responder(pedido(file), new Set([file]));
        t.eq(res.status, 200);
    });
};
