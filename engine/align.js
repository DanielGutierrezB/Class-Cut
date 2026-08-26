'use strict';
/**
 * align.js — Mueve los marcadores del CD a donde de verdad se dijo lo que anotó.
 *
 * El CD marca mientras se graba, así que sus marcas están cerca pero no encima:
 * en el curso real, el IN del primer bloque de la clase 04 está en 2:41 y la toma
 * buena arranca en 2:42.5. Y hay hasta cinco tomas casi idénticas de la misma
 * frase, con el profesor repitiéndola hasta que sale — la única que sirve es la
 * última, que es también la que queda más cerca de la marca.
 *
 * Tres fuentes, cada una para lo suyo:
 *   1. La claqueta da el desfase de toda la clase (y se descarta si no mejora).
 *   2. La frase que el CD escribió en el marcador dice QUÉ palabras abren y
 *      cierran el bloque (`marker-anchor`, emparejado difuso porque el CD escribe
 *      de oído y el STT transcribe a su manera).
 *   3. El audio dice DÓNDE exactamente cae el corte (`audio-onset`), con su
 *      colchón de aire.
 *
 * Nada se mueve a ciegas: lo que no llega a puntaje se queda donde estaba, y las
 * invariantes (IN antes que OUT, sin solapes, dentro del material) se revisan al
 * final. Los comentarios de los marcadores no se tocan nunca.
 */

const anchor = require('./vendor/marker-anchor');
const onset = require('./vendor/audio-onset');
const clapDetect = require('./clap-detect');
const speech = require('./speech-edges');

// 2: los bordes pasan por el ajuste a frase y el recorte del habla del director,
// y el audio mide el frame con los límites de la palabra vecina.
// 3: cada borde dice si el corte cae encima de alguien hablando, y los que la
// onda no pudo medir lo dicen en vez de quedarse sin medición.
const ALIGN_VERSION = 3;

const DEFAULTS = {
    fps: 30,
    padFrames: 10,
    // Los mismos umbrales de Editor-Pro: desde 0.85 se aplica solo, entre 0.6 y
    // 0.85 se aplica pero queda para revisar, por debajo no se toca.
    minScore: 0.6,
    autoScore: 0.85,
    // El cue del CD viene recortado a ~50 caracteres SIEMPRE (la última palabra
    // del IN y la primera del OUT quedan a medias), así que se le dice al
    // emparejador que lo dé por recortado en vez de adivinarlo por el largo, que
    // acá ya viene sin la nota ni el conteo y sale corto.
    truncatedLen: 1,
    maxShiftSec: 90,
    sanityBlocks: 6,     // con cuántos bloques se comprueba que el desfase sirve
    maxOffsetSec: 60     // más que esto no se aplica solo
};

const CONFIDENCE = { alta: 'alta', media: 'media', baja: 'baja' };

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

function round(n) {
    return Math.round(n * 1000) / 1000;
}

function fmt(seconds) {
    if (seconds == null) return '—';
    const s = Math.max(0, seconds);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Prueba un desfase: con él puesto, ¿cuánto le sobra a cada marcador para llegar
 * a sus palabras? Se miran solo los primeros bloques y solo los que anclan sin
 * dudar, porque son los únicos donde la distancia significa algo.
 *
 * Mirar el PUNTAJE del emparejamiento no servía: la frase del CD aparece en el
 * transcript con desfase o sin él, así que daba lo mismo (0.74 contra 0.74) y
 * cualquier desfase pasaba la prueba. La DISTANCIA sí distingue.
 *
 * @returns {{error, samples, medianShift}} error = distancia mediana que queda
 */
function offsetProbe(blocks, words, offsetSec, options) {
    const take = Math.min(blocks.length, opt(options, 'sanityBlocks'));
    const shifts = [];
    for (let i = 0; i < take; i++) {
        const block = blocks[i];
        if (!block.cueIn) continue;
        const current = block.startSec + offsetSec;
        const result = anchor.anchorFor(words, block.cueIn, 'IN', current, {
            truncatedLen: opt(options, 'truncatedLen'),
            minScore: opt(options, 'minScore'),
            autoScore: opt(options, 'autoScore'),
            fps: opt(options, 'fps')
        });
        if (result.ok && result.score >= opt(options, 'autoScore') && !result.ambiguous) {
            shifts.push(result.time - current);
        }
    }
    if (!shifts.length) return { error: null, samples: 0, medianShift: 0 };
    return {
        error: round(median(shifts.map(Math.abs))),
        samples: shifts.length,
        medianShift: round(median(shifts))
    };
}

/**
 * Elige el desfase de la clase entre los candidatos que hay: el de la claqueta
 * (el que pidió el editor), el de no mover nada, y el que se deduce de la deriva
 * de los propios anclajes — este último es la red para las clases donde la
 * claqueta no se oye o el golpe no aparece.
 */
function chooseOffset(blocks, words, clap, options) {
    const zero = offsetProbe(blocks, words, 0, options);
    const candidates = [{ label: 'sin desfase', value: 0, probe: zero }];

    if (clap.found && clap.offsetSec) {
        candidates.push({ label: 'claqueta', value: clap.offsetSec, probe: null });
    }
    if (zero.samples >= 3 && Math.abs(zero.medianShift) > 0.2) {
        candidates.push({ label: 'deriva de los anclajes', value: zero.medianShift, probe: null });
    }

    for (const candidate of candidates) {
        if (!candidate.probe) candidate.probe = offsetProbe(blocks, words, candidate.value, options);
    }

    const usable = candidates.filter(c => c.probe.error != null);
    if (!usable.length) {
        // Sin un solo bloque que ancle no hay con qué comparar. Entonces manda la
        // claqueta, que es una medición del audio y no una deducción.
        const fromClap = candidates.find(c => c.label === 'claqueta');
        return {
            chosen: fromClap || candidates[0],
            candidates,
            decidedBy: fromClap
                ? 'ningún bloque ancló para comparar: manda la claqueta'
                : 'ningún bloque ancló y no hay claqueta'
        };
    }

    usable.sort((a, b) => {
        if (Math.abs(a.probe.error - b.probe.error) > 0.05) return a.probe.error - b.probe.error;
        // Empate técnico: gana el de la claqueta, que es la referencia física.
        if (a.label === 'claqueta') return -1;
        if (b.label === 'claqueta') return 1;
        return Math.abs(a.value) - Math.abs(b.value);
    });

    return {
        chosen: usable[0],
        candidates,
        decidedBy: `distancia mediana ${usable[0].probe.error}s con ${usable[0].probe.samples} bloques`
    };
}

/**
 * El territorio donde puede caer un borde: entre el bloque de antes y el de
 * después, y nunca antes de la claqueta.
 *
 * El piso de la claqueta se aplica a los IN y no a los OUT: un OUT no puede
 * estar antes que su propio IN, así que ya queda cubierto.
 */
function limitsFor(blocks, index, kind, offsetSec, pisoSec) {
    const prev = blocks[index - 1];
    const next = blocks[index + 1];
    const block = blocks[index];
    if (kind === 'IN') {
        const vecino = prev ? prev.endSec + offsetSec : null;
        return {
            minTime: mayor(vecino, pisoSec),
            maxTime: block.endSec + offsetSec
        };
    }
    return {
        minTime: block.startSec + offsetSec,
        maxTime: next ? next.startSec + offsetSec : null
    };
}

/** El más tardío de dos límites, tratando null como "sin límite". */
function mayor(a, b) {
    if (a == null) return b == null ? null : b;
    if (b == null) return a;
    return Math.max(a, b);
}

/**
 * Fase 1 — Qué palabras abren o cierran el bloque, según la nota del CD.
 * No mira el audio todavía: solo decide de qué frase estamos hablando.
 */
function anchorEdge(params) {
    const { words, cue, kind, currentSec, limits, options } = params;

    const edge = {
        kind,
        originalSec: round(currentSec),
        timeSec: currentSec,
        score: null,
        confidence: CONFIDENCE.baja,
        ambiguous: false,
        snippet: null,
        anchored: false,
        decidedBy: 'nota',
        reason: ''
    };

    if (!cue) {
        edge.reason = 'El marcador no trae texto para buscar.';
        return edge;
    }

    const match = anchor.anchorFor(words, cue, kind, currentSec, {
        truncatedLen: opt(options, 'truncatedLen'),
        minScore: opt(options, 'minScore'),
        autoScore: opt(options, 'autoScore'),
        maxShiftSec: opt(options, 'maxShiftSec'),
        fps: opt(options, 'fps'),
        minTime: limits.minTime,
        maxTime: limits.maxTime
    });

    if (!match.ok) {
        edge.reason = match.reason;
        return edge;
    }

    edge.score = match.score;
    edge.ambiguous = Boolean(match.ambiguous);
    edge.snippet = match.snippet;
    edge.reason = match.reason;

    if (match.score < opt(options, 'minScore')) {
        edge.reason = `${match.reason}: se queda donde estaba.`;
        return edge;
    }

    // Una coincidencia que cae más lejos que `maxShiftSec` no es evidencia de
    // nada. Cuando el CD repite la frase toma tras toma, el texto empareja igual
    // de bien en todas y gana la que puntúe una milésima más, esté donde esté;
    // dónde puso el marcador sí distingue de qué toma habla. En el bloque 13 de
    // la clase 13 la frase se dice trece veces: la buena estaba a 2 s con 0.83 y
    // el ancla se fue a una de 1.00 a 196 s, con lo que el bloque pasó de los 10 s
    // que marcó el CD a 3.4 minutos de tomas falsas.
    if (match.tooFar) {
        edge.reason = `${match.reason}: se queda donde lo dejó el CD.`;
        return edge;
    }

    edge.timeSec = match.time;
    edge.anchored = true;
    edge.decidedBy = 'nota';
    // `confident` ya junta puntaje, ambigüedad y distancia: recalcularlo acá fue
    // justo lo que dejó el bloque 13 en confianza alta pese a estar a 196 s, y
    // por alta nadie volvió a mirarlo.
    edge.confidence = match.confident ? CONFIDENCE.alta : CONFIDENCE.media;
    return edge;
}

/**
 * Fase 2 — Que el borde caiga donde una frase abre o cierra.
 *
 * La nota del CD viene recortada a ~50 caracteres, así que el ancla cae en la
 * última palabra que se pudo emparejar, no necesariamente donde termina la idea.
 * De ahí salían los 103 bloques que cerraban con un fragmento colgando.
 */
function applySnap(edge, words, options) {
    const snap = speech.snapToSentence(words, edge.timeSec, edge.kind, options);
    edge.snap = { how: snap.how, moved: snap.moved, candidates: snap.candidates };
    if (!snap.moved) return edge;

    edge.timeSec = snap.timeSec;
    edge.decidedBy = 'regla';
    edge.reason = `${edge.reason} ${snap.how}.`.trim();
    return edge;
}

/**
 * Fase 3 — El frame exacto, medido en el audio.
 *
 * Los límites de palabra son lo que impide que el colchón de aire se lleve
 * puesta la palabra vecina: sin ellos, un OUT colocado justo después de la
 * última frase se comía el "Pausa" que el profesor le dice al editor, y en el
 * corte se oía "Pau—". Se probó sacarlos y reemplazarlos por el mapa de voz, que
 * no depende de las duraciones de Whisper; el resultado y el porqué están en
 * `speech-edges.wordLimits`.
 */
function refineWithAudio(edge, params) {
    const { words, wav, blockLimits, options } = params;
    const fps = opt(options, 'fps');
    if (!wav) return edge;

    const limits = speech.tightest(
        speech.wordLimits(words, edge.timeSec, edge.kind),
        blockLimits
    );

    const measured = onset.measure(wav, edge.timeSec, edge.kind, {
        fps,
        padFrames: opt(options, 'padFrames'),
        minTime: limits.minTime,
        maxTime: limits.maxTime
    });

    if (measured && measured.applyTime != null) {
        edge.audio = {
            appliedSec: round(measured.applyTime),
            airFrames: measured.airFrames == null ? null : measured.airFrames,
            dentroDelSonido: measured.insideVoice == null ? null : measured.insideVoice,
            code: measured.code || null,
            message: measured.message || null
        };
        edge.timeSec = measured.applyTime;
        return edge;
    }

    // La onda no pudo afirmar nada y el corte se queda con el tiempo del
    // transcript. Eso se dice, igual que en `borde.aplicar`: un borde sin
    // `audio` no se distingue de uno que no se midió nunca, y la medición de
    // defectos lo lee como "acá no hay problema" cuando es el sitio donde el
    // corte tiene más chance de caer encima de una palabra.
    edge.audio = {
        appliedSec: round(edge.timeSec),
        airFrames: null,
        dentroDelSonido: onset.voiceAt(wav, edge.timeSec, { fps }),
        code: 'sin-medida',
        message: 'La onda no encontró un borde de sonido acá: el corte va con el tiempo del transcript.'
    };
    return edge;
}

/** Cierra un borde: los campos con los que viaja al artefacto y a la interfaz. */
function sealEdge(edge, options) {
    const fps = opt(options, 'fps');
    edge.alignedSec = round(edge.timeSec);
    edge.shiftSec = round(edge.alignedSec - edge.originalSec);
    edge.moved = Math.abs(edge.shiftSec) > 1 / fps;
    return edge;
}

/**
 * Alinea todos los bloques de una clase.
 *
 * @param {object} params
 *   blocks         bloques del XML (rodecaster-xml)
 *   words          transcript ya corregido contra el audio
 *   wav            {file, info} del Live-Mix (opcional: sin él manda el transcript)
 *   classNumber    para reconocer "clase N" en la claqueta
 *   clapMarkerSec  dónde puso el CD el marcador de claqueta
 *   durationSec    duración real del material
 * @returns {object} artefacto de alineación (lo que se guarda en align.json)
 */
function alignClass(params) {
    const {
        blocks = [], words = [], wav = null,
        classNumber = null, clapMarkerSec = null, durationSec = null
    } = params || {};
    const options = params && params.options ? params.options : {};
    const fps = opt(options, 'fps');
    const warnings = [];

    // ── 1. Desfase de la clase ──
    const clap = clapDetect.detectClap({ words, wav, classNumber, markerSec: clapMarkerSec });
    const decision = (words.length && blocks.length)
        ? chooseOffset(blocks, words, clap, options)
        : { chosen: { label: 'sin datos', value: 0, probe: { error: null, samples: 0 } }, candidates: [], decidedBy: 'sin transcript' };

    let offsetSec = decision.chosen.value || 0;
    let needsConfirmation = false;

    if (Math.abs(offsetSec) > opt(options, 'maxOffsetSec')) {
        needsConfirmation = true;
        warnings.push({
            code: 'desfase_grande',
            message: `Hay que correr todo ${offsetSec.toFixed(1)} s: es mucho, confirmalo antes de exportar.`
        });
    }
    if (clap.found && decision.chosen.label !== 'claqueta' && clap.offsetSec) {
        warnings.push({
            code: 'claqueta_descartada',
            message: `El desfase de la claqueta (${clap.offsetSec.toFixed(2)} s) dejaba los marcadores más lejos de sus palabras que ${decision.chosen.label} (${offsetSec.toFixed(2)} s).`
        });
    }
    if (!clap.found) {
        warnings.push({ code: 'sin_claqueta_audible', message: clap.reason });
    }

    const offsetReason = `${clap.reason} Se usa ${decision.chosen.label} (${offsetSec.toFixed(2)} s): ${decision.decidedBy}.`;

    // Antes de la claqueta no hay clase: es el piso de todos los IN, acá y en lo
    // que venga después (el afinado y el repaso lo reciben en las opciones).
    const pisoSec = clapDetect.pisoDeLaClase(clap, clapMarkerSec, offsetSec);

    // ── 2. Cada bloque ──
    const aligned = [];
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const inLimits = limitsFor(blocks, i, 'IN', offsetSec, pisoSec);
        const outLimits = limitsFor(blocks, i, 'OUT', offsetSec, pisoSec);

        // 1. La nota del CD dice de qué frase estamos hablando.
        const inEdge = anchorEdge({
            words, cue: block.cueIn, kind: 'IN',
            currentSec: block.startSec + offsetSec, limits: inLimits, options
        });
        const outEdge = anchorEdge({
            words, cue: block.cueOut, kind: 'OUT',
            currentSec: block.endSec + offsetSec, limits: outLimits, options
        });

        // 2. Fuera las órdenes al editor, que es lo que el ancla arrastra cuando
        //    el CD las escribió dentro de la frase ("…nuestro producto. Pausa.").
        const removed = [];
        const trimChatter = () => {
            const cut = speech.trimChatter(words, inEdge.timeSec, outEdge.timeSec, options);
            if (!cut.removed.length) return;
            if (Math.abs(cut.startSec - inEdge.timeSec) > 0.001) {
                inEdge.timeSec = cut.startSec;
                inEdge.decidedBy = 'regla';
            }
            if (Math.abs(cut.endSec - outEdge.timeSec) > 0.001) {
                outEdge.timeSec = cut.endSec;
                outEdge.decidedBy = 'regla';
            }
            removed.push(...cut.removed);
        };
        trimChatter();

        // 3. Que el bloque abra y cierre una idea, no la mitad de una. El IN lleva
        //    su suelo: abrir la frase es lo único de acá que va hacia atrás.
        applySnap(inEdge, words, { ...options, minTime: inLimits.minTime });
        applySnap(outEdge, words, options);
        // Cerrar la frase puede haber vuelto a meter un "Pausa." que también
        // termina en punto, así que se limpia otra vez.
        trimChatter();

        // Y por si algo de arriba se pasó: el piso no se negocia.
        if (pisoSec != null && inEdge.timeSec < pisoSec) {
            inEdge.timeSec = pisoSec;
            inEdge.decidedBy = 'claqueta';
            inEdge.reason = `${inEdge.reason} No puede abrir antes de la claqueta.`.trim();
        }

        // 4. El frame exacto, ya con la palabra vecina como límite.
        refineWithAudio(inEdge, { words, wav, blockLimits: inLimits, options });
        refineWithAudio(outEdge, { words, wav, blockLimits: outLimits, options });
        sealEdge(inEdge, options);
        sealEdge(outEdge, options);

        if (removed.length) {
            inEdge.chatterRemoved = removed;
            outEdge.chatterRemoved = removed;
        }

        aligned.push({
            index: block.index,
            view: block.view,
            // El color que el CD le puso al marcador viaja con el bloque hasta el
            // XML de salida sin que nadie lo reinterprete.
            color: block.color,
            note: block.note,
            complete: block.complete,
            cueIn: block.cueIn,
            cueOut: block.cueOut,
            xmlStartSec: block.startSec,
            xmlEndSec: block.endSec,
            startSec: inEdge.alignedSec,
            endSec: outEdge.alignedSec,
            in: inEdge,
            out: outEdge,
            confidence: worst(inEdge.confidence, outEdge.confidence),
            problems: []
        });
    }

    // ── 3. Invariantes: nada sale de acá violando el orden ni el material ──
    enforce(aligned, { durationSec, fps, warnings });

    const counts = { alta: 0, media: 0, baja: 0 };
    for (const block of aligned) counts[block.confidence]++;
    const moved = aligned.filter(b => b.in.moved || b.out.moved).length;

    return {
        version: ALIGN_VERSION,
        createdAt: new Date().toISOString(),
        fps,
        durationSec,
        // Antes de acá no hay clase. Viaja al artefacto porque las etapas que
        // siguen —el afinado, el repaso— tienen que respetar el mismo suelo.
        pisoSec,
        offset: {
            appliedSec: offsetSec,
            applied: offsetSec !== 0,
            source: decision.chosen.label,
            needsConfirmation,
            method: clap.method,
            confidence: clap.confidence,
            spoken: clap.spoken,
            clap: clap.clap,
            markerSec: clapMarkerSec,
            candidates: decision.candidates.map(c => ({
                label: c.label,
                value: c.value,
                error: c.probe ? c.probe.error : null,
                samples: c.probe ? c.probe.samples : 0
            })),
            reason: offsetReason
        },
        blocks: aligned,
        stats: {
            blocks: aligned.length,
            moved,
            confidence: counts,
            needsReview: aligned.filter(b => b.confidence !== CONFIDENCE.alta).length
        },
        warnings
    };
}

function worst(a, b) {
    if (a === CONFIDENCE.baja || b === CONFIDENCE.baja) return CONFIDENCE.baja;
    if (a === CONFIDENCE.media || b === CONFIDENCE.media) return CONFIDENCE.media;
    return CONFIDENCE.alta;
}

/**
 * Las tres reglas que ningún bloque puede romper: empezar antes de terminar, no
 * pisar al anterior y caber en el material. Lo que se corrige acá baja a "baja"
 * y queda anotado — un bloque recortado a la fuerza hay que mirarlo.
 */
function enforce(blocks, context) {
    const { durationSec, fps, warnings } = context;
    const frame = 1 / fps;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        if (block.startSec < 0) {
            block.startSec = 0;
            block.problems.push('El IN caía antes del inicio del material.');
            block.confidence = CONFIDENCE.baja;
        }

        if (durationSec != null && block.endSec > durationSec) {
            block.endSec = round(durationSec);
            block.problems.push('El OUT caía después del final del material.');
            block.confidence = CONFIDENCE.baja;
            warnings.push({
                code: 'bloque_fuera_del_material',
                message: `El bloque ${block.index + 1} terminaba después del final del material: se recortó.`
            });
        }

        if (block.endSec <= block.startSec) {
            // Un bloque invertido no se puede exportar. Se respeta el IN, que es
            // el que trae el ancla más fiable, y el OUT vuelve al que traía el XML.
            block.endSec = round(Math.max(block.startSec + frame, block.xmlEndSec));
            block.problems.push('El OUT quedó antes que el IN: se volvió al tiempo del XML.');
            block.confidence = CONFIDENCE.baja;
            warnings.push({
                code: 'bloque_invertido',
                message: `El bloque ${block.index + 1} quedó con el OUT antes que el IN: revisalo.`
            });
        }

        const prev = blocks[i - 1];
        if (prev && block.startSec < prev.endSec) {
            const overlap = prev.endSec - block.startSec;
            block.problems.push(`Se solapaba ${overlap.toFixed(2)} s con el bloque anterior.`);
            block.confidence = CONFIDENCE.baja;
            prev.confidence = CONFIDENCE.baja;
            warnings.push({
                code: 'bloques_solapados',
                message: `Los bloques ${prev.index + 1} y ${block.index + 1} se solapan ${overlap.toFixed(2)} s: revisalos.`
            });
        }
    }
}

module.exports = {
    alignClass, anchorEdge, applySnap, refineWithAudio, sealEdge,
    offsetProbe, chooseOffset, limitsFor,
    ALIGN_VERSION, DEFAULTS, CONFIDENCE
};
