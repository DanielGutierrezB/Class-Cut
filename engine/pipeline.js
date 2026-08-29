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
const ia = require('./ia');
const tokens = require('./tokens');

const STAGES = ['reusar', 'transcribir', 'alinear', 'releer', 'afinar', 'despegar', 'revisar', 'repasar', 'cortar', 'exportar'];

/**
 * Cuánto tardó cada etapa, medido acá y no adivinado en la ventana.
 *
 * La ventana ya sabía qué etapa corre, pero no cuánto duró ninguna: como el
 * progreso llega por avisos sueltos, lo único que podía cronometrar era "desde
 * que me avisaron". Eso alcanza para una barra y no para decir cuánto falta,
 * que es lo que se pidió. Acá se mide donde está el trabajo.
 *
 * Suma por nombre en vez de apilar tramos: una etapa que avisa cien veces
 * (transcribir, con su porcentaje) tiene que ser UNA línea en el resumen, y si
 * alguna vez el orden dejara de ser estricto, el total seguiría siendo el real.
 */
function cronometro() {
    const inicio = Date.now();
    const acumulado = new Map();
    let actual = null;

    const cerrar = () => {
        if (!actual) return;
        acumulado.set(actual.etapa, (acumulado.get(actual.etapa) || 0) + (Date.now() - actual.desde));
        actual = null;
    };

    return {
        inicio,
        entrar(etapa) {
            if (actual && actual.etapa === etapa) return;
            cerrar();
            actual = { etapa, desde: Date.now() };
        },
        cerrar,
        /** Las etapas cerradas, en el orden canónico del pipeline. */
        etapas() {
            return STAGES.filter(e => acumulado.has(e)).map(e => ({ etapa: e, ms: acumulado.get(e) }));
        },
        /** Lo medido hasta ahora, para que viaje con cada aviso de progreso. */
        parcial() {
            return {
                msClase: Date.now() - inicio,
                msEtapa: actual ? Date.now() - actual.desde : 0,
                hechas: this.etapas()
            };
        }
    };
}

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
    const crono = cronometro();
    // Cuánto había gastado el modelo ANTES de esta clase. El cliente es uno
    // solo para toda la corrida —se arma en `processClasses`—, así que lo que
    // gastó esta clase es la resta y no el total, que crece con las trece.
    const usoAntes = tokens.instantanea(params.ai && params.ai.uso);
    const notify = (stage, info) => {
        crono.entrar(stage);
        if (onStage) onStage(stage, { ...(info || {}), ...crono.parcial() });
    };
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
        // El idioma lo resolvió la pasada larga sobre la clase entera. Hace falta
        // para releer un pedazo suelto: sobre seis segundos que dicen «3, 2, 1.»
        // la detección automática no tiene con qué decidir (`engine/rescate.js`).
        language: transcript ? transcript.language : null,
        ai: params.ai || null,
        onStage: notify
    });
    const alignResult = decided.alignResult;
    warnings.push(...decided.warnings);

    // Lo que se oyó releyendo los arranques sin texto entra al transcript
    // guardado, que es de donde lo leen el panel del visor, las mediciones y la
    // próxima corrida. Dejarlo solo en memoria arreglaría el corte y no el panel,
    // que es la mitad de lo que se vino a arreglar (`engine/rescate.js`).
    if (transcript && decided.rescate && decided.rescate.stats.agregadas) {
        transcript = {
            ...transcribe.reescribir({
                root,
                sequenceName: cls.sequenceName,
                wavPath: cls.liveMixPath,
                transcript,
                words: decided.crudas,
                rescate: { stats: decided.rescate.stats, hallazgos: decided.rescate.hallazgos }
            }),
            // Si esta clase se saltó Whisper lo dice la pasada larga, no la
            // relectura: de ese dato vive el estimado de la corrida, que separa
            // las clases reusadas (segundos) de las que se transcriben de cero
            // (una hora).
            fromCache: transcript.fromCache
        };
        workspace.appendLog(workspace.artifact(root, cls.sequenceName, 'log'),
            `rescate: ${decided.rescate.stats.agregadas} palabras en ` +
            `${decided.rescate.stats.releidos} arranques que el transcript no explicaba`);
    }

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
    // El cronómetro se para ANTES de guardar: lo que se persiste es lo que
    // tardó en cortar la clase, no lo que además tardó el disco en escribir el
    // recibo. Si se contara, el número dependería de si el curso está en un SSD
    // o en el disco de red del cliente, y dejaría de servir para estimar.
    crono.cerrar();
    const msProceso = Date.now() - crono.inicio;
    const gasto = tokens.totales(
        tokens.diferencia(usoAntes, tokens.instantanea(params.ai && params.ai.uso)));

    const guardado = estadoClase.guardar({
        root,
        cls,
        resumen: {
            app: params.appVersion || null,
            modelo: params.modelName || null,
            datos: {
                bloques: plan.totals ? plan.totals.kept : null,
                offsetSec: alignResult.offset ? alignResult.offset.appliedSec : null,
                // Cuánto tardó y qué costó. Va acá y no en el cutplan porque no
                // describe el corte: describe la corrida que lo produjo, y una
                // clase que se vuelve a exportar desde el visor mantiene su
                // corte pero no su tiempo de proceso. La duración final NO se
                // guarda: ya está en `trabajo.cutplan.totals.keepSec`, y
                // duplicarla es garantizar que algún día digan cosas distintas.
                msProceso,
                etapas: crono.etapas(),
                tokens: gasto.informa ? gasto : null,
                materialSec: cls.durationSec || null
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
        msProceso,
        etapas: crono.etapas(),
        tokens: gasto,
        materialSec: cls.durationSec || null,
        // Si esta clase pasó por Whisper o se saltó la transcripción. Separa las
        // dos poblaciones al estimar: una clase reusada tarda segundos y una
        // desde cero, una hora. Promediarlas juntas da un estimado que no vale
        // para ninguna de las dos.
        transcribio: Boolean(transcript && !transcript.fromCache),
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
    // avisos idénticos que tapaban los que sí eran distintos. Qué proveedor se
    // usa lo deciden los Ajustes; `ia.armar` es la única puerta.
    const modelo = params.useAi === false
        ? { cliente: null, reason: 'Criterio apagado a pedido.' }
        : await ia.armar({ signal, model: params.model });
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
                // Cada clase sabe por qué carpeta se entró a ella, y ahí va su
                // "The Cutter". Una corrida puede mezclar carpetas: con una raíz
                // sola para toda la tanda, los XML de la segunda terminaban en el
                // Backup de la primera.
                root: cls.root || params.root,
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
        ia.parar();
    }

    // El aviso del modelo va una sola vez, en la primera clase, para que quien
    // mire la lista lo vea sin que se repita trece veces.
    if (avisoDelModelo && results.length) results[0].warnings.unshift(avisoDelModelo);
    return results;
}

module.exports = { processClass, processClasses, STAGES };
