'use strict';
/**
 * export.js — Escribe los XML de una clase en `<raíz>/The Cutter/`.
 *
 * Salen tres, y los tres se pueden importar:
 *
 *   Backup/<clase>/poblada.xml    el material en 00:00 con los marcadores del CD
 *                                 tal como vinieron. Sirve para ver si el problema
 *                                 estaba antes de que tocáramos nada.
 *   Backup/<clase>/alineada.xml   lo mismo, con los marcadores ya movidos a donde
 *                                 se dijo cada cosa. Acá se ve si el alineado
 *                                 acertó, sin cortar nada todavía.
 *   <clase>.xml                   la clase cortada, con la vista de cada bloque y
 *                                 solo el Live-Mix sonando.
 *
 * El XML del Rodecaster no se toca nunca: se lee y se deja donde está.
 */

const rodecaster = require('./rodecaster-xml');
const fcp = require('./fcp-xml');
const workspace = require('./workspace');
const notas = require('./notas');

// Los comentarios del editor no son marcas de corte: van con nombre y color
// propios para que se distingan de un vistazo de las que puso el CD, que llevan
// el color que él eligió.
const NOMBRE_DE_NOTA = 'Nota';

// Blanco, como entero ARGB de Premiere: 0xFFFFFFFF. Va el número y no el nombre
// `white` a propósito — solo los enteros escriben `pproColor`, que es lo único
// que evita que Premiere ajuste el color al más parecido de su paleta. Y este
// entero no es inventado: es exactamente el que el Rodecaster le pone a sus
// marcadores blancos (los de claqueta, 28 en el material del curso), así que se
// sabe que Premiere lo lee como blanco porque es Premiere quien lo escribió.
const COLOR_DE_NOTA = 0xFFFFFFFF;

/**
 * El color del marcador es el que eligió el director de contenido y viaja tal
 * cual: `pproColor` es el entero ARGB del XML original y `fcp-xml` lo convierte
 * sin interpretarlo. Recolorear por vista o por confianza convertía el XML en un
 * informe de la herramienta; lo que hay que revisar se dice en la interfaz, que
 * es donde se mira.
 */
function markerColor(source) {
    return source && source.color != null ? source.color : 'white';
}

function videoSource(file, index) {
    return {
        path: file.path,
        name: file.name,
        durationSec: file.durationSec || 0,
        width: file.width,
        height: file.height,
        audioOnly: false,
        // Cada cámara con su color, y el mismo en todas las clases: el orden del
        // archivo es estable porque el Rodecaster numera igual siempre.
        label: fcp.CLIP_LABELS[(index || 0) % fcp.CLIP_LABELS.length]
    };
}

function audioSource(file) {
    return {
        path: file.path,
        name: file.name,
        durationSec: file.durationSec || 0,
        channels: file.channels || 2,
        sampleRate: file.sampleRate || 48000,
        bits: file.bits || 16,
        audioOnly: true
    };
}

/** Pistas con el material entero desde 00:00, que es como se grabó. */
function fullTracks(cls) {
    const durationSec = cls.durationSec || 0;
    const videoTracks = (cls.videos || []).map((video, index) => ([{
        source: videoSource(video, index),
        startSec: 0,
        endSec: video.durationSec || durationSec,
        sourceInSec: 0,
        enabled: true
    }]));
    const audioTracks = (cls.audios || []).map(audio => ([{
        source: audioSource(audio),
        startSec: 0,
        endSec: audio.durationSec || durationSec,
        sourceInSec: 0,
        // Solo suena el Live-Mix: los otros nueve canales entran para tenerlos a
        // mano, no para escucharlos todos a la vez.
        enabled: Boolean(audio.isLiveMix)
    }]));
    return { videoTracks, audioTracks };
}

/**
 * Cuánto dura el marcador de entrada de un bloque en los dos XML espejo.
 *
 * El del CD trae su propia duración —en este curso, 300 frames: diez segundos— y
 * se devuelve tal cual, porque `poblada.xml` y `alineada.xml` son eso: los
 * marcadores del CD como los dejó, en su sitio y movidos. Un marcador de un
 * frame es una raya invisible en la línea de tiempo de Premiere.
 *
 * En el XML del corte no se usa: allá el marcador de una nota dura el bloque
 * entero (ver `cutTracks`). El respaldo es para los XML viejos que no traigan
 * span.
 */
function duracionDelIn(block) {
    const suyo = block && block.inSpanSec;
    return suyo && suyo > 0 ? suyo : DURACION_DE_IN_SEC;
}

/** Lo que se usa cuando el XML de origen no dice cuánto duraba el marcador. */
const DURACION_DE_IN_SEC = 10;

/** Los marcadores como los dejó el CD, leídos del XML original. */
function markersFromParsed(parsed) {
    const markers = [];
    const timebase = parsed.timebase || 30;

    if (parsed.clap) {
        markers.push({
            name: parsed.clap.name || 'K',
            comment: parsed.clap.comment || '',
            startSec: parsed.clap.seconds,
            color: markerColor(parsed.clap)
        });
    }
    for (const block of parsed.blocks) {
        markers.push({
            name: block.view,
            comment: block.inComment,
            startSec: block.startFrame / timebase,
            endSec: (block.startFrame / timebase) + duracionDelIn(block),
            color: markerColor(block)
        });
        if (block.complete) {
            markers.push({
                name: block.view,
                comment: block.outComment,
                startSec: block.endFrame / timebase,
                color: markerColor(block)
            });
        }
    }
    return markers;
}

/** Los mismos marcadores, en el lugar que dijo el alineado. */
function markersFromAlign(alignResult, parsed, guardadas) {
    const markers = [];
    const offset = alignResult.offset ? alignResult.offset.appliedSec || 0 : 0;

    if (parsed.clap) {
        markers.push({
            name: parsed.clap.name || 'K',
            comment: parsed.clap.comment || '',
            startSec: Math.max(0, parsed.clap.seconds + offset),
            color: markerColor(parsed.clap)
        });
    }
    for (const block of alignResult.blocks) {
        const original = parsed.blocks.find(b => b.index === block.index);
        markers.push({
            name: block.view,
            comment: notas.notaDeBloque(guardadas, block.index, original ? original.inComment : ''),
            startSec: block.startSec,
            endSec: block.startSec + duracionDelIn(original),
            color: markerColor(original)
        });
        markers.push({
            name: block.view,
            comment: original ? original.outComment || '' : '',
            startSec: block.endSec,
            color: markerColor(original)
        });
    }

    // Acá los clips son el material entero, así que el tiempo de la grabación y
    // el de la secuencia son el mismo: los comentarios van donde fueron escritos.
    for (const comentario of (guardadas && guardadas.comentarios) || []) {
        markers.push({
            name: NOMBRE_DE_NOTA,
            comment: comentario.comentario,
            startSec: comentario.sourceStartSec,
            color: COLOR_DE_NOTA
        });
    }
    markers.sort((a, b) => a.startSec - b.startSec);

    return markers;
}

/** La vista del profesor de frente: la que va en el recuadro. */
const VISTA_DEL_PROFESOR = 'PV';

/**
 * Dónde va el recuadro del profesor sobre el grabador de pantalla.
 *
 * Los números no están calculados: **están copiados del Premiere del editor**. Él
 * armó el recuadro como lo quiere, exportó esa secuencia a FCP7 XML y de ahí
 * salieron la escala, el centro y el anclaje, tal cual. Calcularlos habría sido
 * adivinar dos veces —la geometría que le gusta y las unidades del formato— y no
 * hay por qué: el archivo que Premiere escribe es el archivo que Premiere lee.
 *
 * El recorte es el único que no vino de ahí, y tiene su motivo. En su secuencia
 * la forma casi cuadrada la hacía el efecto Recorte redondeado, que **el
 * exportador de Premiere descarta**: en el XML los cuatro recortes de Basic
 * Motion quedaron en cero y el recuadro habría llegado 16:9, mucho más ancho de
 * lo que él ve. Basic Motion trae los suyos y esos sí viajan, así que se
 * reproduce ahí: 18 % por lado deja 1229 × 1080, la misma proporción 1,14 que se
 * mide en su monitor. Simétrico a propósito, para que el centro no se mueva.
 *
 * Lo que no llega de ninguna manera son las esquinas redondeadas y la sombra: no
 * existen como parámetro en el formato. Se aplican a mano en un bloque y se pegan
 * atributos en el resto.
 */
const ENCUADRE_DEL_RECUADRO = {
    escala: 26,
    centro: { horiz: 0.0986844, vert: -0.0818712 },
    anclaje: { horiz: 0.299342, vert: 0.48538 },
    recorte: { izq: 18, der: 18, arriba: 0, abajo: 0 }
};

/**
 * La clase ya cortada: cada bloque uno detrás de otro, con su vista.
 *
 * Las pistas quedan por papel y no por casualidad del orden del material:
 *
 *   V1  la cámara del profesor
 *   V2  el grabador de pantalla
 *   V3  la cámara del profesor OTRA VEZ, solo en los bloques que van con la
 *       pantalla: es el recuadro (y ahí V1 queda puesta pero apagada, para que
 *       el bloque tenga una sola imagen a pantalla completa).
 *
 * En V1 y V2 se enciende la que el bloque eligió y la otra queda apagada en su
 * sitio: cambiar de plano sigue siendo un clic, pero ninguna tapa a la buena.
 */
function cutTracks(cls, plan, guardadas) {
    const kept = plan.segments.filter(segment => segment.keep);
    const videos = cls.videos || [];
    const audios = cls.audios || [];

    const videoTracks = videos.map((video, trackIndex) => kept.map(segment => ({
        source: videoSource(video, trackIndex),
        startSec: segment.timelineStartSec,
        endSec: segment.timelineEndSec,
        sourceInSec: segment.sourceStartSec,
        enabled: segment.cameraIndex === trackIndex
    })));

    // La pista del recuadro. Solo lleva clips en los bloques donde la imagen
    // principal NO es el profesor: en los demás no hay nada que meter en la
    // esquina, y una pista con clips apagados de punta a punta es ruido.
    const delProfesor = (plan.viewMap && plan.viewMap[VISTA_DEL_PROFESOR]) || 0;
    const conRecuadro = kept.filter(segment => segment.cameraIndex !== delProfesor);
    if (videos[delProfesor] && conRecuadro.length) {
        videoTracks.push(conRecuadro.map(segment => ({
            source: videoSource(videos[delProfesor], delProfesor),
            startSec: segment.timelineStartSec,
            endSec: segment.timelineEndSec,
            sourceInSec: segment.sourceStartSec,
            enabled: true,
            encuadre: ENCUADRE_DEL_RECUADRO
        })));
    }

    const audioTracks = audios.map(audio => kept.map(segment => ({
        source: audioSource(audio),
        startSec: segment.timelineStartSec,
        endSec: segment.timelineEndSec,
        sourceInSec: segment.sourceStartSec,
        enabled: Boolean(audio.isLiveMix)
    })));

    // Solo los bloques que tienen algo escrito llevan marcador, y abarcan el
    // bloque de borde a borde: así se lee de un vistazo a qué tramo se refiere
    // la nota sin buscarla con zoom.
    //
    // Antes iban TODOS, porque en Premiere el marcador no es solo para leer sino
    // cómo se recorre la secuencia, y los que no tenían nota que decir iban de un
    // frame con el nombre de la vista. Eso dejó de tener sentido cuando el corte
    // empezó a llegar con la vista ya elegida y encendida en su pista: la raya de
    // un frame no aportaba nada que el clip no dijera, y llenaba la regla de
    // marcas por las que nadie iba a pasar. Los límites de cada bloque los siguen
    // diciendo los cortes entre clips.
    //
    // Y el cue NO cuenta como texto: es el arranque del transcript, no algo que
    // alguien haya escrito. Un bloque sin nota no lleva marcador aunque tenga cue.
    //
    // El color es el que eligió el CD y viaja tal cual.
    const markers = [];
    for (const segment of kept) {
        const texto = notas.notaDeBloque(guardadas, segment.blockIndex, segment.note || '');
        if (!texto) continue;
        markers.push({
            name: segment.view,
            comment: texto,
            startSec: segment.timelineStartSec,
            endSec: segment.timelineEndSec,
            color: markerColor(segment)
        });
    }

    // Los comentarios que dejó el editor sobre el transcript. Estos son otro
    // objeto: no son de un bloque sino de un pedazo de letra, así que van blancos
    // —para no confundirlos con los del CD— y duran lo que duraba la selección.
    //
    // Van anclados al tiempo de la grabación, así que hay que traerlos a la línea
    // de tiempo del corte; los que caen en material que quedó afuera no tienen
    // dónde ir.
    for (const comentario of (guardadas && guardadas.comentarios) || []) {
        const tramo = notas.tramoEnLaLineaDeTiempo(
            comentario.sourceStartSec, comentario.sourceEndSec, kept);
        if (!tramo) continue;
        markers.push({
            name: NOMBRE_DE_NOTA,
            comment: comentario.comentario,
            startSec: tramo.startSec,
            endSec: tramo.endSec,
            color: COLOR_DE_NOTA
        });
    }
    markers.sort((a, b) => a.startSec - b.startSec);

    return { videoTracks, audioTracks, markers, durationSec: plan.totals.keepSec };
}

/**
 * Escribe los tres XML de una clase.
 *
 * @param {object} params { root, cls, alignResult, cutplan }
 * @returns {{finalXml, populatedXml, alignedXml, sequenceName}}
 */
function exportClass(params) {
    const { root, cls, alignResult, cutplan } = params;
    const sequenceName = cls.sequenceName;
    if (!sequenceName) throw new Error('La clase no tiene nombre de secuencia.');

    const parsed = rodecaster.parseFile(cls.xmlPath);
    if (!parsed.ok) throw new Error(`No se pudo releer el XML de origen: ${parsed.error}`);

    // El frame rate sale del material medido, nunca del XML de origen: el del
    // Rodecaster declara 29.97 y las cámaras graban a 30 exactos.
    const fps = cls.fps || 30;
    const width = cls.width || parsed.width || 1920;
    const height = cls.height || parsed.height || 1080;
    const base = { fps, width, height };

    // Lo que el editor escribió revisando. Se lee acá y no se recibe por
    // parámetro para que exportar desde el pipeline y desde el visor lleven
    // siempre lo mismo: las notas no se pierden por el camino que se use.
    const guardadas = notas.leer(root, sequenceName);

    const full = fullTracks(cls);

    const populated = fcp.sequenceXml({
        ...base,
        name: sequenceName,
        videoTracks: full.videoTracks,
        audioTracks: full.audioTracks,
        markers: markersFromParsed(parsed),
        durationSec: cls.durationSec || 0
    });

    const aligned = fcp.sequenceXml({
        ...base,
        name: sequenceName,
        videoTracks: full.videoTracks,
        audioTracks: full.audioTracks,
        markers: markersFromAlign(alignResult, parsed, guardadas),
        durationSec: cls.durationSec || 0
    });

    const cut = cutTracks(cls, cutplan, guardadas);
    const final = fcp.sequenceXml({
        ...base,
        name: sequenceName,
        videoTracks: cut.videoTracks,
        audioTracks: cut.audioTracks,
        markers: cut.markers,
        durationSec: cut.durationSec
    });

    const populatedPath = workspace.artifact(root, sequenceName, 'populatedXml');
    const alignedPath = workspace.artifact(root, sequenceName, 'alignedXml');
    const finalPath = workspace.finalXml(root, sequenceName);

    workspace.writeAtomic(populatedPath, populated);
    workspace.writeAtomic(alignedPath, aligned);
    workspace.writeJson(workspace.artifact(root, sequenceName, 'cutplan'), cutplan);
    workspace.writeAtomic(finalPath, final);

    workspace.appendLog(workspace.artifact(root, sequenceName, 'log'),
        `export: ${cutplan.totals.kept} bloques · ${fmt(cutplan.totals.keepSec)} de ${fmt(cls.durationSec)} ` +
        `· ${fps} fps · ${cutplan.totals.needsReview} para revisar`);

    return {
        sequenceName,
        finalXml: finalPath,
        populatedXml: populatedPath,
        alignedXml: alignedPath,
        keepSec: cutplan.totals.keepSec,
        segments: cutplan.totals.kept
    };
}

function fmt(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

module.exports = {
    exportClass, fullTracks, cutTracks,
    markersFromParsed, markersFromAlign, markerColor, videoSource,
    ENCUADRE_DEL_RECUADRO
};
