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

/**
 * Lo que hay que comparar para saber si esto es lo mismo que ya está guardado.
 *
 * Las fechas quedan afuera —cambian en cada guardado— y los ids también: los
 * acuña este archivo, así que un comentario que llega sin id es nuevo y su texto
 * ya lo delata.
 */
function contenido(datos) {
    return JSON.stringify({
        bloques: (datos && datos.bloques) || {},
        comentarios: ((datos && datos.comentarios) || [])
            .map(c => [c.sourceStartSec, c.sourceEndSec, c.texto, c.comentario])
    });
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

    // Guardar lo mismo otra vez no se escribe. Pasa a cada rato: el campo de la
    // nota guarda al salir del foco, así que entrar y salir sin escribir nada ya
    // era una escritura. Y la fecha de este archivo es lo que decide si una clase
    // hay que reexportarla (`engine/regenerar.js`): moverla sin motivo hace que
    // el botón anuncie clases atrasadas que en realidad están al día.
    const guardado = leer(root, sequenceName);
    if (contenido(guardado) === contenido(limpio)) return guardado;

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
    const s = segmentoDe(segundoDeOrigen, segmentos);
    return s ? s.timelineStartSec + (segundoDeOrigen - s.sourceStartSec) : null;
}

function segmentoDe(segundoDeOrigen, segmentos) {
    for (const s of segmentos || []) {
        if (s.keep === false) continue;
        if (segundoDeOrigen >= s.sourceStartSec && segundoDeOrigen <= s.sourceEndSec) return s;
    }
    return null;
}

/**
 * Lo mismo, pero con el pedazo entero: un comentario se escribió seleccionando
 * palabras, y ese pedazo es lo que tiene que durar el marcador.
 *
 * La selección se mide en el segmento donde EMPIEZA y se recorta ahí si se pasa
 * del corte: lo que hay más allá del borde no está en la secuencia, o está en
 * otro sitio, y un marcador que cruza un corte señala material que no es el que
 * se comentó.
 *
 * @returns {{startSec:number, endSec:number}|null}
 */
function tramoEnLaLineaDeTiempo(desdeOrigen, hastaOrigen, segmentos) {
    const s = segmentoDe(desdeOrigen, segmentos);
    if (!s) return null;
    const hasta = isFinite(hastaOrigen) ? hastaOrigen : desdeOrigen;
    const acotado = Math.min(Math.max(hasta, desdeOrigen), s.sourceEndSec);
    return {
        startSec: s.timelineStartSec + (desdeOrigen - s.sourceStartSec),
        endSec: s.timelineStartSec + (acotado - s.sourceStartSec)
    };
}

module.exports = {
    leer, guardar, notaDeBloque, enLaLineaDeTiempo, tramoEnLaLineaDeTiempo,
    limpiar, vacio, VERSION
};
