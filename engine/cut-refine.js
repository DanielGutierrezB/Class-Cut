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
const ai = require('./ai-local');

const DEFAULTS = {
    fps: 30,
    padFrames: 10,
    windowSec: 18,
    maxCandidates: 10,
    // Ventaja mínima para no consultar al modelo. Por debajo, las dos opciones
    // son defendibles y la diferencia la nota alguien que entiende la clase.
    clearMargin: 1.5,
    neighbourWords: 40
};

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/** ¿Este borde merece que alguien lo mire? */
function needsCriterion(block) {
    if (!block) return false;
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

/** Los puntos donde el corte dejaría el bloque abierto o cerrado con chatter. */
function dropsChatter(candidate, words, kind) {
    const list = speech.spoken(words);
    if (kind === 'OUT') {
        const before = list.filter(w => w.end <= candidate.frontier + 0.02).pop();
        return before ? speech.isChatter(before, 999) : false;
    }
    const after = list.find(w => w.start >= candidate.frontier - 0.02);
    return after ? speech.isChatter(after, 999) : false;
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
 * Afina un borde. Devuelve siempre algo aplicable: si el modelo no está, no
 * contesta o contesta cualquier cosa, manda lo que ya había.
 *
 * @param {object} params { words, edge, block, blocks, index, kind, options, useAi }
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

    const cue = kind === 'IN' ? block.cueIn : block.cueOut;
    const raw = precision.buildCandidates(words, result.timeSec, kind, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames'),
        windowSec: opt(options, 'windowSec'),
        maxCandidates: opt(options, 'maxCandidates'),
        cueTimes: cueTimesFor(words, cue, kind, options)
    });
    const built = withSentenceCandidates(raw, words, result.timeSec, kind, options);

    const usable = (built.candidates || []).filter(c => !dropsChatter(c, words, kind));
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

    if (!params.useAi) {
        result.reason = `hay ${usable.length} cortes parecidos y la IA está apagada: se deja donde está`;
        return result;
    }

    // Empate: acá es donde vale preguntar.
    const unit = {
        kind,
        blockNum: index + 1,
        blockCount: blocks.length,
        markerTime: result.timeSec,
        candidates: built.candidates,
        current: built.current,
        cue,
        cuePartial: Boolean(cue && cue.length >= 45),
        notes: [
            { label: 'nota del bloque', text: block.note || '' },
            { label: kind === 'IN' ? 'con qué abre' : 'con qué cierra', text: cue || '' }
        ].filter(n => n.text),
        neighbour: neighbourText(blocks, index, kind, words, options),
        hint: `las reglas dejaron el corte en ${result.timeSec.toFixed(1)}s`
    };

    const prompt = precision.buildChoicePrompt(unit, words, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames')
    });

    result.askedModel = true;
    const response = await ai.ask({
        system: prompt.systemMsg,
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
 * @param {object} params { alignResult, words, options, useAi, onProgress, signal }
 */
/**
 * Vuelve a medir el frame contra el audio después de mover un borde.
 *
 * Sin esto, un corte elegido acá se aplicaría con el tiempo de la palabra que da
 * el transcript, sin el colchón de aire y sin el ajuste al ataque real del
 * sonido: se oiría el corte.
 */
function remeasure(edge, params) {
    const { words, wav, kind, options } = params;
    if (!wav) return edge.timeSec;

    const limits = speech.wordLimits(words, edge.timeSec, kind);
    const measured = onset.measure(wav, edge.timeSec, kind, {
        fps: opt(options, 'fps'),
        padFrames: opt(options, 'padFrames'),
        minTime: limits.minTime,
        maxTime: limits.maxTime
    });
    return measured && measured.applyTime != null ? measured.applyTime : edge.timeSec;
}

async function refineClass(params) {
    const { alignResult, words, wav, options } = params;
    const blocks = alignResult.blocks || [];
    const stats = { revisados: 0, cambiados: 0, porRegla: 0, porIa: 0, consultas: 0, fallosDelModelo: 0 };

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!needsCriterion(block)) continue;
        stats.revisados++;

        for (const kind of ['IN', 'OUT']) {
            const edge = kind === 'IN' ? block.in : block.out;
            if (!edge) continue;
            edge.timeSec = kind === 'IN' ? block.startSec : block.endSec;

            const refined = await refineEdge({
                words, edge, block, blocks, index: i, kind, options,
                useAi: params.useAi,
                signal: params.signal
            });

            if (refined.askedModel) stats.consultas++;
            if (refined.decidedBy === 'ia') stats.porIa++;
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
            edge.timeSec = remeasure({ timeSec: refined.timeSec }, { words, wav, kind, options });
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
    cueTimesFor,
    neighbourText,
    DEFAULTS
};
