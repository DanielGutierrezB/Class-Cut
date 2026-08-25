'use strict';
/**
 * clap-detect.js — Dónde está la claqueta en el audio.
 *
 * Al principio de cada clase alguien dice "claqueta N, clase N" y da un aplauso.
 * El XML trae un marcador `K` en ese punto, así que comparar los dos da el desfase
 * de la clase entera.
 *
 * Whisper casi nunca escribe "claqueta": en el curso real salió "Cleta 4, clase 4"
 * y "Secleta 4, clase 4". Lo que sí transcribe bien es **"clase N"**, y ese es el
 * ancla: se busca el número de la clase precedido de la palabra "clase", cerca del
 * principio. La palabra rara de delante se acepta si se parece a "claqueta", y si
 * aparece, el desfase se mide desde ahí, que es donde arranca de verdad el dicho.
 *
 * El aplauso se busca aparte, como confirmación: un pico corto y fuerte justo
 * después de la frase. No manda —el desfase que sale de acá lo valida después
 * `align.js` viendo si mejora los anclajes— pero cuando está, lo dice.
 */

const onset = require('./vendor/audio-onset');

const DEFAULTS = {
    searchSec: 240,      // la claqueta está al principio; más allá es otra cosa
    clapWindowSec: 8,    // cuánto se mira después de la frase buscando el aplauso
    clapRatio: 2.2,      // cuánto tiene que destacar el pico sobre el resto
    nearWords: 4         // cuántas palabras antes de "clase" se miran buscando "claqueta"
};

const NUMBER_WORDS = {
    uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
    ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
    quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20
};

function norm(text) {
    return String(text == null ? '' : text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function asNumber(token) {
    const t = norm(token);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return NUMBER_WORDS[t] != null ? NUMBER_WORDS[t] : null;
}

/**
 * ¿Esta palabra quiere decir "claqueta"? Se acepta cualquier cosa que empiece
 * como ella o que la contenga: whisper la parte y la deforma de mil maneras
 * ("cleta", "secleta", "claketa"), pero el esqueleto se mantiene.
 */
function looksLikeClaqueta(token) {
    const t = norm(token);
    if (!t) return false;
    return /cla?que?ta|cleta|claketa|claquet|clapper/.test(t);
}

/**
 * Busca "clase N" (o la palabra claqueta seguida del número) en las primeras
 * palabras del transcript.
 * @returns {{start, end, text, hasClaquetaWord, matchedNumber, wordIdx}|null}
 */
function findSpokenClap(words, classNumber, options) {
    const opts = { ...DEFAULTS, ...(options || {}) };
    const list = words || [];

    let fallback = null;
    for (let i = 0; i < list.length; i++) {
        const word = list[i];
        if (word.start > opts.searchSec) break;
        if (norm(word.text) !== 'clase') continue;

        const next = list[i + 1];
        const number = next ? asNumber(next.text) : null;
        if (number == null) continue;

        // La palabra deformada de "claqueta" suele estar justo antes, a veces con
        // el número de toma en el medio ("claqueta 4, clase 4").
        let anchorIdx = i;
        let hasClaquetaWord = false;
        for (let back = 1; back <= opts.nearWords && i - back >= 0; back++) {
            if (looksLikeClaqueta(list[i - back].text)) {
                anchorIdx = i - back;
                hasClaquetaWord = true;
                break;
            }
        }

        const hit = {
            start: list[anchorIdx].start,
            end: next.end,
            text: list.slice(anchorIdx, i + 2).map(w => w.text).join(' ').trim(),
            hasClaquetaWord,
            matchedNumber: number,
            wordIdx: anchorIdx
        };

        if (classNumber == null || number === classNumber) return hit;
        // "clase" con otro número: sirve solo si no aparece el correcto.
        if (!fallback) fallback = hit;
    }
    return fallback;
}

/**
 * El aplauso: el pico más marcado de la ventana que sigue a la frase. Se pide que
 * destaque sobre la mediana del entorno, porque en una ventana de puro silencio
 * el máximo es ruido de sala y no un golpe.
 * @returns {{time, level, ratio}|null}
 */
function findClapPeak(wav, fromSec, options) {
    const opts = { ...DEFAULTS, ...(options || {}) };
    if (!wav || !wav.info) return null;

    const probe = onset.probe(wav, Math.max(0, fromSec), opts.clapWindowSec, {});
    if (!probe || !probe.env || !probe.env.length) return null;

    const env = probe.env;
    let peakIdx = 0;
    for (let i = 1; i < env.length; i++) if (env[i] > env[peakIdx]) peakIdx = i;

    const sorted = Array.from(env).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const peak = env[peakIdx];
    if (!peak) return null;

    const ratio = median > 0 ? peak / median : Infinity;
    if (ratio < opts.clapRatio) return null;

    return {
        time: Math.round((probe.windowStart + peakIdx * probe.hopSec) * 1000) / 1000,
        level: Math.round(peak * 10000) / 10000,
        ratio: ratio === Infinity ? null : Math.round(ratio * 100) / 100
    };
}

/**
 * Desfase de la clase: dónde está la claqueta de verdad contra dónde la puso el
 * marcador `K`.
 *
 * @param {object} params { words, wav, classNumber, markerSec }
 * @returns {{found, method, offsetSec, time, spoken, clap, confidence, reason}}
 */
function detectClap(params) {
    const { words, wav, classNumber, markerSec } = params || {};
    const opts = { ...DEFAULTS, ...(params && params.options) };

    const spoken = findSpokenClap(words, classNumber, opts);
    const clap = spoken && wav ? findClapPeak(wav, spoken.end - 0.2, opts) : null;

    if (!spoken) {
        return {
            found: false,
            method: null,
            offsetSec: 0,
            time: null,
            spoken: null,
            clap: null,
            confidence: 'baja',
            reason: 'No se oye la claqueta al principio: los marcadores quedan donde el CD los dejó.'
        };
    }

    const numberMatches = classNumber == null || spoken.matchedNumber === classNumber;

    // La referencia es el APLAUSO, no la frase. Medido en la clase 01 del curso
    // real: el dicho arranca en 0:16.4, el golpe cae en 0:21.7 y el marcador está
    // en 0:19.0; los bloques de esa clase piden correrse ~+2.7 s, que es
    // exactamente lo que dice el golpe y lo contrario de lo que decía la frase.
    // Tiene sentido: el golpe es un instante y el dicho dura lo que dure.
    const method = clap ? 'aplauso' : 'frase';
    const time = clap ? clap.time : spoken.start;
    const offsetSec = markerSec == null ? 0 : Math.round((time - markerSec) * 1000) / 1000;

    let confidence = clap ? 'alta' : 'media';
    if (!spoken.hasClaquetaWord && !clap) confidence = 'media';
    if (!numberMatches) confidence = 'baja';

    const parts = [`Se oye "${spoken.text}" en ${fmt(spoken.start)}`];
    if (clap) parts.push(`el golpe cae en ${fmt(clap.time)} y es la referencia`);
    else parts.push('sin golpe claro: se usa el arranque de la frase');
    if (markerSec != null) parts.push(`el marcador está en ${fmt(markerSec)}`);
    if (!numberMatches) parts.push(`ojo: dice clase ${spoken.matchedNumber} y esta es la ${classNumber}`);

    return {
        found: true,
        method,
        offsetSec,
        time,
        spoken,
        clap,
        spokenOffsetSec: markerSec == null ? null : Math.round((spoken.start - markerSec) * 1000) / 1000,
        confidence,
        reason: `${parts.join(', ')}.`
    };
}

function fmt(seconds) {
    if (seconds == null) return '—';
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    const rest = (s - m * 60).toFixed(1).padStart(4, '0');
    return `${m}:${rest}`;
}

/** Lo que se deja pasar después del golpe, para que no se oiga su cola. */
const MARGEN_DEL_PISO_SEC = 0.35;

/**
 * Antes de este segundo no empieza la clase.
 *
 * La claqueta no es un bloque: es la referencia para sincronizar, y todo lo que
 * pasa hasta que suena —acomodar la cámara, "¿grabando?", el dicho y el golpe—
 * es preparación. El parser ya no la convierte en bloque, pero eso no alcanzaba:
 * el bloque 1 puede ABRIRSE hacia atrás y tragársela. Pasó en la clase 6, donde
 * el modelo eligió un corte 7,4 s antes del marcador y el corte final empezaba
 * con "Claqueta 6, clase 6. 3, 2, 1. Ya…".
 *
 * Así que la claqueta es un piso, no una sugerencia: ningún IN puede caer antes.
 * Se toma lo más tardío que se sepa de ella —el golpe si se oyó, el final del
 * dicho, o donde el CD puso el marcador— porque cualquiera de los tres que quede
 * afuera se oye en la clase.
 *
 * @param {object} clap lo que devolvió `detectClap`
 * @param {number|null} markerSec el marcador del CD, en tiempo del XML
 * @param {number} offsetSec el desfase que se le aplicó a la clase
 * @returns {number|null} null si no se sabe nada de la claqueta
 */
function pisoDeLaClase(clap, markerSec, offsetSec) {
    const candidatos = [];
    if (clap && clap.found) {
        if (clap.clap && clap.clap.time != null) candidatos.push(clap.clap.time);
        if (clap.spoken && clap.spoken.end != null) candidatos.push(clap.spoken.end);
    }
    // El marcador vive en tiempo del XML; los bloques ya están en tiempo del
    // audio, así que hay que correrlo lo mismo que se corrió la clase.
    if (markerSec != null) candidatos.push(markerSec + (offsetSec || 0));
    if (!candidatos.length) return null;
    return Math.round((Math.max(...candidatos) + MARGEN_DEL_PISO_SEC) * 1000) / 1000;
}

module.exports = {
    detectClap, findSpokenClap, findClapPeak, looksLikeClaqueta, asNumber,
    pisoDeLaClase, MARGEN_DEL_PISO_SEC, DEFAULTS
};
