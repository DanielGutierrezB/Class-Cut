'use strict';
/**
 * notas.js — Lo que el editor escribe revisando, y que termina en el XML.
 *
 * Son dos cosas distintas con el mismo destino:
 *
 * - La **nota del bloque**, que vino en el marcador del Rodecaster. Acá se puede
 *   corregir. Para cuando alguien revisa, los cortes ya están validados, así que
 *   cambiar ese texto no mueve ningún borde: solo cambia lo que va a leer el
 *   editor en Premiere.
 * - Los **comentarios**, que son nuevos y cuelgan de un pedazo del transcript.
 *
 * Todo se ancla al tiempo de la grabación original, nunca a la posición en el
 * corte. La grabación no cambia nunca; el corte sí, cada vez que se mueve un
 * borde o se saca un bloque. Anclar al corte sería ver la nota correrse sola.
 *
 * Vive en su propio archivo y no dentro del plan de cortes, porque reprocesar
 * una clase reescribe el plan entero: las notas son lo único acá que no se
 * puede volver a calcular, y perderlas por reprocesar sería imperdonable.
 */

const workspace = require('./workspace');

const VERSION = 1;

/** Un archivo vacío, para no tener que preguntar si existe en todos lados. */
function vacio(sequenceName) {
    return { version: VERSION, sequenceName, bloques: {}, comentarios: [] };
}

function leer(root, sequenceName) {
    const guardado = workspace.readJson(workspace.artifact(root, sequenceName, 'notas'));
    if (!guardado) return vacio(sequenceName);
    return {
        version: guardado.version || VERSION,
        sequenceName,
        bloques: guardado.bloques || {},
        comentarios: Array.isArray(guardado.comentarios) ? guardado.comentarios : []
    };
}

/**
 * Deja el texto en algo que se pueda escribir en un XML y leer en Premiere.
 * Los saltos de línea se van porque el campo del marcador es de una sola línea:
 * si se dejan, el comentario llega partido o directamente cortado.
 */
function limpiar(texto) {
    return String(texto == null ? '' : texto)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

function guardar(root, sequenceName, datos) {
    const limpio = {
        version: VERSION,
        sequenceName,
        updatedAt: new Date().toISOString(),
        bloques: {},
        comentarios: []
    };

    for (const [indice, valor] of Object.entries((datos && datos.bloques) || {})) {
        const n = Number(indice);
        if (!Number.isInteger(n) || n < 0) continue;
        const note = limpiar(valor && valor.note);
        // Una nota vacía no se guarda: eso es "volvé a la que trajo el marcador",
        // no "el editor quiso dejarla en blanco".
        if (note) limpio.bloques[n] = { note };
    }

    for (const c of (datos && datos.comentarios) || []) {
        const comentario = limpiar(c && c.comentario);
        if (!comentario) continue;
        const desde = Number(c.sourceStartSec);
        if (!isFinite(desde)) continue;
        const hasta = Number(c.sourceEndSec);
        limpio.comentarios.push({
            id: c.id || `c${limpio.comentarios.length + 1}-${Date.now()}`,
            sourceStartSec: Math.max(0, desde),
            sourceEndSec: isFinite(hasta) && hasta > desde ? hasta : desde,
            // El texto que estaba seleccionado, para reconocer la nota después
            // aunque el bloque se haya movido.
            texto: limpiar(c.texto).slice(0, 200),
            comentario,
            createdAt: c.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }

    limpio.comentarios.sort((a, b) => a.sourceStartSec - b.sourceStartSec);
    workspace.writeJson(workspace.artifact(root, sequenceName, 'notas'), limpio);
    return limpio;
}

/** La nota que va a leer el editor: la corregida si la hay, si no la del marcador. */
function notaDeBloque(notas, indice, original) {
    const propia = notas && notas.bloques ? notas.bloques[indice] : null;
    return propia && propia.note ? propia.note : (original || '');
}

/**
 * Pasa un comentario del tiempo de la grabación al de la clase ya cortada.
 *
 * Un comentario puede caer en material que quedó afuera —se comentó algo y
 * después se sacó ese bloque—: en ese caso no hay dónde ponerlo y se descarta,
 * porque un marcador al azar en la secuencia final confunde más de lo que ayuda.
 *
 * @returns {number|null} segundo en la línea de tiempo del corte
 */
function enLaLineaDeTiempo(segundoDeOrigen, segmentos) {
    for (const s of segmentos || []) {
        if (s.keep === false) continue;
        if (segundoDeOrigen >= s.sourceStartSec && segundoDeOrigen <= s.sourceEndSec) {
            return s.timelineStartSec + (segundoDeOrigen - s.sourceStartSec);
        }
    }
    return null;
}

module.exports = { leer, guardar, notaDeBloque, enLaLineaDeTiempo, limpiar, vacio, VERSION };
