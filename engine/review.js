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
const notas = require('./notas');
const silencios = require('./silencios');
const estadoClase = require('./estado-clase');

const CONTEXT_SEC = 12;

/**
 * Todo lo que el visor dibuja de una clase.
 * @param {object} params { root, cls, buckets }
 */
function loadReview(params) {
    const { root, cls } = params;
    const sequenceName = cls.sequenceName;

    // La clase puede estar hecha aunque el Backup de ESTA raíz esté vacío: se
    // procesó entrando por la carpeta del día y ahora se entró por la del curso.
    // Lo que guardó en su propia carpeta vuelve acá y el visor abre igual, que
    // es de lo que se trata: mirar una clase no debería depender de por dónde se
    // haya entrado.
    let cutplan = workspace.readJson(workspace.artifact(root, sequenceName, 'cutplan'));
    if (!cutplan) {
        estadoClase.hidratar({ root, cls });
        cutplan = workspace.readJson(workspace.artifact(root, sequenceName, 'cutplan'));
    }
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
        cameras: (cls.videos || []).map((v, i) => ({ index: i, name: v.name, path: v.path })),
        cutplan,
        offset: align ? align.offset : null,
        refine: align ? align.refine : null,
        // Lo que se dijo dos veces y ya se quitó. Va al visor para que el guion
        // pueda contar lo que se hizo en vez de dejarlo como pendiente.
        repeticiones: align ? align.repeticiones || null : null,
        repaso: align ? align.repaso || null : null,
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
        segments: transcript ? transcript.segments : [],
        // El panel alumbra palabra por palabra, así que necesita los tiempos de
        // cada una. Van todas y no solo las de los bloques guardados: mover un
        // borde hacia afuera deja al descubierto material que no estaba adentro,
        // y el panel tiene que poder leerlo sin volver a pedir nada. La clase más
        // habladora del curso pesa 272 KB acá.
        words: transcript ? transcript.words || [] : [],
        // Lo que el editor escribió revisando: la nota de cada bloque cuando la
        // cambió, y los comentarios que dejó sobre pedazos del transcript.
        notas: notas.leer(root, sequenceName),
        // Dónde no se dice nada. El panel las intercala en el texto: leyendo el
        // transcript corrido, diez segundos de silencio son invisibles y el
        // video parece ir atrasado. El cache y su frescura los maneja `silencios`.
        silencios: silencios.asegurar({
            root, sequenceName,
            wavPath: cls.liveMixPath,
            palabras: transcript ? transcript.words : null
        }),
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
            // Si el editor lo vuelve a encender, el motivo por el que la
            // herramienta lo había apagado deja de aplicar y no puede quedarse
            // pegado al bloque.
            disabledReason: change.keep === false ? (change.disabledReason || block.disabledReason || '') : '',
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
