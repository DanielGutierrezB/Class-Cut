'use strict';
/**
 * cut-refine.js — Cuando hay más de un corte razonable, elegir el bueno.
 *
 * Las reglas de `speech-edges` resuelven la enorme mayoría: sacan las órdenes al
 * editor y cierran la frase. Lo que no pueden resolver es cuál de dos opciones
 * deja mejor la clase — si conviene cerrar antes y perder una frase, o después y
 * arrastrar el arranque de un intento que el bloque siguiente rehace. Eso es
 * criterio, y para eso está el modelo local.
 *
 * La forma de preguntar importa más que el modelo: no se le pide un tiempo, se le
 * dan los cortes posibles NUMERADOS dentro de la transcripción y contesta un
 * número. Así no puede inventar un timecode, no puede cortar a mitad de palabra y
 * el movimiento queda acotado por construcción. Si contesta cualquier otra cosa,
 * se descarta y manda la regla.
 *
 * Y solo se le pregunta por los bordes dudosos: en el curso real eso es alrededor
 * del 7% de los bloques.
 */

const precision = require('./vendor/marker-precision');
const anchor = require('./vendor/marker-anchor');
const onset = require('./vendor/audio-onset');
const speech = require('./speech-edges');
const claseEntera = require('./clase-entera');
const ordenDelCd = require('./orden-del-cd');

const DEFAULTS = {
    fps: 30,
    padFrames: 10,
    windowSec: 18,
    maxCandidates: 10,
    // Ventaja mínima para no consultar al modelo. Por debajo, las dos opciones
    // son defendibles y la diferencia la nota alguien que entiende la clase.
    clearMargin: 1.5,
    neighbourWords: 40,
    // Lo mínimo que puede quedar de un bloque después de afinar los dos bordes.
    minBlockSec: 1,
    // ── Lo que sigue está medido, no elegido a ojo. El banco es
    //    `tools/banco-contexto.js`; los números, sobre los 174 bloques del curso.

    // Cuánto ve el modelo al decidir: 'ventana' son las ~60 palabras alrededor
    // del corte; 'clase' le pone además la clase entera de fondo, con los bloques
    // marcados, para que pueda ver si algo se rehace más adelante.
    //
    // Va en 'ventana' aunque la clase entera entre de sobra (unos 3700 tokens,
    // contra los ~20k que aguanta el default de Ollama). Medido: cambia 2 de 174
    // defectos —dentro del ruido— y cuesta 2.8× el tiempo (108s contra 38s en
    // seis clases, mejor de tres rondas). De 33 consultas, en 30 contesta lo
    // mismo que con la ventana: el cuello no es cuánto ve, es qué opciones tiene
    // para elegir.
    contexto: 'ventana',
    // A qué bloques se les pasa la regla determinista: 'todos' o solo los
    // 'dudosos'. Abrirla a todos parecía gratis y sensato —la regla es aritmética
    // sobre el transcript— pero medido deja los defectos igual (52 y 52) moviendo
    // 126 bordes en vez de 98. Mover bordes que estaban bien, para nada.
    mirar: 'dudosos',
    // A cuáles se les gasta una consulta al modelo cuando la regla no despega.
    // Con 'todos' y `mirar: 'todos'` son 114 consultas en vez de 67 para terminar
    // con un defecto MÁS.
    preguntar: 'todos',
    // Qué hacer con un "OUT ANTES DE: …" escrito por el CD: 'aplicar' lo lleva
    // ahí, 'ignorar' es lo que se hacía antes y está para poder medir la
    // diferencia.
    ordenes: 'aplicar'
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/**
 * ¿Este borde merece que alguien lo mire?
 *
 * Ojo con lo que mide `confidence`: dice qué tan bien enganchó la nota del CD
 * con el transcript, no si el corte que salió de ahí es bueno. Son cosas
 * distintas — un marcador puede caer exactamente donde la nota decía y aun así
 * cortar a mitad de frase, porque la nota apuntaba a media frase.
 *
 * Por eso saltearse los bloques de confianza alta dejaba fuera del afinado
 * cortes que estaban mal: medido sobre el curso con `tools/mirar-colgados.js`,
 * 6 de los 27 bloques que terminaban colgando ni siquiera se miraron, y en los 6
 * la regla sola —sin gastar una consulta al modelo— elegía un corte que cerraba
 * la frase. Mirarlos no sale caro: lo que cuesta es preguntarle al modelo, y eso
 * lo sigue decidiendo `clearMargin`, que solo se activa cuando hay empate.
 */
function needsCriterion(block, options) {
    if (!block) return false;
    if (opt(options, 'mirar') === 'todos') return true;
    // Una orden escrita del CD se mira siempre, aunque el bloque haya enganchado
    // perfecto: engancharon los marcadores, que es otra cosa que lo que la nota
    // pide. Sin esta salida, el bloque 13 de la clase 1 —confianza alta y un
    // "OUT ANTES DE" escrito— no se miraba nunca.
    if (opt(options, 'ordenes') === 'aplicar'
        && (ordenDelCd.para(block, 'IN') || ordenDelCd.para(block, 'OUT'))) return true;
    if (block.confidence !== 'alta') return true;
    for (const edge of [block.in, block.out]) {
        if (!edge) continue;
        if (!edge.anchored) return true;
        if (edge.snap && /no hay/.test(edge.snap.how)) return true;
    }
    return false;
}

/**
 * Cuánto vale un punto de corte, sin preguntarle a nadie.
 * Cierra una frase > cae en una pausa larga > está cerca de donde dice la nota.
 */
function scoreCandidate(candidate, words, kind, anchorTime) {
    const list = speech.spoken(words);
    const frontier = candidate.frontier;
    let score = 0;

    const before = list.filter(w => w.end <= frontier + 0.02).pop();
    const after = list.find(w => w.start >= frontier - 0.02);

    if (kind === 'OUT') {
        if (before && speech.endsSentence(before)) score += 3;
        if (after && speech.isChatter(after, candidate.gapSec)) score += 1.5;
    } else {
        if (!before || speech.endsSentence(before)) score += 3;
        if (before && speech.isChatter(before, candidate.gapSec)) score += 1.5;
    }

    score += Math.min(candidate.gapSec == null ? 0 : candidate.gapSec, 2) * 1.5;
    if (candidate.isCue) score += 2;
    score -= Math.abs(frontier - anchorTime) * 0.4;

    return Math.round(score * 100) / 100;
}

/**
 * Renumera la lista que se le va a mostrar al modelo.
 *
 * `resolveChoice` resuelve la elección como `candidates[choice - 1]`, así que la
 * numeración tiene que ir corrida. Al descartar los candidatos que dejan chatter
 * quedan huecos —[1][2][5][6]…— y el modelo que responde "[5]" terminaría en un
 * corte que no es el que leyó.
 */
function renumbered(candidates) {
    const list = candidates.map((candidate, i) => ({ ...candidate, index: i + 1 }));
    const current = list.findIndex(c => c.isCurrent);
    return { candidates: list, current: current === -1 ? 0 : current + 1 };
}

/**
 * ¿El corte deja bloque en pie, o se pasó del otro extremo?
 *
 * Cada borde se afina por su cuenta y no sabe dónde quedó el otro. En el bloque
 * 9 de la clase 13 el IN se fue a 582.567 y el OUT a 582.533: cruzados por 34
 * milésimas, con lo que el bloque salió durando -0.03 s y desapareció del corte
 * sin que nadie lo hubiera decidido.
 */
function fitsInBlock(candidate, block, kind, options) {
    const minimo = opt(options, 'minBlockSec');
    if (kind === 'IN') {
        return block.endSec == null || candidate.time <= block.endSec - minimo;
    }
    return block.startSec == null || candidate.time >= block.startSec + minimo;
}

/** Los puntos donde el corte dejaría el bloque abierto o cerrado con chatter. */
function dropsChatter(candidate, words, kind) {
    const list = speech.spoken(words);
    if (kind === 'OUT') {
        const before = list.filter(w => w.end <= candidate.frontier + 0.02).pop();
        return before ? speech.isChatter(before, 999) : false;
    }
    // El conteo se mira aparte de la primera palabra. En la clase 6 el bloque
    // abría con «Claqueta 6, clase 6. 3, 2, 1. Ya Clauco…» y el candidato pasaba
    // el filtro porque "Claqueta" no está en ninguna lista de charla: lo que hay
    // que ver no es la palabra que sigue al corte, es si la claqueta hablada
    // entera queda dentro.
    if (speech.abreConConteo(words, candidate.frontier)) return true;
    const after = list.find(w => w.start >= candidate.frontier - 0.02);
    return after ? speech.isChatter(after, 999, null, list[list.indexOf(after) + 1]) : false;
}

/**
 * Suma los finales (o arranques) de frase de la ventana a la lista de candidatos.
 *
 * `buildCandidates` ofrece fronteras de palabra priorizando las pausas reales, y
 * en un tramo hablado de corrido eso da diez cortes con pausa 0.00 repartidos en
 * segundo y medio: todos igual de malos y ninguno donde cierra la idea. Pasó en
 * el bloque 4 de la clase 01 — el cierre bueno estaba en "…ese código." y no
 * figuraba en la lista, así que el modelo eligió el menos malo y el bloque quedó
 * colgando en "que le va a dar".
 */
function withSentenceCandidates(built, words, targetTime, kind, options) {
    const list = speech.spoken(words);
    const window = opt(options, 'windowSec');
    const pad = opt(options, 'padFrames') / opt(options, 'fps');
    const merged = (built.candidates || []).slice();

    const alreadyThere = frontier => merged.some(c => Math.abs(c.frontier - frontier) < 0.05);

    for (let i = 0; i < list.length; i++) {
        const word = list[i];
        const next = list[i + 1];
        const previous = list[i - 1];

        let frontier = null;
        let gap = 999;
        if (kind === 'OUT' && speech.endsSentence(word)) {
            frontier = word.end;
            gap = next ? Math.max(0, next.start - word.end) : 999;
        } else if (kind === 'IN' && (!previous || speech.endsSentence(previous))) {
            frontier = word.start;
            gap = previous ? Math.max(0, word.start - previous.end) : 999;
        }
        if (frontier == null) continue;
        if (Math.abs(frontier - targetTime) > window) continue;
        if (alreadyThere(frontier)) continue;

        // El colchón de aire va hacia el silencio, sin invadir a la palabra vecina.
        const time = kind === 'OUT'
            ? Math.min(frontier + pad, next ? next.start : frontier + pad)
            : Math.max(frontier - pad, previous ? previous.end : 0);

        merged.push({
            index: 0,
            time: Math.round(time * 1000) / 1000,
            frontier,
            gapSec: Math.round(gap * 100) / 100,
            wordIdx: i,
            isCurrent: false,
            isCue: false,
            fromSentence: true
        });
    }

    merged.sort((a, b) => a.frontier - b.frontier);
    merged.forEach((candidate, i) => { candidate.index = i + 1; });

    const current = merged.findIndex(c => c.isCurrent);
    return { candidates: merged, current: current === -1 ? 0 : current + 1 };
}

/** Dónde aparece en el transcript la frase que escribió el CD (para marcar ★). */
function cueTimesFor(words, cue, kind, options) {
    if (!cue) return [];
    const matches = anchor.findMatches(words, cue, kind, {
        truncatedLen: 1,
        minScore: 0.6,
        fps: opt(options, 'fps')
    });
    return matches.map(m => m.time);
}

/** Lo que dice el bloque de al lado, para que el modelo vea si algo se repite. */
function neighbourText(blocks, index, kind, words, options) {
    const neighbour = kind === 'IN' ? blocks[index - 1] : blocks[index + 1];
    if (!neighbour) return null;
    const text = speech.textInside(words, neighbour.startSec, neighbour.endSec);
    if (!text) return null;
    const limit = opt(options, 'neighbourWords');
    const parts = text.split(/\s+/);
    return {
        label: kind === 'IN' ? 'FINAL DEL BLOQUE ANTERIOR' : 'ARRANQUE DEL BLOQUE SIGUIENTE',
        text: kind === 'IN'
            ? parts.slice(-limit).join(' ')
            : parts.slice(0, limit).join(' ')
    };
}

/**
 * La nota del CD, si le habla a este borde.
 *
 * Una nota de post ("POST: highlight en…") no le habla a ninguno de los dos y va
 * igual: describe el bloque y ayuda a entender de qué se trata. La que sí elige
 * lado es la orden de corte.
 */
function notaParaEsteBorde(block, kind) {
    const texto = block.note || '';
    if (!texto) return '';
    const orden = ordenDelCd.para(block, kind === 'IN' ? 'OUT' : 'IN');
    // Si la orden que trae es para el OTRO borde, este no tiene nada que hacer
    // con ella.
    return orden ? '' : texto;
}

/**
 * Afina un borde. Devuelve siempre algo aplicable: si el modelo no está, no
 * contesta o contesta cualquier cosa, manda lo que ya había.
 *
 * @param {object} params { words, edge, block, blocks, index, kind, options, ai }
 */
async function refineEdge(params) {
    const { words, edge, block, blocks, index, kind, options } = params;
    const result = {
        changed: false,
        timeSec: edge.timeSec != null ? edge.timeSec : edge.alignedSec,
        decidedBy: edge.decidedBy || 'nota',
        reason: null,
        candidateCount: 0,
        askedModel: false
    };

    // Si el CD escribió dónde va este corte, eso no se somete a votación: la
    // ventana que ve el modelo son ~60 palabras y la frase que pide suele caer
    // fuera, así que sin esto la orden no llegaba a ser ni una opción.
    const orden = opt(options, 'ordenes') === 'aplicar' ? ordenDelCd.para(block, kind) : null;
    const pedido = orden
        ? ordenDelCd.ubicar(words, orden, blocks, index, { ...options, referencia: result.timeSec })
        : null;
    if (orden && pedido && pedido.seguro) {
        const cambia = Math.abs(pedido.timeSec - result.timeSec) > 1 / opt(options, 'fps');
        result.timeSec = pedido.timeSec;
        result.changed = cambia;
        result.decidedBy = 'orden';
        result.reason = ordenDelCd.comoSeLee(orden, pedido);
        return result;
    }

    const cue = kind === 'IN' ? block.cueIn : block.cueOut;
    // Cuando la frase se reconoció pero hay dos tomas igual de buenas, se ofrece
    // marcada con ★ y desempata el resto. Si ni siquiera se reconoció, no se
    // ofrece: sería empujar el corte hacia una frase que no es la que pidieron.
    const sugerida = pedido && pedido.reconocida ? [pedido.timeSec] : [];
    const cueTimes = cueTimesFor(words, cue, kind, options).concat(sugerida);
    const raw = precision.buildCandidates(words, result.timeSec, kind, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames'),
        windowSec: opt(options, 'windowSec'),
        maxCandidates: opt(options, 'maxCandidates'),
        cueTimes
    });
    const built = withSentenceCandidates(raw, words, result.timeSec, kind, options);

    const usable = (built.candidates || [])
        .filter(c => !dropsChatter(c, words, kind))
        .filter(c => fitsInBlock(c, block, kind, options));
    result.candidateCount = usable.length;
    if (usable.length < 2) {
        result.reason = 'no hay más de un corte posible por acá';
        return result;
    }

    const scored = usable
        .map(c => ({ ...c, score: scoreCandidate(c, words, kind, result.timeSec) }))
        .sort((a, b) => b.score - a.score);
    const margin = scored[0].score - scored[1].score;

    if (margin >= opt(options, 'clearMargin')) {
        if (Math.abs(scored[0].time - result.timeSec) > 1 / opt(options, 'fps')) {
            result.timeSec = scored[0].time;
            result.changed = true;
        }
        result.decidedBy = 'regla';
        result.reason = `gana un corte con claridad (${scored[0].score} contra ${scored[1].score})`;
        return result;
    }

    if (!params.ai) {
        result.reason = `hay ${usable.length} cortes parecidos y no hay modelo: se deja donde está`;
        return result;
    }

    if (params.puedePreguntar === false) {
        result.reason = `hay ${usable.length} cortes parecidos y este bloque enganchó bien: se deja donde está`;
        return result;
    }

    // Empate: acá es donde vale preguntar. Se le muestran los mismos candidatos
    // que juegan por regla, sin los que dejan chatter: si se le pasa la lista sin
    // filtrar, el modelo elige uno de esos y el bloque vuelve a cerrar en "Pausa."
    // aunque el filtro determinista ya lo había descartado.
    const shown = renumbered(usable);
    const unit = {
        kind,
        blockNum: index + 1,
        blockCount: blocks.length,
        markerTime: result.timeSec,
        candidates: shown.candidates,
        current: shown.current,
        cue,
        cuePartial: Boolean(cue && cue.length >= 45),
        notes: [
            // La nota del CD viaja siempre en el marcador de entrada, pero casi
            // siempre habla de la salida. Puesta en el borde del que no habla es
            // ruido —"OUT ANTES DE …" mientras se afina el IN—, así que se le
            // muestra solo al borde que menciona.
            { label: 'nota del bloque', text: notaParaEsteBorde(block, kind) },
            { label: kind === 'IN' ? 'con qué abre' : 'con qué cierra', text: cue || '' },
            sugerida.length
                ? { label: 'dónde lo pidió el CD', text: `${ordenDelCd.comoSeLee(orden, pedido)}, marcado con ★` }
                : null
        ].filter(n => n && n.text),
        neighbour: neighbourText(blocks, index, kind, words, options),
        hint: `las reglas dejaron el corte en ${result.timeSec.toFixed(1)}s`
    };

    const prompt = precision.buildChoicePrompt(unit, words, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames')
    });

    result.askedModel = true;
    const response = await params.ai.ask({
        system: claseEntera.conLaClase(prompt.systemMsg, params.claseTexto),
        prompt: prompt.prompt,
        signal: params.signal
    });

    const decision = precision.resolveChoice(response, unit);
    if (!decision.ok) {
        result.reason = `el modelo no ayudó (${decision.detail}): se deja donde está`;
        return result;
    }

    if (Math.abs(decision.time - result.timeSec) > 1 / opt(options, 'fps')) {
        result.timeSec = decision.time;
        result.changed = true;
    }
    result.decidedBy = 'ia';
    result.reason = decision.reason || decision.detail;
    return result;
}

/**
 * Afina los bordes dudosos de una clase. Muta los bloques del alineado (que es el
 * objeto que después se guarda y se dibuja) y devuelve el resumen.
 *
 * @param {object} params { alignResult, words, options, ai, onProgress, signal }
 */
/**
 * Vuelve a medir el frame contra el audio después de mover un borde.
 *
 * Sin esto, un corte elegido acá se aplicaría con el tiempo de la palabra que da
 * el transcript, sin el colchón de aire y sin el ajuste al ataque real del
 * sonido: se oiría el corte.
 *
 * Devuelve la medición entera y no solo el tiempo porque `edge.audio` —cuánto
 * aire quedó entre el corte y el sonido— hay que reescribirlo. Quedándose solo
 * con el tiempo, el borde se movía pero seguía llevando la medición del lugar
 * donde estaba antes, y todo lo que lee ese campo (el diagnóstico, la vara de
 * `tools/medir-cortes.js`) juzgaba una posición que ya no existía.
 */
function remeasure(edge, params) {
    const { words, wav, kind, options } = params;
    if (!wav) return { timeSec: edge.timeSec, audio: null };

    const limits = speech.wordLimits(words, edge.timeSec, kind);
    const measured = onset.measure(wav, edge.timeSec, kind, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames'),
        minTime: limits.minTime,
        maxTime: limits.maxTime
    });
    if (!measured || measured.applyTime == null) return { timeSec: edge.timeSec, audio: null };

    return {
        timeSec: measured.applyTime,
        audio: {
            appliedSec: Math.round(measured.applyTime * 1000) / 1000,
            airFrames: measured.airFrames == null ? null : measured.airFrames,
            code: measured.code || null,
            message: measured.message || null
        }
    };
}

async function refineClass(params) {
    const { alignResult, words, wav, options } = params;
    const blocks = alignResult.blocks || [];
    const stats = {
        revisados: 0, cambiados: 0, porRegla: 0, porIa: 0,
        porOrden: 0, consultas: 0, fallosDelModelo: 0
    };

    // Una sola vez y antes de mover nada: si se recalculara después de cada borde
    // el texto cambiaría en cada consulta y Ollama tendría que releerlo entero.
    const claseTexto = opt(options, 'contexto') === 'clase'
        ? claseEntera.texto(blocks, words)
        : '';

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!needsCriterion(block, options)) continue;
        stats.revisados++;

        // La regla la pasa cualquiera; la consulta al modelo se la gana el que
        // de verdad quedó dudoso.
        const puedePreguntar = opt(options, 'preguntar') === 'todos'
            || needsCriterion(block, { ...options, mirar: 'dudosos' });

        for (const kind of ['IN', 'OUT']) {
            const edge = kind === 'IN' ? block.in : block.out;
            if (!edge) continue;
            edge.timeSec = kind === 'IN' ? block.startSec : block.endSec;

            const refined = await refineEdge({
                words, edge, block, blocks, index: i, kind, options,
                claseTexto, puedePreguntar,
                ai: params.ai,
                signal: params.signal
            });

            if (refined.askedModel) stats.consultas++;
            if (refined.decidedBy === 'orden') stats.porOrden++;
            else if (refined.decidedBy === 'ia') stats.porIa++;
            else if (refined.decidedBy === 'regla' && refined.changed) stats.porRegla++;
            if (refined.askedModel && refined.decidedBy !== 'ia') stats.fallosDelModelo++;

            edge.refine = {
                decidedBy: refined.decidedBy,
                reason: refined.reason,
                candidates: refined.candidateCount,
                askedModel: refined.askedModel
            };

            if (!refined.changed) continue;
            stats.cambiados++;
            edge.decidedBy = refined.decidedBy;
            const medido = remeasure({ timeSec: refined.timeSec }, { words, wav, kind, options });
            edge.timeSec = medido.timeSec;
            if (medido.audio) edge.audio = medido.audio;
            edge.alignedSec = Math.round(edge.timeSec * 1000) / 1000;
            edge.shiftSec = Math.round((edge.alignedSec - edge.originalSec) * 1000) / 1000;
            if (kind === 'IN') block.startSec = edge.alignedSec;
            else block.endSec = edge.alignedSec;
        }

        if (params.onProgress) params.onProgress({ index: i, total: blocks.length, stats });
    }

    alignResult.refine = stats;
    return stats;
}

module.exports = {
    refineClass,
    refineEdge,
    withSentenceCandidates,
    remeasure,
    needsCriterion,
    scoreCandidate,
    dropsChatter,
    fitsInBlock,
    renumbered,
    cueTimesFor,
    neighbourText,
    DEFAULTS
};
