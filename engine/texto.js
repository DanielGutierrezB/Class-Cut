'use strict';
/**
 * texto.js — Comparar palabras que Whisper no escribe dos veces igual.
 *
 * Es una función y va en su archivo porque la necesitan dos módulos que no
 * tienen nada más en común: `clap-detect.js` busca "clase 7" en el transcript de
 * post y `notas-vivo.js` compara arranques de tomas en vivo. Antes cada uno
 * tenía la suya, idénticas carácter por carácter, y la próxima corrección se
 * habría hecho en una sola.
 */

/**
 * Texto comparable: sin signos, sin mayúsculas y sin acentos.
 *
 * Whisper escribe "PROM", "prom" y "prómpt" para la misma palabra según el
 * tramo; comparando así, las tres son la misma.
 */
function norm(texto) {
    return String(texto == null ? '' : texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

module.exports = { norm };
