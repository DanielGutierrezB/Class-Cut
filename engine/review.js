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
 *
 * Lo único que se calcula al servir es el reloj con el que el panel alumbra, que
 * no es el del transcript (ver `relojDeDtw`). Va acá y no en el Backup porque de
 * los tiempos del transcript viven los cortes: el karaoke se arregla sin tocar
 * nada de lo que decide dónde corta la clase.
 */

const workspace = require('./workspace');
const waveform = require('./waveform');
const exporter = require('./export');
const cutplanEngine = require('./cutplan');
const notas = require('./notas');
const silencios = require('./silencios');
const voz = require('./voz');
const retimeo = require('./retimeo');
const estadoClase = require('./estado-clase');

const CONTEXT_SEC = 12;

/**
 * Cuánto se le resta al instante del DTW para que caiga donde arranca el sonido.
 *
 * Que hay que restar algo, y de qué orden, lo dice el ataque que
 * `audio-onset.alignWords` midió en la onda: el DTW cae una mediana de 105 ms más
 * tarde en la clase 1 (303 tiradas) y de 120 ms en la clase 9.
 *
 * **Cuánto exactamente no se puede resolver más fino que "algo entre 120 y 140
 * ms", y conviene saberlo para no andar afinándolo.** Barrido ADENTRO de las
 * tiradas, que es donde el desfase se aplica, con dos varas que se quejan de lados
 * opuestos:
 *
 *   - Los tramos de sonido de +0,5 s donde no arranca ninguna palabra: 46 defectos
 *     de 1.042 con −0 ms, 49 con −120, 51 con −140 y ya 56 con −160. O sea que es
 *     plana hasta 140 —media décima de punto contra los 2,7 puntos que separan a
 *     las dos clases entre sí— y de 160 para arriba se cae.
 *   - Emparejando cada tramo de sonido con la palabra interior más cercana y
 *     mirando cuánto se separan: las que caen a menos de 100 ms del arranque del
 *     sonido son 46% con −80 ms, 54% con −100, 58% con −120, 60% con −140 y 60%
 *     con −160, y el error mediano se queda clavado en 80 ms para todo −120…−180.
 *     Esta se cae por abajo.
 *
 * Entre las dos, la banda que ninguna castiga es 120–140, y adentro de esa banda
 * no hay señal: los 4 puntos que se mueve la segunda vara son los mismos que se
 * mueve cambiando de qué reloj sale el emparejamiento. 140 queda.
 *
 * Y una trampa, para no volver a caer: emparejar el tramo con "la primera palabra
 * que arranca adentro" en vez de con la más cercana censura el resultado, porque
 * al restar más la palabra se va antes del tramo y la reemplaza la siguiente. Esa
 * versión contesta siempre "restá 80 ms más que el ancla que usaste" —con ancla en
 * 140 pide 240, con ancla en 60 pide 140— y eso es una respuesta sobre el ancla,
 * no sobre el audio.
 */
const DESFASE_DTW_SEC = 0.14;

/**
 * La resolución con la que el DTW dice las cosas, que es también lo mínimo que se
 * separan dos palabras seguidas.
 *
 * whisper.cpp devuelve el instante en centésimas de segundo, así que dos palabras
 * con el mismo número no son simultáneas: son dos que su grilla no pudo separar.
 * Y dejarlas empatadas no es neutral — `letra.palabraEn` alumbra la ÚLTIMA que
 * arrancó, así que de un empate la primera no se alumbra nunca, y una palabra que
 * no se alumbra nunca es texto que el editor no puede seguir. En la clase 1 son
 * 53 de 4.296. Separarlas por la resolución de la medida no invita nada: dice lo
 * que la medida dice, en orden.
 */
const RESOLUCION_DTW_SEC = 0.01;

function redondo(n) {
    return Math.round(n * 1000) / 1000;
}

/**
 * El reloj con el que el panel alumbra, armado sobre la alineación por DTW.
 *
 * **La regla: la onda manda donde hay silencio declarado, el DTW manda adentro de
 * las frases.** Los dos alineadores son buenos en lugares distintos y está
 * medido: donde `audio-onset.alignWords` engancha —el arranque de cada tirada,
 * que es donde hay silencio a un lado y puede medir un ataque limpio— el DTW
 * puro EMPEORA el borde, 60 ms de error contra los 20 ms de hoy. Adentro de la
 * tirada `alignWords` no mide nada (reparte proporcionalmente lo que el STT dijo)
 * y ahí el DTW parte el error al medio. Así que se injerta: la primera palabra de
 * cada tirada se queda con el arranque de la onda, las de adentro van por DTW.
 * Injertado, el borde empata exacto con lo de hoy y todo lo demás mejora.
 *
 * **Por qué no pasa por `retimeo`.** Correrlo encima de esto lleva esos mismos
 * bordes buenos de 20 a 213 ms, y el motivo no es un parámetro mal puesto:
 * `retimeo.esRota` pregunta "¿hay sonido en el mapa adentro de esta palabra?", y
 * sobre tiempos que ya salen del sonido un "no" dejó de significar "Whisper le
 * colgó un silencio" para significar "el micrófono no registró el habla". En la
 * clase 1 el mapa de voz arranca en 15,5 s mientras el director venía hablando
 * desde 8,5 s: son 6.976 palabras, el 15,5% del curso, que `retimeo` declararía
 * rotas y saldría a repartir sobre un sonido que no está donde se dijo. `retimeo`
 * queda igual y sigue siendo el camino de los transcripts sin DTW.
 *
 * **Lo que el injerto NO arregla, y hay que saberlo.** "La onda manda en la
 * primera palabra" vale mientras la onda haya medido algo. Cuando el que habla
 * está lejos del micrófono, `alignWords` no encuentra ningún ataque y le deja el
 * tiempo crudo de Whisper, que puede estar segundos antes: el injerto conserva
 * entonces un arranque que nadie midió. Se ve en el arranque de la clase 1, el
 * pasaje más difícil que hay: el director dice "Cuando estés listo, por favor,
 * dame el claqueta 1" desde 8,56 s (medido bajando el umbral de `voz.js` a un
 * cuarto, que es lo que hace falta para oírlo), el DTW pone esas palabras en
 * 8,62-10,80 —60 ms del arranque real— y el injerto le devuelve a "Cuando" el
 * 0,65 s de Whisper. La frase entra bien, la primera palabra queda clavada 8,5 s.
 *
 * Pasa en el 12,3% de las tiradas de la clase 1 (30 de 244, 256 s de panel quieto,
 * la peor de 28,3 s) y en el 8,0% de la clase 9, y son siempre las mismas palabras:
 * los cues del director dichos de lejos, "Ok.", "Sí,", "3,", "Listo.". En 25 de
 * esas 30 el DTW está a más de un segundo de distancia, o sea que tiene algo mejor
 * que decir. Sigue siendo mucho mejor que lo de antes —hoy la frase entera del
 * director se reparte sobre diez segundos— pero no está resuelto.
 *
 * **Las duraciones que salen de acá son ficticias.** El DTW da un instante por
 * palabra y nada más, así que el final de cada una es el arranque de la que
 * sigue: quedan pegadas, y una que tiene a la siguiente lejos "dura" segundos. Al
 * panel no le molesta porque `letra.palabraEn` alumbra la última palabra que
 * arrancó y no mira duraciones. Pero no se le puede dar de comer esto a nada que
 * las use de verdad: para eso están los `start`/`end` del transcript, que son los
 * que se midieron.
 *
 * @param {Array} palabras [{start, end, text, dtw?}] con los tiempos del Backup
 * @returns {{palabras: Array, stats: object}}
 */
function relojDeDtw(palabras) {
    const entrada = palabras || [];
    const salida = entrada.map(p => ({ ...p }));
    const stats = { tiradas: 0, injertadas: 0, sinDtw: 0, aplastadas: 0 };

    // Las tiradas son las de `retimeo`, con el mismo hueco, y eso no es
    // comodidad: son las MISMAS que arma `alignWords` con su `alignMinGapSec`.
    // Si se cortaran en otro lado, "conservar el arranque de la onda en la
    // primera palabra" conservaría el arranque de una palabra que la onda nunca
    // midió, que es justo lo que hace que el injerto funcione.
    for (const tirada of retimeo.tiradas(entrada, retimeo.HUECO_SEC)) {
        stats.tiradas++;
        const cierre = entrada[tirada[tirada.length - 1]].end;
        let previo = entrada[tirada[0]].start;

        for (let k = 0; k < tirada.length; k++) {
            const original = entrada[tirada[k]];
            let arranca = original.start;
            if (k > 0) {
                if (original.dtw == null) stats.sinDtw++;
                else { arranca = original.dtw - DESFASE_DTW_SEC; stats.injertadas++; }
            }
            // Nunca antes de la palabra anterior ni después del final de la
            // tirada. Son dos medidas distintas del mismo sonido y en el empalme
            // se cruzan; una palabra que arranca antes que la anterior el panel
            // no la alumbra nunca, porque busca la última que ya arrancó.
            const piso = k === 0 ? previo : previo + RESOLUCION_DTW_SEC;
            const acotado = Math.min(Math.max(arranca, piso), cierre);
            if (acotado !== arranca) stats.aplastadas++;
            salida[tirada[k]].start = redondo(acotado);
            previo = salida[tirada[k]].start;
        }

        for (let k = 0; k < tirada.length - 1; k++) {
            salida[tirada[k]].end = salida[tirada[k + 1]].start;
        }
        const ultima = salida[tirada[tirada.length - 1]];
        ultima.end = redondo(Math.max(cierre, ultima.start));
    }

    return { palabras: salida, stats };
}

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

    // Los tiempos con los que el panel alumbra no son los que Whisper guardó. El
    // transcript del Backup no se toca —de él viven los cortes, y rehacerlo
    // obligaría a reprocesar las trece clases—, así que el reloj se arma acá, al
    // servir.
    //
    // Hay dos caminos y el transcript decide cuál. Si trae la alineación por DTW
    // se usa esa, que es la buena. Si no, se corrige contra la onda con
    // `retimeo`, que es lo que hay en todos los Backup de hoy y sigue andando sin
    // pedirle al editor que vuelva a transcribir nada.
    //
    // La pregunta es por palabra y no por versión del transcript: un transcript
    // de la versión 5 hecho con un modelo sin grilla de DTW conocida tampoco lo
    // trae, y tiene que abrir por el mismo camino que uno de la 4.
    const palabras = transcript ? transcript.words || [] : [];
    const conDtw = palabras.some(p => p.dtw != null);
    // El mapa de voz cuesta 0,3 s la primera vez y lo único que lo usa es
    // `retimeo`: con DTW no hace falta ni pedirlo.
    const mapaDeVoz = conDtw
        ? null
        : voz.asegurar({ root, sequenceName, wavPath: cls.liveMixPath });
    const reloj = conDtw
        ? relojDeDtw(palabras)
        : (mapaDeVoz ? retimeo.retimear(palabras, mapaDeVoz) : null);

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
        // Y lo mismo dicho dos veces DENTRO de un bloque, que es otro detector y
        // otra cuenta: va aparte para que el guion pueda decir cuántos segundos
        // se fueron por ahí en vez de dejar el hueco sin explicación.
        retomas: align ? align.retomas || null : null,
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
        //
        // No van con los tiempos que guardó Whisper: esos tienen 3.735 palabras
        // del curso durando cero y tiradas enteras puestas encima de un silencio,
        // y con eso el karaoke no correlaciona con nada. Van con el reloj que se
        // armó arriba —DTW si el transcript lo trae, la onda si no—, y sin
        // ninguno de los dos —una clase sin Live-Mix y sin DTW— salen como
        // vinieron, que es peor pero es lo que hay.
        //
        // Ojo con las duraciones si alguna vez se leen desde acá: por el camino
        // del DTW son ficticias (ver `relojDeDtw`). El panel solo mira arranques.
        words: reloj ? reloj.palabras : palabras,
        // Con qué reloj se armaron y cuánto se movió. Se manda porque es lo que
        // explica una clase donde el panel sigue yendo por su lado: si acá dice
        // `whisper`, no se pudo leer ni el DTW ni el audio.
        reloj: reloj
            ? { como: conDtw ? 'dtw' : 'onda', ...reloj.stats }
            : { como: 'whisper' },
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

module.exports = { loadReview, saveReview, contextAround, relojDeDtw, CONTEXT_SEC, DESFASE_DTW_SEC };
