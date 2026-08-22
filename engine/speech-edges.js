'use strict';
/**
 * speech-edges.js — Dónde termina de verdad lo que hay que dejar.
 *
 * Un bloque bien cortado no es el que empieza y termina donde el CD puso la
 * marca: es el que empieza cuando arranca una idea y termina cuando esa idea
 * cierra. Entre una cosa y otra se cuela lo que el profesor le dice al editor
 * ("pausa", "corte", "ok") y los pedazos de la frase siguiente.
 *
 * Medido sobre los 174 bloques del curso antes de este módulo: 66 terminaban con
 * una palabra del director —"…con el Bytecoin. Pau—"— y 103 terminaban a mitad
 * de frase, con un fragmento colgando: "…que debes aprender. Igual,".
 *
 * Acá viven las tres reglas que arreglan eso sin preguntarle a nadie:
 *   1. Los límites de palabra, para que el colchón de aire no se coma la palabra
 *      de al lado (que es de donde salía el "Pau—").
 *   2. El recorte del habla del director en los bordes.
 *   3. El ajuste a frase: si el borde cae a mitad de una, se retrae a la
 *      puntuación anterior o se extiende a la siguiente.
 *
 * Lo que no se puede decidir con reglas —cuál de las dos opciones deja mejor la
 * clase— se lo lleva `cut-refine.js`.
 */

// Órdenes al editor. Estas se van siempre: nadie las dice como parte de la clase.
const STRONG_CHATTER = /^(pausa|pausita|corte|cortes|corta|cortale|córtale|cortala|córtala|alto|cut)[.,;:!?¡¿…"»]*$/i;

// Estas también son del director, pero existen dentro del habla normal ("ya está
// listo", "va a ser así"). Solo cuentan como orden si vienen sueltas, después de
// un silencio: ahí no son parte de la frase, son un aparte.
const WEAK_CHATTER = /^(ok|okay|okey|vale|listo|listos|perfecto|perfecta|dale|va|vamos|bien|bueno|gracias|eso|ya)[.,;:!?¡¿…"»]*$/i;

// El conteo con el que arranca cada toma, y las sobras del conteo siguiente.
const COUNT_WORD = /^(tres|dos|uno|3|2|1)[.,;:!?…"»]*$/i;

const SENTENCE_END = /[.!?…]["»)]*$/;

const DEFAULTS = {
    weakPauseSec: 0.35,   // silencio a partir del cual una palabra suelta es un aparte
    maxShiftSec: 4,       // cuánto puede moverse un borde para cerrar la frase
    retractWords: 4,      // cuántas palabras atrás se busca la puntuación al retraer
    minKeepSec: 1.5       // un bloque nunca queda más corto que esto por ajustar
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

function textOf(word) {
    if (!word) return '';
    const value = word.text != null ? word.text : word.word;
    return value == null ? '' : String(value);
}

/** Las palabras que de verdad se dijeron, con tiempos utilizables. */
function spoken(words) {
    return (words || []).filter(w =>
        w && typeof w.start === 'number' && typeof w.end === 'number' && textOf(w).trim());
}

function endsSentence(word) {
    return SENTENCE_END.test(textOf(word).trim());
}

/**
 * ¿Esta palabra es una orden al editor y no parte de la clase?
 * @param {object} word
 * @param {number} pauseBefore silencio que la precede, en segundos
 */
function isChatter(word, pauseBefore, options) {
    const text = textOf(word).trim();
    if (!text) return false;
    if (STRONG_CHATTER.test(text)) return true;
    if (COUNT_WORD.test(text)) return true;
    if (WEAK_CHATTER.test(text)) {
        return (pauseBefore == null ? 0 : pauseBefore) >= opt(options, 'weakPauseSec');
    }
    return false;
}

/**
 * Los límites que el borde no puede cruzar, sacados del transcript.
 *
 * Este es el arreglo de raíz del "Pau—": `audio-onset` coloca el corte con un
 * colchón de aire, y sin decirle dónde está la palabra vecina ese colchón se la
 * come. En el bloque 7 de la clase 01 el corte caía en 920.13 y "Pausa." iba de
 * 919.70 a 920.70.
 *
 * @param {string} kind "IN" | "OUT"
 * @returns {{minTime: number|null, maxTime: number|null}}
 */
function wordLimits(words, timeSec, kind) {
    const list = spoken(words);
    if (!list.length) return { minTime: null, maxTime: null };

    if (kind === 'IN') {
        // Nada de lo que ya terminó antes del corte entra al bloque.
        let previousEnd = null;
        for (const word of list) {
            if (word.end <= timeSec + 0.01) previousEnd = word.end;
            else break;
        }
        return { minTime: previousEnd, maxTime: null };
    }

    // OUT: el corte no puede llegar a la palabra que viene después.
    let nextStart = null;
    for (const word of list) {
        if (word.start >= timeSec - 0.01) { nextStart = word.start; break; }
    }
    return { minTime: null, maxTime: nextStart };
}

/** Combina dos límites quedándose con el más ajustado de cada lado. */
function tightest(a, b) {
    const pick = (x, y, harder) => {
        if (x == null) return y;
        if (y == null) return x;
        return harder(x, y);
    };
    return {
        minTime: pick(a.minTime, b.minTime, Math.max),
        maxTime: pick(a.maxTime, b.maxTime, Math.min)
    };
}

/**
 * Saca del bloque las órdenes al editor que quedaron pegadas a los bordes.
 * @returns {{startSec, endSec, removed: string[]}}
 */
function trimChatter(words, startSec, endSec, options) {
    const list = spoken(words);
    const removed = [];
    let start = startSec;
    let end = endSec;

    const inside = () => list.filter(w => w.end > start + 0.02 && w.start < end - 0.02);

    // Por el final: la orden al editor llega después de la última frase.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const last = block[block.length - 1];
        const before = block[block.length - 2];
        const pause = last.start - before.end;
        if (!isChatter(last, pause, options)) break;
        removed.push(textOf(last));
        end = before.end;
    }

    // Por el principio: sobras del conteo o un "ok" del director.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const first = block[0];
        const idx = list.indexOf(first);
        const pause = idx > 0 ? first.start - list[idx - 1].end : 999;
        if (!isChatter(first, pause, options)) break;
        removed.push(textOf(first));
        start = block[1].start;
    }

    if (end - start < opt(options, 'minKeepSec')) {
        // Recortar dejó el bloque en nada: se prefiere el bloque con ruido antes
        // que un bloque que no se entiende.
        return { startSec, endSec, removed: [] };
    }
    return { startSec: start, endSec: end, removed };
}

/**
 * Lleva un borde a donde cierra (o abre) una frase.
 *
 * Cuando la puntuación fuerte está apenas unas palabras atrás, lo que sobra es
 * el arranque de la frase siguiente y se RETRAE —el caso "…que debes aprender.
 * Igual,"—. Cuando no hay ninguna cerca, la frase de verdad sigue y se EXTIENDE
 * hasta que cierre.
 *
 * @returns {{timeSec, moved, how, candidates: {retract: number|null, extend: number|null}}}
 */
function snapToSentence(words, timeSec, kind, options) {
    const list = spoken(words);
    const limit = opt(options, 'maxShiftSec');
    const result = { timeSec, moved: false, how: 'sin cambio', candidates: { retract: null, extend: null } };
    if (!list.length) return result;

    if (kind === 'OUT') {
        const inside = list.filter(w => w.end <= timeSec + 0.02);
        if (!inside.length) return result;
        const last = inside[inside.length - 1];
        if (endsSentence(last)) {
            result.how = 'ya cerraba una frase';
            return result;
        }

        const back = Math.min(opt(options, 'retractWords'), inside.length - 1);
        for (let i = inside.length - 2; i >= inside.length - 1 - back && i >= 0; i--) {
            if (endsSentence(inside[i])) { result.candidates.retract = inside[i].end; break; }
        }

        const from = list.indexOf(last);
        for (let i = from + 1; i < list.length; i++) {
            const word = list[i];
            if (word.end - timeSec > limit) break;
            const pause = word.start - list[i - 1].end;
            if (isChatter(word, pause, options)) break;
            if (endsSentence(word)) { result.candidates.extend = word.end; break; }
        }

        if (result.candidates.retract != null) {
            result.timeSec = result.candidates.retract;
            result.moved = true;
            result.how = 'se retrajo al final de la frase anterior';
        } else if (result.candidates.extend != null) {
            result.timeSec = result.candidates.extend;
            result.moved = true;
            result.how = 'se extendió hasta cerrar la frase';
        } else {
            result.how = 'no hay dónde cerrar la frase cerca';
        }
        return result;
    }

    // IN: el bloque tiene que abrir con una frase, no con su mitad.
    const idx = list.findIndex(w => w.end > timeSec + 0.02);
    if (idx === -1) return result;
    const first = list[idx];
    const previous = idx > 0 ? list[idx - 1] : null;

    if (!previous || endsSentence(previous)) {
        result.how = 'ya abría una frase';
        return result;
    }

    // Hacia atrás: el principio de la frase que este bloque parte por la mitad.
    for (let i = idx - 1; i >= 0; i--) {
        if (timeSec - list[i].start > limit) break;
        const pause = i > 0 ? list[i].start - list[i - 1].end : 999;
        if (isChatter(list[i], pause, options)) break;
        if (i === 0 || endsSentence(list[i - 1])) { result.candidates.retract = list[i].start; break; }
    }
    // Hacia adelante: el arranque de la frase siguiente.
    for (let i = idx; i < list.length - 1; i++) {
        if (list[i].end - timeSec > limit) break;
        if (endsSentence(list[i])) { result.candidates.extend = list[i + 1].start; break; }
    }

    if (result.candidates.retract != null) {
        result.timeSec = result.candidates.retract;
        result.moved = true;
        result.how = 'se abrió al principio de la frase';
    } else if (result.candidates.extend != null) {
        result.timeSec = result.candidates.extend;
        result.moved = true;
        result.how = 'se abrió en la frase siguiente';
    } else {
        result.how = 'no hay un arranque de frase cerca';
    }
    return result;
}

/** Las palabras que quedan dentro de un tramo. */
function wordsInside(words, startSec, endSec) {
    return spoken(words).filter(w => w.end > startSec + 0.02 && w.start < endSec - 0.02);
}

/** El texto de un tramo, tal como sonaría al verlo cortado. */
function textInside(words, startSec, endSec) {
    return wordsInside(words, startSec, endSec).map(textOf).join(' ').trim();
}

module.exports = {
    isChatter,
    endsSentence,
    wordLimits,
    tightest,
    trimChatter,
    snapToSentence,
    wordsInside,
    textInside,
    spoken,
    textOf,
    STRONG_CHATTER,
    WEAK_CHATTER,
    COUNT_WORD,
    DEFAULTS
};
