'use strict';
/**
 * borde.js — Mover un corte y dejarlo medido.
 *
 * Decidir que un corte va en el segundo 412 es la mitad del trabajo; la otra
 * mitad es que caiga donde el audio deja caerlo. Un tiempo escrito a pelo en el
 * bloque parte una palabra por la mitad, o deja medio segundo de aire que en la
 * clase se oye como un bache.
 *
 * Así que quien decide un corte —las reglas, el modelo, el detector de
 * repeticiones, el repaso final— pasa por acá: se busca el sonido alrededor con
 * la misma medición de onda que usa el alineado, se respetan los límites de la
 * palabra vecina y recién ahí se escribe en el bloque.
 *
 * Existe porque esto estaba copiado en cada sitio que movía un borde, y una
 * copia que se olvida de medir no falla: deja un corte peor y nadie se entera.
 */

const onset = require('./vendor/audio-onset');
const speech = require('./speech-edges');

// El colchón de aire es el de toda la maquinaria (align, cut-refine,
// marker-precision): DIEZ cuadros. Acá vivió un 2 que nadie decidió, y el mismo
// borde quedaba con 333 ms de aire si lo movía el afinado y con 67 si lo movía
// el detector de repeticiones — exactamente la divergencia silenciosa que este
// módulo existe para impedir.
const DEFAULTS = { fps: 30, padFrames: 10 };

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/**
 * Mueve un borde de un bloque y lo deja como cualquier otro del alineado.
 *
 * @param {object} params
 *   block      el bloque a tocar
 *   kind       'IN' u 'OUT'
 *   timeSec    dónde debería ir el corte, antes de medir el audio
 *   words      palabras del transcript
 *   wav        {file, info} del Live-Mix, o null para no medir
 *   options    { fps, padFrames }
 *   decidedBy  quién lo decidió, para poder explicarlo después
 *   reason     y por qué, en una línea que el visor muestra al lado del bloque
 * @returns {number|null} dónde quedó, o null si el bloque no tiene ese borde
 */
function aplicar(params) {
    const { block, kind, timeSec, words, wav, options, decidedBy, reason } = params;
    const edge = kind === 'IN' ? block.in : block.out;
    if (!edge) return null;

    let aplicado = timeSec;
    let audio = null;

    if (wav) {
        // Los límites impiden que el colchón de aire se meta en la palabra de al
        // lado, que es de donde salen los "Pau—" cortados a la mitad.
        const limites = speech.wordLimits(words, timeSec, kind);
        const medido = onset.measure(wav, timeSec, kind, {
            fps: opt(options, 'fps'),
            padFrames: opt(options, 'padFrames'),
            minTime: limites.minTime,
            maxTime: limites.maxTime
        });
        if (medido && medido.applyTime != null) {
            aplicado = medido.applyTime;
            audio = {
                appliedSec: Math.round(medido.applyTime * 1000) / 1000,
                airFrames: medido.airFrames == null ? null : medido.airFrames,
                code: medido.code || null,
                message: medido.message || null
            };
        } else {
            // La onda no pudo decir nada de este punto —pasa cuando alrededor no
            // hay ningún borde de sonido, es decir cuando el corte cae en medio
            // de habla continua— y el corte se hace igual, con el tiempo del
            // transcript. Lo que NO se puede hacer es callarlo: la medición que
            // el borde traía es de donde estaba ANTES, y dejarla ahí convierte el
            // artefacto en una mentira. En el bloque 7 de la clase 6 el borde se
            // movió a 1459.37 s y se quedó con el aire medido en 1468.32 s, así
            // que `tools/medir-cortes.js` informaba un corte "3.8 frames dentro
            // del sonido" nueve segundos lejos de donde había medido eso.
            audio = {
                appliedSec: Math.round(timeSec * 1000) / 1000,
                airFrames: null,
                code: 'sin-medida',
                message: 'La onda no encontró un borde de sonido acá: el corte va con el tiempo del transcript.'
            };
        }
    }

    edge.timeSec = aplicado;
    edge.alignedSec = Math.round(aplicado * 1000) / 1000;
    edge.shiftSec = Math.round((edge.alignedSec - edge.originalSec) * 1000) / 1000;
    if (decidedBy) edge.decidedBy = decidedBy;
    // El motivo viaja con el borde porque es lo que el visor muestra al lado del
    // bloque: un IN que se abrió 29 s después del marcador sin decir por qué se
    // lee como un error de la herramienta.
    if (reason) edge.reason = reason;
    if (audio) edge.audio = audio;

    if (kind === 'IN') block.startSec = edge.alignedSec;
    else block.endSec = edge.alignedSec;
    return edge.alignedSec;
}

/**
 * Devuelve un borde a donde estaba.
 *
 * Deshacer es la mitad de este trabajo: un arreglo que no arregla se tiene que
 * poder quitar entero, y sin esto cada sitio lo deshacía a mano y a medias
 * —tocando `endSec` pero dejando el `decidedBy` de un recorte que ya no
 * existe—.
 */
function recordar(block, kind) {
    const edge = kind === 'IN' ? block.in : block.out;
    return {
        block, kind, edge,
        timeSec: edge ? edge.timeSec : null,
        alignedSec: edge ? edge.alignedSec : null,
        shiftSec: edge ? edge.shiftSec : null,
        decidedBy: edge ? edge.decidedBy : null,
        reason: edge ? edge.reason : null,
        audio: edge ? edge.audio : null,
        startSec: block.startSec,
        endSec: block.endSec
    };
}

function deshacer(memoria) {
    const { block, kind, edge } = memoria;
    if (edge) {
        edge.timeSec = memoria.timeSec;
        edge.alignedSec = memoria.alignedSec;
        edge.shiftSec = memoria.shiftSec;
        if (memoria.decidedBy == null) delete edge.decidedBy; else edge.decidedBy = memoria.decidedBy;
        if (memoria.reason == null) delete edge.reason; else edge.reason = memoria.reason;
        if (memoria.audio == null) delete edge.audio; else edge.audio = memoria.audio;
    }
    block.startSec = memoria.startSec;
    block.endSec = memoria.endSec;
}

module.exports = { aplicar, recordar, deshacer, DEFAULTS };
