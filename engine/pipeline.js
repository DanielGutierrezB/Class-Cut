'use strict';
/**
 * pipeline.js — De una carpeta de clase a su XML cortado.
 *
 * Las cuatro etapas en orden, cada una dejando su artefacto en el Backup de la
 * clase. Solo la primera cuesta tiempo (Whisper); las otras tres son cálculo, así
 * que volver a exportar después de tocar algo es instantáneo.
 *
 *   transcribir → alinear → cortar → exportar
 *
 * Reanudar es lo normal: si el transcript ya está y sirve para ese audio, se usa.
 */

const transcribe = require('./transcribe');
const align = require('./align');
const cutplan = require('./cutplan');
const exporter = require('./export');
const workspace = require('./workspace');
const onset = require('./vendor/audio-onset');

const STAGES = ['transcribir', 'alinear', 'cortar', 'exportar'];

/**
 * @param {object} params
 *   root      raíz agregada (donde va "The Cutter")
 *   cls       clase del escaneo, ya medida
 *   viewMap   {PV: 0, R: 1}
 *   force     rehacer la transcripción aunque haya una guardada
 *   onStage   (stage, info) para el progreso
 *   signal    AbortSignal para cancelar
 */
async function processClass(params) {
    const { root, cls, onStage, signal } = params;
    const notify = (stage, info) => { if (onStage) onStage(stage, info || {}); };
    const warnings = [];

    if (!cls.sequenceName) {
        return { ok: false, error: 'La clase no tiene XML: no hay secuencia que generar.' };
    }

    // ── 1. Transcribir ──
    let transcript = null;
    if (cls.liveMixPath) {
        notify('transcribir', { percent: 0 });
        try {
            transcript = await transcribe.transcribeClass({
                root,
                sequenceName: cls.sequenceName,
                wavPath: cls.liveMixPath,
                fps: cls.fps || 30,
                force: params.force,
                signal,
                onProgress: percent => notify('transcribir', { percent })
            });
            notify('transcribir', { percent: 100, fromCache: transcript.fromCache });
        } catch (err) {
            if (err.code === 'cancelado') return { ok: false, cancelled: true };
            return { ok: false, error: err.message, code: err.code };
        }
    } else {
        warnings.push({
            code: 'sin_live_mix',
            message: 'Sin Live-Mix no se puede alinear: los marcadores quedan donde el CD los dejó.'
        });
    }

    // ── 2. Alinear ──
    notify('alinear', {});
    const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
    const wav = info ? { file: cls.liveMixPath, info } : null;

    const alignResult = align.alignClass({
        blocks: cls.blocks || [],
        words: transcript ? transcript.words : [],
        wav,
        classNumber: cls.classNumber,
        clapMarkerSec: cls.clapSec,
        durationSec: cls.durationSec,
        options: { fps: cls.fps || 30 }
    });
    workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'align'), alignResult);
    warnings.push(...alignResult.warnings);

    // ── 3. Plan de cortes ──
    notify('cortar', {});
    const plan = cutplan.buildCutplan({
        blocks: alignResult.blocks,
        videos: cls.videos,
        audios: cls.audios,
        durationSec: cls.durationSec,
        fps: cls.fps || 30,
        viewMap: params.viewMap
    });
    warnings.push(...plan.warnings);

    // ── 4. Exportar ──
    notify('exportar', {});
    let exported;
    try {
        exported = exporter.exportClass({ root, cls, alignResult, cutplan: plan });
    } catch (err) {
        return { ok: false, error: `No se pudo escribir el XML: ${err.message}` };
    }

    return {
        ok: true,
        sequenceName: cls.sequenceName,
        transcript: transcript
            ? { words: transcript.wordCount, language: transcript.language, fromCache: transcript.fromCache }
            : null,
        offset: alignResult.offset,
        stats: alignResult.stats,
        totals: plan.totals,
        exported,
        warnings
    };
}

/** Procesa varias clases, una detrás de otra (Whisper ya usa toda la máquina). */
async function processClasses(params) {
    const { classes = [], onClass, onStage, signal } = params;
    const results = [];
    for (let i = 0; i < classes.length; i++) {
        if (signal && signal.aborted) break;
        const cls = classes[i];
        if (onClass) onClass('empieza', { index: i, total: classes.length, cls });

        const result = await processClass({
            ...params,
            cls,
            // Quien escucha necesita saber de qué clase es cada etapa: procesar
            // trece seguidas con un progreso anónimo no dice nada.
            onStage: (stage, info) => {
                if (onStage) onStage(stage, { ...info, id: cls.id, index: i, total: classes.length });
            }
        });

        results.push({ id: cls.id, ...result });
        if (onClass) onClass('termina', { index: i, total: classes.length, cls, result });
    }
    return results;
}

module.exports = { processClass, processClasses, STAGES };
