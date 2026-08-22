'use strict';
/**
 * decidir.js — De palabras a bloques decididos.
 *
 * Es el tramo que va entre tener el transcript y tener los cortes: alinear los
 * marcadores con lo que de verdad se dijo, afinar los bordes dudosos y leer la
 * clase entera a ver si cierra.
 *
 * Vive aparte del pipeline por una razón concreta: es exactamente la parte cuyo
 * resultado cambia si cambia el modelo, y `tools/bench-models.js` la corre una
 * vez por modelo para decidir cuál se empaqueta. Cuando el banco tenía su propia
 * copia de estos tres pasos, medía una versión del producto que ya no era la que
 * se distribuía —y esa medición es la que justifica el tamaño del instalador—.
 * Con un solo camino, el banco no puede medir algo que la app no haga.
 *
 * Nada de acá escribe archivos ni sabe de carpetas: entra material medido, sale
 * el resultado y la lista de lo que hay que avisar.
 */

const align = require('./align');
const cutRefine = require('./cut-refine');
const coherence = require('./coherence');

/**
 * @param {object} params
 *   cls      clase del escaneo, ya medida
 *   words    palabras del transcript, con tiempos
 *   wav      {file, info} del Live-Mix, o null si no hay
 *   ai       cliente del modelo local, o null para cortar solo con reglas
 *   signal   AbortSignal
 *   onStage  (etapa, {percent}) para el progreso
 * @returns {Promise<{alignResult:object, review:object|null, warnings:object[]}>}
 */
async function decidirCortes(params) {
    const { cls, words, wav, ai, signal } = params;
    const notify = (stage, info) => { if (params.onStage) params.onStage(stage, info || {}); };
    const options = { fps: cls.fps || 30 };
    const warnings = [];

    notify('alinear', {});
    const alignResult = align.alignClass({
        blocks: cls.blocks || [],
        words,
        wav,
        classNumber: cls.classNumber,
        clapMarkerSec: cls.clapSec,
        durationSec: cls.durationSec,
        options
    });
    warnings.push(...alignResult.warnings);

    // Sin transcript no hay nada que afinar ni que leer: los marcadores se quedan
    // donde el CD los dejó, que ya se avisó al alinear.
    if (!words.length) return { alignResult, review: null, warnings };

    // Las reglas ya dejaron cada borde en un sitio defendible; acá se miran solo
    // los que tienen más de una opción razonable, que es donde el criterio cambia
    // el resultado.
    notify('afinar', {});
    try {
        await cutRefine.refineClass({
            alignResult, words, wav, options, ai, signal,
            onProgress: info => notify('afinar', {
                percent: Math.round((info.index / Math.max(1, info.total)) * 100)
            })
        });
    } catch (err) {
        warnings.push({ code: 'afinado_fallo', message: `No se pudieron afinar los bordes: ${err.message}` });
    }

    // Un bloque puede estar perfecto y la clase entera no cerrar, así que esto se
    // hace sobre el resultado y no sobre cada bloque por separado.
    notify('revisar', {});
    let review = null;
    try {
        review = await coherence.reviewClass({
            alignResult, words, ai, signal,
            onProgress: info => notify('revisar', {
                percent: Math.round((info.chunk / Math.max(1, info.total)) * 100)
            })
        });
        for (const finding of review.findings.filter(f => f.gravedad === 'alta')) {
            warnings.push({ code: 'coherencia', message: `Bloque ${finding.bloque}: ${finding.detalle}` });
        }
    } catch (err) {
        warnings.push({ code: 'revision_fallo', message: `No se pudo revisar el guion: ${err.message}` });
    }

    return { alignResult, review, warnings };
}

module.exports = { decidirCortes };
