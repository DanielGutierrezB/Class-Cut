'use strict';
/**
 * texto.js — Comparar palabras que Whisper no escribe dos veces igual.
 *
 * Es una función y va en su archivo porque la necesitan dos módulos que no
 * tienen nada más en común: `clap-detect.js` busca "clase 7" en el transcript de
 * post y `notas-vivo.js` compara arranques de tomas en vivo. Antes cada uno
 * tenía la suya, idénticas carácter por carácter, y la próxima corrección se
 * habría hecho en una sola.
 *
 * Son dos y no una porque hay dos preguntas: comparar UNA palabra con otra, que
 * es `norm`, y buscar una cita adentro de un texto, que es `aplanar` y necesita
 * las fronteras entre palabras.
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

/**
 * Texto comparable, pero con los espacios puestos.
 *
 * No sirve `norm` para esto: esa saca TODO lo que no sea letra o número,
 * espacios incluidos, así que "o sea" queda en "osea" y coincide dentro de
 * "ósea", y una cita del modelo pegada en una sola palabra coincide en
 * cualquier parte. Cuando lo que se busca es una cita adentro de un texto hacen
 * falta las fronteras.
 *
 * Vivía en `lengua.js`, que fue el primero que tuvo que revisar lo que devuelve
 * un modelo. Bajó acá cuando `empalme.js` necesitó la misma aduana: una segunda
 * copia habría sido dos maneras de decidir si el modelo se inventó una cita.
 */
function aplanar(texto) {
    return String(texto == null ? '' : texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ]+/g, ' ')
        .trim();
}

module.exports = { norm, aplanar };
