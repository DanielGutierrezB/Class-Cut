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
const relojes = require('./reloj');
const speech = require('./speech-edges');
const cutRefine = require('./cut-refine');
const repeticiones = require('./repeticiones');
const retoma = require('./retoma');
const coherence = require('./coherence');
const repasar = require('./repasar');

/**
 * **Con qué reloj se decide.** Las palabras entran como las guardó el transcript y
 * acá se pasan al reloj bueno (`reloj.paraDecidir`), que es el del DTW cuando el
 * transcript lo trae. Va acá y no en cada caller a propósito: el pipeline, el lote
 * y el banco de modelos tienen que decidir con el mismo reloj, porque un banco que
 * mide con otro reloj mide un producto que no se distribuye. Los tiempos que se
 * usaron salen en `palabras`, para que quien mida el resultado lo mida con lo mismo
 * con lo que se decidió.
 *
 * @param {object} params
 *   cls      clase del escaneo, ya medida
 *   words    palabras del transcript, con tiempos
 *   reloj    `auto` (por defecto) | `crudo`, para el A/B de `tools/medir-repaso.js`
 *   wav      {file, info} del Live-Mix, o null si no hay
 *   ai       cliente del modelo local, o null para cortar solo con reglas
 *   signal   AbortSignal
 *   onStage  (etapa, {percent}) para el progreso
 * @returns {Promise<{alignResult, review, warnings, palabras, reloj}>}
 */
async function decidirCortes(params) {
    const { cls, wav, ai, signal } = params;
    const puesto = relojes.paraDecidir(params.words, params.reloj || 'auto');
    const words = puesto.palabras;
    const notify = (stage, info) => { if (params.onStage) params.onStage(stage, info || {}); };
    const options = { fps: cls.fps || 30, ...(params.options || {}) };
    const warnings = [];

    // Antes de cortar nada: ¿este transcript sirve para decidir dónde? Todo lo
    // que sigue —afinar, despegar, leer— supone que se sabe dónde termina cada
    // frase. Cuando no se sabe, nada de eso falla: sale una clase con los
    // bloques cortados donde cayó, y el editor lo descubre al mirar el
    // resultado. Esto lo dice acá, que es donde todavía se puede volver a
    // transcribir sin haber gastado el criterio del modelo en una clase perdida.
    const puntuacion = speech.densidadDeCierres(words);
    if (!puntuacion.sirve) {
        warnings.push({
            code: 'transcript_sin_puntuacion',
            message: `Solo el ${(puntuacion.ratio * 100).toFixed(1)}% de las palabras cierran frase ` +
                `(lo normal es 9-15%), con un tramo de ${Math.round(puntuacion.pozoSec)}s sin un punto. ` +
                'Los bordes de bloque se van a decidir casi a ciegas: conviene volver a transcribir esta clase.'
        });
    }

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
    // Con qué reloj se decidió queda escrito en el plan, y no es un dato de
    // curiosidad: `tools/medir-cortes.js` cuenta los defectos mirando qué palabras
    // caen dentro de cada bloque, así que leer un plan del DTW con los tiempos
    // crudos del transcript inventa defectos que no existen — 26 bloques
    // "terminando en habla del director" contra los 0 que tenía. Un plan sin este
    // campo es de antes y se lee con el reloj crudo, que es con el que se hizo.
    alignResult.reloj = puesto.como;
    warnings.push(...alignResult.warnings);

    // Sin transcript no hay nada que afinar ni que leer: los marcadores se quedan
    // donde el CD los dejó, que ya se avisó al alinear.
    if (!words.length) return { alignResult, review: null, warnings, palabras: words, reloj: puesto.como };

    // El suelo de la claqueta lo descubre el alineado (es quien la busca en el
    // audio) y de acá en adelante lo respeta todo el mundo: ningún IN puede
    // abrirse antes, ni por regla, ni por modelo, ni por repaso.
    if (alignResult.pisoSec != null) options.pisoSec = alignResult.pisoSec;

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

    // Va después de afinar y antes de leer, y las dos cosas importan. Después,
    // porque afinar ya movió los bordes con las órdenes del CD y muchas
    // repeticiones desaparecen ahí solas; buscarlas antes sería arreglar lo que
    // ya se iba a arreglar. Y antes de leer, porque si no la lectura reporta como
    // problema pendiente algo que se puede quitar sin preguntarle a nadie.
    notify('despegar', {});

    // Las retomas internas van PRIMERO, antes de las que cruzan el borde entre
    // dos bloques. El detector de repeticiones compara la cola de un bloque
    // contra la CABEZA del siguiente, y cuando ese siguiente arranca con una
    // toma que el profesor rehizo, esa cabeza es material que no va a existir:
    // se estaría midiendo el empalme contra la versión mala. Abriendo primero el
    // bloque en su toma buena, lo que compara después es lo que de verdad va a
    // sonar.
    try {
        const retomas = retoma.quitarRetomas({ alignResult, words, wav, options });
        for (const h of retomas.hallazgos.filter(x => x.accion === 'no se pudo')) {
            warnings.push({
                code: 'retoma',
                message: `Bloque ${h.bloque + 1}: la explicación está dos veces adentro ` +
                    `(el profesor la rehace en ${h.tomaSec}s) y no se pudo arreglar solo.`
            });
        }
    } catch (err) {
        warnings.push({ code: 'retoma_fallo', message: `No se pudieron quitar las retomas: ${err.message}` });
    }

    try {
        const quitadas = repeticiones.quitarRepeticiones({ alignResult, words, wav, options });
        for (const h of quitadas.hallazgos.filter(x => x.accion === 'no se pudo')) {
            warnings.push({
                code: 'repetido',
                message: `Bloque ${h.bloque + 1}: dice lo mismo que el ${h.contra + 1} y no se pudo recortar solo.`
            });
        }
    } catch (err) {
        warnings.push({ code: 'repetido_fallo', message: `No se pudieron quitar las repeticiones: ${err.message}` });
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
    } catch (err) {
        warnings.push({ code: 'revision_fallo', message: `No se pudo revisar el guion: ${err.message}` });
    }

    // Antes de avisar, intentar. Un hallazgo que la máquina puede arreglar sola
    // no es un hallazgo, es una tarea que no se hizo: se arregla lo que el
    // transcript permite y se vuelve a leer la clase que quedó, para que lo que
    // llegue al editor sea lo que de verdad sigue sin cerrar.
    if (review && options.repaso !== 'no') {
        notify('repasar', {});
        try {
            const repaso = await repasar.repasar({
                alignResult, review, words, wav, options, ai, signal,
                onProgress: () => notify('repasar', { fase: 'releer' })
            });
            review = repaso.review;
            alignResult.repaso = repaso.stats;
        } catch (err) {
            warnings.push({ code: 'repaso_fallo', message: `No se pudo repasar el guion: ${err.message}` });
        }
    }

    if (review) {
        for (const finding of review.findings.filter(f => f.gravedad === 'alta' && !f.corregido)) {
            warnings.push({ code: 'coherencia', message: `Bloque ${finding.bloque}: ${finding.detalle}` });
        }
    }

    return { alignResult, review, warnings, palabras: words, reloj: puesto.como };
}

module.exports = { decidirCortes };
