'use strict';
/**
 * rodecaster-xml.js — Lee el XML (xmeml v4 / FCP7) que exporta el Rodecaster Video.
 *
 * Ese XML no trae material: es una secuencia vacía con formato y MARCADORES. Los
 * marcadores son el trabajo del director de contenido, y vienen en pares:
 *
 *   IN  → "<nota del editor> -  3, 2, 1. <primeras palabras dichas>"   (dura 300 frames)
 *   OUT → "OUT: <últimas palabras dichas>"                             (sin duración)
 *
 * Tres cosas que parecen detalles y deciden si el corte sale bien:
 *
 * 1. El par se decide por DURACIÓN, no por el texto. Hay notas del CD que empiezan
 *    con "OUT ANTES DE: ..." y son un IN (clase 13 del curso real): mirar el prefijo
 *    "OUT:" habría partido esa clase entera por la mitad.
 * 2. El `out` del marcador IN no es el fin del bloque — son 10 s de adorno visual.
 *    El bloque termina donde está el marcador OUT, que puede caer ANTES de ese
 *    `out` (bloques de ~6 s en el curso real).
 * 3. La claqueta son dos marcadores en el mismo frame y sin duración, así que por
 *    la regla de duración los dos parecerían OUT. Se reconoce antes, por su texto.
 *
 * El comentario del marcador se conserva SIEMPRE tal cual: es de quien escribió la
 * nota, y todo el pipeline lo lee pero nadie lo reescribe.
 */

const fs = require('fs');

// El conteo con el que arranca cada toma. Escrito de oído, así que aparece como
// "3, 2, 1.", "3. 2, 1.", "3 2 1.", "Ok, 3 2 1." y hasta "3 2 3 2 1." (un falso
// arranque, en el curso real). Se pide un run de al menos dos números para no
// confundirlo con un "1" suelto del habla, y solo se busca al principio del cue.
const COUNT_RUN = /^(?:ok\b\s*[.,]?\s*)?(?:(?:3|2|1|tres|dos|uno)\b\s*[.,]?\s*){2,}/i;

// La claqueta se reconoce por el texto del comentario. "Clapperboard" es lo que
// escribe la herramienta del CD hoy; "claqueta" queda aceptado por si algún día
// se escribe en español.
const CLAP_TEXT = /clapperboard|claqueta/i;

const SEPARATOR = ' - ';

function decodeEntities(raw) {
    return String(raw == null ? '' : raw)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
        // &amp; al final: al revés, "&amp;lt;" se decodificaría dos veces.
        .replace(/&amp;/g, '&');
}

function tagValue(block, tag) {
    const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
    return m ? decodeEntities(m[1]) : null;
}

function tagNumber(block, tag) {
    const v = tagValue(block, tag);
    if (v == null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

/**
 * Comentario de un marcador IN → nota del editor + cue (lo que se dice).
 *
 * La nota puede contener " - " ella misma (`OUT ANTES DE: "..." - 3, 2, 1. ...`),
 * así que el separador bueno es el ÚLTIMO que deja un conteo justo detrás. Si no
 * hay conteo se cae al primero, que es la convención vieja de Editor-Pro.
 */
function parseInComment(raw) {
    const text = String(raw == null ? '' : raw);
    const out = { note: '', cue: '', count: '', hasCount: false, hasNote: false };

    let sepIdx = -1;
    for (let i = text.length; i >= 0; i--) {
        const idx = text.lastIndexOf(SEPARATOR, i);
        if (idx === -1) break;
        const after = text.slice(idx + SEPARATOR.length).replace(/^\s+/, '');
        if (COUNT_RUN.test(after)) { sepIdx = idx; break; }
        i = idx - 1;
    }
    if (sepIdx === -1) sepIdx = text.indexOf(SEPARATOR);

    let after;
    if (sepIdx === -1) {
        after = text;
    } else {
        out.note = text.slice(0, sepIdx).trim();
        after = text.slice(sepIdx + SEPARATOR.length);
    }
    after = after.replace(/^\s+/, '');

    const m = after.match(COUNT_RUN);
    if (m) {
        out.count = m[0].trim();
        out.hasCount = true;
        after = after.slice(m[0].length);
    }
    out.cue = after.trim();
    out.hasNote = out.note.length > 0;
    return out;
}

/** Comentario de un marcador OUT → las últimas palabras dichas del bloque. */
function parseOutComment(raw) {
    const text = String(raw == null ? '' : raw);
    const stripped = text.replace(/^\s*OUT\s*:\s*/i, '');
    return { cue: stripped.trim(), hadPrefix: stripped !== text };
}

/** Número de clase del nombre de secuencia ("04_2608_spec-driven-…" → 4). */
function classNumberFromSequenceName(name) {
    const m = String(name == null ? '' : name).match(/^(\d{1,3})[_\s-]/);
    return m ? parseInt(m[1], 10) : null;
}

function isClapMarker(marker, index) {
    if (CLAP_TEXT.test(marker.comment)) return true;
    // "K" es el nombre que usa el CD para la claqueta. Solo se acepta al principio
    // de la secuencia: un marcador de contenido llamado K más adelante es trabajo.
    return marker.name === 'K' && index < 2;
}

/**
 * Texto del XML → secuencia con marcadores y bloques ya emparejados.
 * Nunca lanza por contenido: lo que no cuadra viaja en `warnings`/`problems`.
 */
function parseXml(text, options) {
    const opts = options || {};
    const warnings = [];
    const src = String(text == null ? '' : text);

    const seqMatch = src.match(/<sequence\b[\s\S]*?>([\s\S]*)<\/sequence>/);
    if (!seqMatch) {
        return { ok: false, error: 'El archivo no tiene una <sequence>: no parece un XML del Rodecaster.' };
    }
    const seqBody = seqMatch[1];
    // El <name> de la secuencia es el primero del cuerpo; dentro de <media> hay
    // otros (el codec se llama "h264"), así que se corta antes de <media>.
    const head = seqBody.split('<media>')[0];

    const sequenceName = tagValue(head, 'name');
    if (!sequenceName) {
        return { ok: false, error: 'El XML no declara el nombre de la secuencia.' };
    }

    const timebase = tagNumber(head, 'timebase') || opts.fallbackTimebase || 30;
    const ntsc = /<ntsc>\s*TRUE\s*<\/ntsc>/i.test(head);
    const nominalDurationFrames = tagNumber(head, 'duration');

    const formatBlock = (seqBody.match(/<samplecharacteristics>[\s\S]*?<\/samplecharacteristics>/) || [''])[0];
    const mediaTimebase = tagNumber(formatBlock, 'timebase');
    const width = tagNumber(formatBlock, 'width');
    const height = tagNumber(formatBlock, 'height');

    const markers = [];
    const markerRe = /<marker>([\s\S]*?)<\/marker>/g;
    let mm;
    let index = 0;
    while ((mm = markerRe.exec(seqBody)) !== null) {
        const body = mm[1];
        const inFrame = tagNumber(body, 'in');
        const outFrame = tagNumber(body, 'out');
        if (inFrame == null) {
            warnings.push({ code: 'marker_sin_in', message: `Marcador ${index + 1} sin posición: se ignora.` });
            index++;
            continue;
        }
        const end = (outFrame == null) ? inFrame : outFrame;
        markers.push({
            index: index++,
            name: tagValue(body, 'name') || '',
            comment: tagValue(body, 'comment') || '',
            inFrame,
            outFrame: end,
            spanFrames: Math.max(0, end - inFrame),
            color: tagNumber(body, 'pproColor')
        });
    }

    // ── Clasificar: claqueta primero, el resto por duración ──
    let clap = null;
    const clapMarkers = [];
    for (const marker of markers) {
        if (isClapMarker(marker, marker.index)) {
            marker.kind = 'clap';
            clapMarkers.push(marker);
            continue;
        }
        marker.kind = marker.spanFrames > 0 ? 'in' : 'out';
    }
    if (clapMarkers.length) {
        clap = {
            frame: clapMarkers[0].inFrame,
            seconds: clapMarkers[0].inFrame / timebase,
            markerCount: clapMarkers.length,
            name: clapMarkers[0].name,
            comment: clapMarkers[0].comment
        };
    } else {
        warnings.push({
            code: 'sin_claqueta',
            message: 'No hay marcador de claqueta: la alineación se hará solo con el audio.'
        });
    }

    // ── Emparejar en orden de documento ──
    const blocks = [];
    let pending = null;
    for (const marker of markers) {
        if (marker.kind === 'clap') continue;

        if (marker.kind === 'in') {
            if (pending) {
                blocks.push(makeBlock(pending, null, timebase, blocks.length));
                warnings.push({
                    code: 'bloque_sin_out',
                    message: `El bloque que abre en ${fmt(pending.inFrame / timebase)} no tiene OUT: queda para cerrar a mano.`
                });
            }
            pending = marker;
            continue;
        }

        if (!pending) {
            warnings.push({
                code: 'out_huerfano',
                message: `Hay un OUT sin IN en ${fmt(marker.inFrame / timebase)}: se ignora.`
            });
            continue;
        }
        const block = makeBlock(pending, marker, timebase, blocks.length);
        if (block.endFrame < block.startFrame) {
            block.complete = false;
            block.problems.push('El OUT cae antes del IN.');
            warnings.push({
                code: 'out_antes_del_in',
                message: `El bloque de ${fmt(block.startSec)} tiene el OUT antes del IN: queda para revisar.`
            });
        }
        blocks.push(block);
        pending = null;
    }
    if (pending) {
        blocks.push(makeBlock(pending, null, timebase, blocks.length));
        warnings.push({
            code: 'bloque_sin_out',
            message: `El último bloque (${fmt(pending.inFrame / timebase)}) no tiene OUT: queda para cerrar a mano.`
        });
    }

    for (let i = 1; i < blocks.length; i++) {
        if (blocks[i].complete && blocks[i - 1].complete &&
            blocks[i].startFrame < blocks[i - 1].endFrame) {
            warnings.push({
                code: 'bloques_solapados',
                message: `Los bloques ${i} y ${i + 1} se solapan: queda para revisar.`
            });
        }
    }

    return {
        ok: true,
        sequenceName,
        classNumber: classNumberFromSequenceName(sequenceName),
        timebase,
        ntsc,
        mediaTimebase,
        nominalDurationFrames,
        nominalDurationSec: nominalDurationFrames == null ? null : nominalDurationFrames / timebase,
        width,
        height,
        markers,
        markerCount: markers.length,
        clap,
        blocks,
        blockCount: blocks.length,
        views: countViews(blocks),
        warnings
    };
}

function makeBlock(inMarker, outMarker, timebase, idx) {
    const parsedIn = parseInComment(inMarker.comment);
    const parsedOut = outMarker ? parseOutComment(outMarker.comment) : { cue: '', hadPrefix: false };
    const endFrame = outMarker ? outMarker.inFrame : inMarker.outFrame;
    return {
        index: idx,
        view: inMarker.name || '',
        color: inMarker.color,
        startFrame: inMarker.inFrame,
        endFrame,
        startSec: inMarker.inFrame / timebase,
        endSec: endFrame / timebase,
        durationSec: (endFrame - inMarker.inFrame) / timebase,
        note: parsedIn.note,
        cueIn: parsedIn.cue,
        count: parsedIn.count,
        hasCount: parsedIn.hasCount,
        cueOut: parsedOut.cue,
        inComment: inMarker.comment,
        outComment: outMarker ? outMarker.comment : null,
        inMarkerIndex: inMarker.index,
        outMarkerIndex: outMarker ? outMarker.index : null,
        complete: Boolean(outMarker),
        problems: outMarker ? [] : ['Sin marcador OUT.']
    };
}

function countViews(blocks) {
    const out = {};
    for (const b of blocks) {
        const key = b.view || '(sin nombre)';
        out[key] = (out[key] || 0) + 1;
    }
    return out;
}

function fmt(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function parseFile(xmlPath, options) {
    let text;
    try {
        text = fs.readFileSync(xmlPath, 'utf8');
    } catch (e) {
        return { ok: false, error: `No se pudo leer el XML: ${e.message}` };
    }
    const parsed = parseXml(text, options);
    if (parsed.ok) parsed.xmlPath = xmlPath;
    return parsed;
}

module.exports = {
    parseXml,
    parseFile,
    parseInComment,
    parseOutComment,
    classNumberFromSequenceName,
    decodeEntities,
    COUNT_RUN,
    CLAP_TEXT
};
