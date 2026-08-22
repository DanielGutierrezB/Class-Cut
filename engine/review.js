'use strict';
/**
 * review.js — Lo que necesita el visor para dejar revisar un corte, y lo que
 * hace cuando el editor toca algo.
 *
 * Revisar no recalcula nada: lee los artefactos que dejó el pipeline en el Backup
 * de la clase. Y guardar tampoco vuelve a transcribir ni a alinear — se reescribe
 * el plan de cortes y se regenera el XML, que son milisegundos. Por eso mover un
 * borde y volver a exportar es instantáneo, y por eso se puede hacer veinte veces
 * sin miedo: el material no se toca nunca.
 */

const workspace = require('./workspace');
const waveform = require('./waveform');
const exporter = require('./export');
const cutplanEngine = require('./cutplan');

const CONTEXT_SEC = 12;

/**
 * Todo lo que el visor dibuja de una clase.
 * @param {object} params { root, cls, buckets }
 */
function loadReview(params) {
    const { root, cls } = params;
    const sequenceName = cls.sequenceName;

    const cutplan = workspace.readJson(workspace.artifact(root, sequenceName, 'cutplan'));
    if (!cutplan) {
        return { ok: false, error: 'Esta clase todavía no se procesó.' };
    }
    const align = workspace.readJson(workspace.artifact(root, sequenceName, 'align'));
    const transcript = workspace.readJson(workspace.artifact(root, sequenceName, 'transcript'));
    const coherence = workspace.readJson(workspace.artifact(root, sequenceName, 'coherence'));

    const wave = cls.liveMixPath ? waveform.peaks(cls.liveMixPath, params.buckets || 3000) : null;

    return {
        ok: true,
        sequenceName,
        classNumber: cls.classNumber,
        durationSec: cls.durationSec,
        fps: cls.fps || 30,
        liveMixPath: cls.liveMixPath,
        cameras: (cls.videos || []).map((v, i) => ({ index: i, name: v.name })),
        cutplan,
        offset: align ? align.offset : null,
        refine: align ? align.refine : null,
        // Los bordes traen quién los decidió (la nota, una regla o el modelo) y
        // por qué; el visor lo muestra al lado de cada bloque.
        edges: align ? align.blocks.map(b => ({
            index: b.index,
            in: edgeSummary(b.in),
            out: edgeSummary(b.out)
        })) : [],
        coherence: coherence
            ? { blocks: coherence.blocks, findings: coherence.findings, wordCount: coherence.wordCount, stats: coherence.stats }
            : null,
        // Las palabras enteras de una clase de una hora son varios MB y el visor
        // solo muestra el texto alrededor del bloque que se está mirando: van las
        // frases, que son cien veces menos.
        segments: transcript ? transcript.segments : [],
        waveform: wave
    };
}

function edgeSummary(edge) {
    if (!edge) return null;
    return {
        decidedBy: edge.decidedBy || 'nota',
        reason: edge.reason || '',
        snap: edge.snap ? edge.snap.how : null,
        chatterRemoved: edge.chatterRemoved || null,
        refine: edge.refine || null,
        score: edge.score
    };
}

/** Texto alrededor de un tramo, para leer qué se dice justo antes y después. */
function contextAround(segments, startSec, endSec, marginSec) {
    const margin = marginSec == null ? CONTEXT_SEC : marginSec;
    return (segments || []).filter(s => s.end >= startSec - margin && s.start <= endSec + margin);
}

/**
 * Guarda los cambios del visor y regenera el XML de la clase.
 * Se recalculan las posiciones en la línea de tiempo (mover un borde corre todo
 * lo que viene después) en vez de confiar en las que trae el plan editado.
 */
function saveReview(params) {
    const { root, cls, segments, viewMap } = params;
    const sequenceName = cls.sequenceName;

    const align = workspace.readJson(workspace.artifact(root, sequenceName, 'align'));
    if (!align) return { ok: false, error: 'Falta el alineado de esta clase.' };

    const edited = new Map((segments || []).map(s => [s.blockIndex, s]));
    const blocks = align.blocks.map(block => {
        const change = edited.get(block.index);
        if (!change) return block;
        return {
            ...block,
            startSec: change.sourceStartSec != null ? change.sourceStartSec : block.startSec,
            endSec: change.sourceEndSec != null ? change.sourceEndSec : block.endSec,
            view: change.view || block.view,
            enabled: change.keep !== false,
            confidence: change.reviewed ? 'alta' : block.confidence
        };
    });

    const plan = cutplanEngine.buildCutplan({
        blocks,
        videos: cls.videos,
        audios: cls.audios,
        durationSec: cls.durationSec,
        fps: cls.fps || 30,
        viewMap
    });

    let exported;
    try {
        exported = exporter.exportClass({ root, cls, alignResult: { ...align, blocks }, cutplan: plan });
    } catch (err) {
        return { ok: false, error: `No se pudo escribir el XML: ${err.message}` };
    }

    workspace.appendLog(workspace.artifact(root, sequenceName, 'log'),
        `revisión: ${plan.totals.kept} bloques · ${Math.round(plan.totals.keepSec)}s`);

    return { ok: true, cutplan: plan, exported };
}

module.exports = { loadReview, saveReview, contextAround, CONTEXT_SEC };
