'use strict';
/**
 * cutplan.js — Qué se queda, qué se va y con qué cámara se ve cada bloque.
 *
 * Los bloques ya alineados son lo que se mantiene; todo lo de en medio —tomas
 * falsas, indicaciones al editor, silencios— se va. La claqueta nunca es bloque,
 * así que no hace falta pedir que se ignore el primer marcador.
 *
 * La vista no hay que adivinarla: el CD ya la eligió en vivo y quedó en el nombre
 * del marcador. En el curso completo solo existen `PV` (212 bloques) y `R` (136),
 * así que `PV` es la cámara del presentador y `R` la de la pantalla. La cámara que
 * no toca no se borra: entra deshabilitada, y cambiar de plano después es un clic.
 */

const CUTPLAN_VERSION = 1;

// La convención del curso. Es un default, no una ley: la tabla se arma con los
// nombres que traiga el XML y un nombre desconocido cae en la primera cámara.
const DEFAULT_VIEW_MAP = { PV: 0, R: 1 };

function round(n) {
    return Math.round(n * 1000) / 1000;
}

/**
 * @param {object} params
 *   blocks      bloques alineados (align.js)
 *   videos      capturas de la clase, en orden
 *   viewMap     {PV: 0, R: 1} — nombre de marcador → índice de cámara
 *   durationSec duración real del material
 */
function buildCutplan(params) {
    const {
        blocks = [], videos = [], audios = [],
        durationSec = null, fps = 30
    } = params || {};
    const viewMap = { ...DEFAULT_VIEW_MAP, ...(params && params.viewMap) };
    const warnings = [];

    if (!videos.length) {
        warnings.push({ code: 'sin_camaras', message: 'La clase no tiene cámaras: no hay nada que cortar.' });
    }

    const unknownViews = new Set();
    const segments = [];
    let timelineSec = 0;

    for (const block of blocks) {
        const keep = block.enabled !== false;
        const view = block.view || '';
        let cameraIndex = viewMap[view];

        if (cameraIndex == null) {
            cameraIndex = 0;
            if (view) unknownViews.add(view);
        }
        if (cameraIndex >= videos.length) {
            // Una vista que apunta a una cámara que esta clase no tiene: se usa la
            // primera y se avisa, en vez de dejar el bloque sin imagen.
            warnings.push({
                code: 'vista_sin_camara',
                message: `El bloque ${block.index + 1} pide la cámara ${cameraIndex + 1} y esta clase tiene ${videos.length}: va con la primera.`
            });
            cameraIndex = 0;
        }

        const durationSecBlock = round(block.endSec - block.startSec);
        const segment = {
            index: segments.length,
            blockIndex: block.index,
            keep,
            sourceStartSec: round(block.startSec),
            sourceEndSec: round(block.endSec),
            durationSec: durationSecBlock,
            timelineStartSec: keep ? round(timelineSec) : null,
            timelineEndSec: keep ? round(timelineSec + durationSecBlock) : null,
            view,
            cameraIndex,
            note: block.note || '',
            cueIn: block.cueIn || '',
            cueOut: block.cueOut || '',
            confidence: block.confidence || 'baja',
            problems: block.problems || []
        };

        if (durationSecBlock < 1) {
            warnings.push({
                code: 'bloque_corto',
                message: `El bloque ${block.index + 1} dura ${durationSecBlock.toFixed(2)} s: revisalo antes de exportar.`
            });
        }

        if (keep) timelineSec += durationSecBlock;
        segments.push(segment);
    }

    if (unknownViews.size) {
        warnings.push({
            code: 'vista_desconocida',
            message: `No sé a qué cámara va ${[...unknownViews].join(', ')}: por ahora van a la primera. Cambialo en el mapeo de vistas.`
        });
    }

    // Lo que se elimina es todo lo que queda entre bloques (y las puntas).
    const removed = [];
    const kept = segments.filter(s => s.keep);
    let cursor = 0;
    for (const segment of kept) {
        if (segment.sourceStartSec > cursor + 0.001) {
            removed.push({
                startSec: round(cursor),
                endSec: segment.sourceStartSec,
                durationSec: round(segment.sourceStartSec - cursor)
            });
        }
        cursor = Math.max(cursor, segment.sourceEndSec);
    }
    if (durationSec != null && durationSec > cursor + 0.001) {
        removed.push({
            startSec: round(cursor),
            endSec: round(durationSec),
            durationSec: round(durationSec - cursor)
        });
    }

    const keepSec = kept.reduce((sum, s) => sum + s.durationSec, 0);
    const cameras = videos.map((video, index) => ({
        index,
        name: video.name,
        path: video.path,
        used: kept.some(s => s.cameraIndex === index)
    }));

    return {
        version: CUTPLAN_VERSION,
        createdAt: new Date().toISOString(),
        fps,
        durationSec,
        viewMap,
        cameras,
        audios: audios.map((audio, index) => ({
            index,
            name: audio.name,
            path: audio.path,
            isLiveMix: Boolean(audio.isLiveMix),
            enabled: Boolean(audio.isLiveMix)
        })),
        segments,
        removed,
        totals: {
            segments: segments.length,
            kept: kept.length,
            keepSec: round(keepSec),
            removeSec: durationSec == null ? null : round(durationSec - keepSec),
            needsReview: segments.filter(s => s.keep && s.confidence !== 'alta').length
        },
        warnings
    };
}

/** Nombres de vista presentes en unos bloques, para armar la tabla de mapeo. */
function viewsIn(blocks) {
    const counts = {};
    for (const block of blocks || []) {
        const key = block.view || '(sin nombre)';
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

module.exports = { buildCutplan, viewsIn, DEFAULT_VIEW_MAP, CUTPLAN_VERSION };
