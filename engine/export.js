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

// Colores de marcador en la salida. El comentario del CD viaja intacto; el color
// es lo único que agregamos, y dice de un vistazo qué hay que mirar.
const VIEW_COLOR = { PV: 'blue', R: 'green', K: 'white' };
const CONFIDENCE_COLOR = { alta: 'green', media: 'yellow', baja: 'red' };

function videoSource(file) {
    return {
        path: file.path,
        name: file.name,
        durationSec: file.durationSec || 0,
        width: file.width,
        height: file.height,
        audioOnly: false
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
    const videoTracks = (cls.videos || []).map(video => ([{
        source: videoSource(video),
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

/** Los marcadores como los dejó el CD, leídos del XML original. */
function markersFromParsed(parsed) {
    const markers = [];
    const timebase = parsed.timebase || 30;

    if (parsed.clap) {
        markers.push({
            name: parsed.clap.name || 'K',
            comment: parsed.clap.comment || '',
            startSec: parsed.clap.seconds,
            color: 'white'
        });
    }
    for (const block of parsed.blocks) {
        markers.push({
            name: block.view,
            comment: block.inComment,
            startSec: block.startFrame / timebase,
            endSec: (block.startFrame / timebase) + 10,
            color: VIEW_COLOR[block.view] || 'blue'
        });
        if (block.complete) {
            markers.push({
                name: block.view,
                comment: block.outComment,
                startSec: block.endFrame / timebase,
                color: VIEW_COLOR[block.view] || 'blue'
            });
        }
    }
    return markers;
}

/** Los mismos marcadores, en el lugar que dijo el alineado. */
function markersFromAlign(alignResult, parsed) {
    const markers = [];
    const offset = alignResult.offset ? alignResult.offset.appliedSec || 0 : 0;

    if (parsed.clap) {
        markers.push({
            name: parsed.clap.name || 'K',
            comment: parsed.clap.comment || '',
            startSec: Math.max(0, parsed.clap.seconds + offset),
            color: 'white'
        });
    }
    for (const block of alignResult.blocks) {
        const color = block.confidence === 'alta'
            ? (VIEW_COLOR[block.view] || 'blue')
            : CONFIDENCE_COLOR[block.confidence];
        markers.push({
            name: block.view,
            comment: block.in.originalComment || blockComment(parsed, block, 'in'),
            startSec: block.startSec,
            endSec: block.startSec + 10,
            color
        });
        markers.push({
            name: block.view,
            comment: blockComment(parsed, block, 'out'),
            startSec: block.endSec,
            color
        });
    }
    return markers;
}

function blockComment(parsed, block, kind) {
    const original = parsed.blocks.find(b => b.index === block.index);
    if (!original) return '';
    return (kind === 'in' ? original.inComment : original.outComment) || '';
}

/** La clase ya cortada: cada bloque uno detrás de otro, con su vista. */
function cutTracks(cls, plan) {
    const kept = plan.segments.filter(segment => segment.keep);
    const videos = cls.videos || [];
    const audios = cls.audios || [];

    const videoTracks = videos.map((video, trackIndex) => kept.map(segment => ({
        source: videoSource(video),
        startSec: segment.timelineStartSec,
        endSec: segment.timelineEndSec,
        sourceInSec: segment.sourceStartSec,
        // La pista de abajo es la base y siempre se ve; las de arriba solo cuando
        // el bloque las eligió. Así el clip que no toca queda en la secuencia
        // —cambiar de plano es un clic— pero no tapa al bueno.
        enabled: trackIndex === 0 ? true : segment.cameraIndex === trackIndex
    })));

    const audioTracks = audios.map(audio => kept.map(segment => ({
        source: audioSource(audio),
        startSec: segment.timelineStartSec,
        endSec: segment.timelineEndSec,
        sourceInSec: segment.sourceStartSec,
        enabled: Boolean(audio.isLiveMix)
    })));

    const markers = kept.map(segment => ({
        name: segment.view,
        comment: segment.note || segment.cueIn || '',
        startSec: segment.timelineStartSec,
        color: segment.confidence === 'alta'
            ? (VIEW_COLOR[segment.view] || 'blue')
            : CONFIDENCE_COLOR[segment.confidence]
    }));

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
        markers: markersFromAlign(alignResult, parsed),
        durationSec: cls.durationSec || 0
    });

    const cut = cutTracks(cls, cutplan);
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

module.exports = { exportClass, fullTracks, cutTracks, markersFromParsed, markersFromAlign, VIEW_COLOR, CONFIDENCE_COLOR };
