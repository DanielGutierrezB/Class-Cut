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
const decidir = require('./decidir');
const cutplan = require('./cutplan');
const exporter = require('./export');
const workspace = require('./workspace');
const estadoClase = require('./estado-clase');
const onset = require('./vendor/audio-onset');
const ollamaServer = require('./ollama-server');

const STAGES = ['reusar', 'transcribir', 'alinear', 'afinar', 'despegar', 'revisar', 'repasar', 'cortar', 'exportar'];

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

    // Los Backup viejos tenían una carpeta por clase. Se pasan al formato plano
    // antes de buscar nada, para no dar por perdido un transcript que está.
    workspace.migrateBackup(root);

    // Y si la clase trae trabajo guardado de otra vez —procesada desde la
    // carpeta del día y ahora entrando por la del curso—, se devuelve al Backup
    // de esta raíz antes de mirar nada. Reprocesar a pedido no lo mira: ahí lo
    // que se quiere es justamente volver a empezar.
    let reusado = { restaurados: [], desde: null };
    if (!params.force) {
        reusado = estadoClase.hidratar({ root, cls });
        if (reusado.restaurados.length) {
            notify('reusar', { restaurados: reusado.restaurados, desde: reusado.desde });
        }
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

    // ── 2. Decidir los cortes ──
    const info = cls.liveMixPath ? onset.wavInfo(cls.liveMixPath) : null;
    const wav = info ? { file: cls.liveMixPath, info } : null;
    const words = transcript ? transcript.words : [];

    const decided = await decidir.decidirCortes({
        cls, words, wav, signal,
        ai: params.ai || null,
        onStage: notify
    });
    const alignResult = decided.alignResult;
    warnings.push(...decided.warnings);

    workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'align'), alignResult);
    if (decided.review) {
        workspace.writeJson(workspace.artifact(root, cls.sequenceName, 'coherence'), decided.review);
    }

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

    // ── 5. Dejar el trabajo junto al material ──
    //
    // Al final y no antes: lo que se guarda es lo que quedó en disco, ya
    // exportado. Si falla, la corrida sigue siendo buena —el XML está— y lo
    // único que se pierde es poder saltarse esto la próxima vez.
    const guardado = estadoClase.guardar({
        root,
        cls,
        resumen: {
            app: params.appVersion || null,
            modelo: params.modelName || null,
            datos: {
                bloques: plan.totals ? plan.totals.kept : null,
                offsetSec: alignResult.offset ? alignResult.offset.appliedSec : null
            }
        }
    });
    if (!guardado.ok) {
        warnings.push({
            code: 'estado_no_guardado',
            message: `El XML quedó bien, pero no se pudo guardar el trabajo en la carpeta de la clase: ${guardado.error}. ` +
                'Si movés la carpeta, habrá que procesarla de nuevo.'
        });
    }

    const review = decided.review;
    return {
        ok: true,
        sequenceName: cls.sequenceName,
        // Qué se saltó por estar ya hecho, para poder decirlo en la corrida.
        reusado: reusado.restaurados.length ? reusado : null,
        estadoGuardado: guardado.ok,
        transcript: transcript
            ? { words: transcript.wordCount, language: transcript.language, fromCache: transcript.fromCache }
            : null,
        offset: alignResult.offset,
        stats: alignResult.stats,
        refine: alignResult.refine || null,
        coherence: review
            ? { findings: review.findings.length, stats: review.stats, wordCount: review.wordCount }
            : null,
        totals: plan.totals,
        exported,
        warnings
    };
}

/** Procesa varias clases, una detrás de otra (Whisper ya usa toda la máquina). */
async function processClasses(params) {
    const { classes = [], onClass, onStage, signal } = params;
    const results = [];

    // Si el modelo está disponible es una propiedad de la corrida, no de cada
    // clase: se levanta una vez para las trece. Preguntarlo por clase daba trece
    // avisos idénticos que tapaban los que sí eran distintos.
    const modelo = params.useAi === false
        ? { cliente: null, reason: 'Criterio apagado a pedido.' }
        : await ollamaServer.ensure({ signal, model: params.model });
    const avisoDelModelo = modelo.cliente ? null : {
        code: 'sin_modelo',
        message: `${modelo.reason} Los cortes salen con las reglas, sin criterio en los casos dudosos.`
    };
    if (onClass) onClass('modelo', { modelo, aviso: avisoDelModelo });

    try {
        for (let i = 0; i < classes.length; i++) {
            if (signal && signal.aborted) break;
            const cls = classes[i];
            if (onClass) onClass('empieza', { index: i, total: classes.length, cls });

            const result = await processClass({
                ...params,
                cls,
                ai: modelo.cliente,
                modelName: modelo.model || null,
                // Quien escucha necesita saber de qué clase es cada etapa:
                // procesar trece seguidas con un progreso anónimo no dice nada.
                onStage: (stage, info) => {
                    if (onStage) onStage(stage, { ...info, id: cls.id, index: i, total: classes.length });
                }
            });

            results.push({ id: cls.id, ...result });
            if (onClass) onClass('termina', { index: i, total: classes.length, cls, result });
        }
    } finally {
        // Lo que se levanta acá se baja acá. Dejarlo vivo entre corridas ahorra
        // diez segundos de arranque y a cambio deja varios GB de modelo en
        // memoria y un proceso hijo que no deja salir a quien nos llame desde la
        // terminal. La app tiene además su propio apagado por si se la cierra en
        // medio de una corrida.
        ollamaServer.stop();
    }

    // El aviso del modelo va una sola vez, en la primera clase, para que quien
    // mire la lista lo vea sin que se repita trece veces.
    if (avisoDelModelo && results.length) results[0].warnings.unshift(avisoDelModelo);
    return results;
}

module.exports = { processClass, processClasses, STAGES };
