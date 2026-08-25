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

// En cifra es siempre el conteo: nadie dice "3" a mitad de clase, Whisper escribe
// el número hablado en letra. En letra, en cambio, es una palabra normal —"Uno de
// los problemas más comunes", "dos formas de hacerlo"— y solo es conteo si viene
// con otra al lado.
const COUNT_DIGIT = /^[321][.,;:!?…"»]*$/;

// Hasta dónde se busca el conteo desde el arranque del bloque. Con el "Ok." o el
// "Listo." del director delante, la cuenta empieza en la tercera o la cuarta;
// más allá de la octava ya no es el arranque de la toma, es la clase.
const MIRAR_CONTEO = 8;

const SENTENCE_END = /[.!?…]["»)]*$/;

// Con esto no se abre un bloque: son conectores que apuntan hacia atrás, a algo
// que se dijo antes, y si ese antes quedó fuera del corte el bloque abre en
// falso. Ojo con ampliar la lista: "ahora", "luego", "después" y "bueno"
// apuntan hacia adelante y abren perfecto ("Ahora quiero mostrarte un caso
// concreto"), así que meterlos cuenta como defecto lo que está bien.
const CONECTOR_HUERFANO = /^(entonces|pero|porque|además|ademas|también|tambien|igual|y|sin embargo|es decir|o sea|por eso|así que|asi que)[.,;:!?¡¿…"»]*$/i;

/** ¿Esta palabra es uno de esos conectores que se apoyan en lo de antes? */
function esConector(word) {
    return CONECTOR_HUERFANO.test(textOf(word).trim());
}

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
function isChatter(word, pauseBefore, options, vecina) {
    const text = textOf(word).trim();
    if (!text) return false;
    if (STRONG_CHATTER.test(text)) return true;
    if (esConteo(word, vecina)) return true;
    if (WEAK_CHATTER.test(text)) {
        const trasSilencio = (pauseBefore == null ? 0 : pauseBefore) >= opt(options, 'weakPauseSec');
        // Y SUELTA, que es la otra mitad de la regla y faltaba. Estas palabras
        // existen dentro del habla normal, así que el silencio de delante no
        // alcanza para distinguirlas: en la clase 6, "Ya" abría la frase "Ya
        // Clauco nos entregó los planos de nuestra casa" a 0,35 s del conteo —
        // justo en el umbral—, se contaba como orden del director, y eso
        // bloqueaba el retraer del ajuste a frase: el bloque saltaba a la frase
        // siguiente y esa se perdía entera.
        //
        // Suelta significa que cierra su propia frase ("Ok.", "Listo.", "Ya.")
        // o que no hay nada detrás. Con más palabras pegadas es habla.
        return trasSilencio && (endsSentence(word) || !vecina);
    }
    return false;
}

/**
 * ¿Es un conteo de toma y no un número dicho dentro de la clase?
 * @param {object} vecina la palabra de al lado, para ver si van en fila
 */
function esConteo(word, vecina) {
    const text = textOf(word).trim();
    if (!COUNT_WORD.test(text)) return false;
    if (COUNT_DIGIT.test(text)) return true;
    return Boolean(vecina) && COUNT_WORD.test(textOf(vecina).trim());
}

/**
 * ¿Dónde termina el conteo de toma que abre esta lista de palabras?
 *
 * Vive acá y no en cada sitio que lo necesita porque son tres: el recorte lo
 * quita, el filtro de candidatos descarta los cortes que abren con él y la
 * medición lo cuenta. Con una copia en cada uno, el modelo podía elegir un corte
 * que el recorte hubiera rechazado.
 *
 * @returns {number} índice de la última palabra del conteo, o -1 si no hay
 */
function finDeConteo(lista) {
    let fin = -1;
    for (let i = 0; i + 1 < Math.min(lista.length, MIRAR_CONTEO); i++) {
        if (esConteo(lista[i], lista[i + 1]) && esConteo(lista[i + 1], lista[i])) fin = i + 1;
    }
    return fin;
}

/** ¿Un corte en este punto dejaría el conteo dentro del bloque? */
function abreConConteo(words, timeSec) {
    return finDeConteo(spoken(words).filter(w => w.end > timeSec + 0.02).slice(0, MIRAR_CONTEO)) >= 0;
}

/** Las que se van solas, sin depender del silencio que traigan delante. */
function isHardChatter(word, vecina) {
    const text = textOf(word).trim();
    return Boolean(text) && (STRONG_CHATTER.test(text) || esConteo(word, vecina));
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

    // El silencio es lo que delata a un "listo" o un "ya" sueltos: sin él son
    // parte de la frase. Pero si lo que viene justo antes ya es una orden —un
    // "Pausa.", un conteo—, el aparte ya empezó y no hace falta buscarle silencio
    // propio, porque el silencio quedó del otro lado de la orden. En "…el
    // proyecto. Pausa. Listo. 3, 2, 1." el hueco delante de "Listo." mide 0.30s,
    // por debajo del listón, y por eso el borde se quedaba terminando en "Listo.".
    const silencioAntesDe = (block, at) => {
        if (at > 0 && isHardChatter(block[at - 1], block[at - 2])) return 999;
        return at > 0 ? block[at].start - block[at - 1].end : 999;
    };

    // Por el final: la orden al editor llega después de la última frase.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const last = block[block.length - 1];
        const before = block[block.length - 2];
        const pause = silencioAntesDe(block, block.length - 1);
        if (!isChatter(last, pause, options, before)) break;
        removed.push(textOf(last));
        // Whisper entrega palabras que se solapan, así que llevar el borde al
        // final de la anterior puede dejar el chatter medio adentro y el bucle lo
        // saca de nuevo sin haberse movido. Se cierra donde el chatter arranca.
        end = Math.min(before.end, last.start);
    }

    // La cuenta atrás es el "ya" de la toma: lo que viene detrás es la clase y lo
    // que viene delante, no. Se mira antes que nada porque el bucle de abajo va
    // palabra por palabra y para en la primera que no es charla, así que un "Ok."
    // que no traiga silencio propio le tapa el conteo que viene detrás y el
    // bloque abre con "Ok. 3, 2, 1. En este curso…" entero.
    //
    // Hace falta que sean DOS seguidas. Una sola no es un conteo: "Uno de los
    // problemas más comunes" y "Tres cosas antes de empezar" abren clases de
    // verdad, y tirarlas por parecerse a un conteo se lleva por delante justo la
    // frase que presenta el bloque.
    const arranque = inside();
    const finDelConteo = finDeConteo(arranque);
    if (finDelConteo >= 0 && finDelConteo + 1 < arranque.length) {
        for (let i = 0; i <= finDelConteo; i++) removed.push(textOf(arranque[i]));
        // Donde ARRANCA la palabra siguiente, no donde termina el conteo. Whisper
        // entrega palabras que se pisan, y el "uno." de la cuenta terminaba
        // después de que empezara la frase: llevar el borde a ese final se comía
        // «Para ver» en la clase 9 y «En» en la 13. Dejar dentro la cola de un
        // conteo no molesta —el afinado con la onda la resuelve, porque entre la
        // cuenta y la toma siempre hay silencio—; perder las dos primeras
        // palabras de la clase, sí.
        start = arranque[finDelConteo + 1].start;
    }

    // Por el principio: sobras del conteo o un "ok" del director.
    for (let guard = 0; guard < 6; guard++) {
        const block = inside();
        if (block.length < 2) break;
        const first = block[0];
        const idx = list.indexOf(first);
        const pause = idx > 0 ? first.start - list[idx - 1].end : 999;
        if (!isChatter(first, pause, options, block[1])) break;
        removed.push(textOf(first));
        // Igual que arriba: con palabras solapadas, abrir donde empieza la
        // siguiente puede dejar adentro el final del conteo. Se abre pasado el
        // chatter, que es lo único que garantiza avanzar.
        start = Math.max(block[1].start, first.end);
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
            // Con la palabra de al lado: sin ella, `isChatter` no puede ver si la
            // palabra viene suelta —que es lo que la hace una orden— y trata
            // como aparte del director cualquier "ya" o "bueno" del habla normal.
            if (isChatter(word, pause, options, list[i + 1])) break;
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
    // `minTime` es el suelo de quien llama —la claqueta, el bloque anterior— y
    // acá importa porque esto es lo único del alineado que mueve un IN hacia
    // atrás: sin él, abrir la frase podía meterse en la claqueta.
    const suelo = options && options.minTime != null ? options.minTime : null;
    for (let i = idx - 1; i >= 0; i--) {
        if (timeSec - list[i].start > limit) break;
        if (suelo != null && list[i].start < suelo) break;
        const pause = i > 0 ? list[i].start - list[i - 1].end : 999;
        // Igual que arriba, con la vecina. Acá se notaba peor: "Ya" abría la
        // frase "Ya Clauco nos entregó los planos" y sin la vecina contaba como
        // orden del director, así que este bucle cortaba y el bloque se iba a la
        // frase siguiente — perdiendo la primera entera.
        if (isChatter(list[i], pause, options, list[i + 1])) break;
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

/**
 * ¿Un tramo así cortado termina a mitad de frase?
 *
 * Es EL criterio de "final colgando" del proyecto: lo usan el detector de
 * repeticiones para no cambiar un defecto por otro, el repaso para saber qué
 * arreglar y las herramientas de medición para contarlo. Vivía copiado en cada
 * uno, y tres copias de la definición son tres maneras de medir distinto.
 */
function quedaColgando(words, startSec, endSec) {
    const dentro = wordsInside(words, startSec, endSec);
    return Boolean(dentro.length) && !endsSentence(dentro[dentro.length - 1]);
}

/**
 * Por debajo de esto, el transcript no sirve para decidir cortes.
 *
 * El número sale de medir las trece clases del curso: las sanas van de 9,3 % a
 * 15,4 % de palabras cerrando frase, y la clase 6 enferma —whisper.cpp trabado
 * arrastrando su propio texto entre ventanas— estaba en 2,5 %. 5 % parte esa
 * distancia por el medio: es la mitad de la peor clase sana y el doble de la
 * enferma, así que no hay forma de que una clase normal lo dispare ni de que
 * una trabada se escape.
 */
const CIERRES_MINIMOS = 0.05;

/**
 * Cuánta puntuación de cierre trae un transcript.
 *
 * Existe porque es la comprobación que habría delatado la clase 6 ocho pasos
 * antes de que el defecto se viera. Todo lo de acá abajo —el ajuste a frase, el
 * recorte del habla del director, el "queda colgando"— se apoya en saber dónde
 * termina una frase. Un transcript sin puntuación no hace fallar nada: hace que
 * cada bloque se corte donde caiga y que el problema aparezca al final,
 * disfrazado de "ocho finales colgados", en un sitio donde ya no se puede
 * atribuir a la transcripción.
 *
 * El pozo se mide además del porcentaje porque el porcentaje es global y el
 * daño es local: la clase 12 tiene un 13,9 % sano y aun así se pasa 599
 * segundos seguidos sin un punto, y todos los bloques que caen ahí adentro se
 * cortan a ciegas. El porcentaje decide el aviso; el pozo es lo que después
 * explica por qué una clase con buen número igual salió mal.
 *
 * @returns {{palabras:number, cierres:number, ratio:number, pozoSec:number, sirve:boolean}}
 */
function densidadDeCierres(words) {
    const dichas = spoken(words);
    let cierres = 0;
    let pozoSec = 0;
    // El pozo se mide desde el principio del habla y hasta el final, no solo
    // entre dos puntos. Con un transcript que trae un único punto al final, la
    // cuenta "entre cierres" da cero y el peor caso posible se informa como el
    // mejor; el tramo sin puntuación es toda la clase menos la última palabra.
    let ultimo = dichas.length ? dichas[0].start : null;
    for (const word of dichas) {
        if (!endsSentence(word)) continue;
        cierres++;
        pozoSec = Math.max(pozoSec, word.end - ultimo);
        ultimo = word.end;
    }
    if (ultimo != null) {
        pozoSec = Math.max(pozoSec, dichas[dichas.length - 1].end - ultimo);
    }
    const ratio = dichas.length ? cierres / dichas.length : 0;
    return {
        palabras: dichas.length,
        cierres,
        ratio: Math.round(ratio * 10000) / 10000,
        pozoSec: Math.round(pozoSec * 10) / 10,
        // Un transcript vacío no es un transcript malo: es una clase sin audio,
        // y de eso ya avisa el alineado. Decir además que "no sirve para
        // cortar" sería el mismo problema contado dos veces.
        sirve: !dichas.length || ratio >= CIERRES_MINIMOS
    };
}

module.exports = {
    isChatter,
    isHardChatter,
    esConector,
    CONECTOR_HUERFANO,
    endsSentence,
    densidadDeCierres,
    CIERRES_MINIMOS,
    wordLimits,
    tightest,
    trimChatter,
    snapToSentence,
    wordsInside,
    textInside,
    quedaColgando,
    spoken,
    textOf,
    esConteo,
    finDeConteo,
    abreConConteo,
    STRONG_CHATTER,
    WEAK_CHATTER,
    COUNT_WORD,
    DEFAULTS
};
