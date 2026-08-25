'use strict';
/**
 * course-scan.js — Descubre las clases de una ruta, sin creerle a los nombres.
 *
 * En el curso real las carpetas se llaman "Clase 03 -Default…" (sin espacio),
 * "FIRS CLASS…" (sin número) y los días pueden escribirse de cualquier forma. Por
 * eso una clase se reconoce por su FIRMA: una carpeta que tiene dentro `Audio/` y
 * `Video/`. El XML se busca ahí mismo y, si falta, la clase aparece igual en la
 * tabla marcada como no procesable — una carpeta rota no puede tumbar a las otras
 * doce.
 *
 * El número de clase sale del nombre de secuencia del XML (`04_…`), que es el
 * único lugar donde el dato es fiable: "FIRS CLASS" es internamente la 13.
 *
 * La misma función sirve para las tres cosas que el editor puede soltar: el curso
 * entero, un día, o una clase sola. Lo que le dieron se deduce de dónde
 * aparecieron las clases (`kind`).
 */

const fs = require('fs');
const path = require('path');
const rodecaster = require('./rodecaster-xml');
const estadoClase = require('./estado-clase');

const OUTPUT_DIR = 'The Cutter';
const AUDIO_DIR = 'audio';
const VIDEO_DIR = 'video';
const MAX_DEPTH = 5;

// Carpetas que nunca son material: la propia salida de Class Cut (si no, la app se
// encontraría a sí misma en el siguiente escaneo), las que crea el Rodecaster
// vacías y las de sincronización de GoodSync.
const SKIP_DIRS = new Set(['media', '_gsdata_', 'the cutter', 'backup', 'node_modules']);

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mxf', '.avi', '.m4v']);
const AUDIO_EXT = new Set(['.wav', '.aif', '.aiff', '.mp3', '.m4a', '.flac']);

const LIVE_MIX_RE = /^live[-_ ]?mix/i;

function isJunk(name) {
    // "._algo" son los AppleDouble que deja macOS en discos externos: mismo nombre
    // que el archivo real, así que sin esto cada clase aparecía con el doble de
    // material.
    return name.startsWith('._') || name.startsWith('.');
}

function listDir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
}

/** Prefijo numérico de "1_CAMERA 1.mp4" → 1. Sin prefijo → null (va al final). */
function numericPrefix(name) {
    const m = name.match(/^(\d{1,3})[_\s-]/);
    return m ? parseInt(m[1], 10) : null;
}

function byNumericPrefix(a, b) {
    const na = numericPrefix(a.name);
    const nb = numericPrefix(b.name);
    if (na != null && nb != null) return na - nb || a.name.localeCompare(b.name);
    if (na != null) return -1;
    if (nb != null) return 1;
    return a.name.localeCompare(b.name);
}

/** Marca de tiempo del nombre de carpeta del Rodecaster ("…_2026-08-18_4_16-10-29"). */
function timestampFromName(name) {
    const m = String(name).match(/(\d{4})-(\d{2})-(\d{2})[_\s-]+(\d+)[_\s-]+(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, seq, hh, mm, ss] = m;
    return {
        key: `${y}${mo}${d}-${hh}${mm}${ss}-${String(seq).padStart(3, '0')}`,
        date: `${y}-${mo}-${d}`,
        time: `${hh}:${mm}:${ss}`
    };
}

function findSubdir(entries, wanted) {
    const hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === wanted);
    return hit ? hit.name : null;
}

function mediaFiles(dir, extensions) {
    return listDir(dir)
        .filter(e => e.isFile() && !isJunk(e.name) && extensions.has(path.extname(e.name).toLowerCase()))
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort(byNumericPrefix);
}

/**
 * ¿Esta carpeta es una clase? Firma: tiene `Audio/` y `Video/` dentro.
 * El XML se valida después, para poder mostrar la fila y decir qué le falta.
 */
function classSignature(dir) {
    const entries = listDir(dir);
    const audioDir = findSubdir(entries, AUDIO_DIR);
    const videoDir = findSubdir(entries, VIDEO_DIR);
    if (!audioDir || !videoDir) return null;
    return { entries, audioDir, videoDir };
}

function xmlCandidates(dir, entries) {
    return entries
        .filter(e => e.isFile() && !isJunk(e.name) && path.extname(e.name).toLowerCase() === '.xml')
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }));
}

/** De varios XML gana el que se llama como una secuencia del Rodecaster ("04_…"). */
function pickXml(candidates) {
    if (candidates.length <= 1) return { chosen: candidates[0] || null, ambiguous: false };
    const numbered = candidates.filter(c => numericPrefix(c.name) != null);
    if (numbered.length === 1) return { chosen: numbered[0], ambiguous: false };
    if (numbered.length > 1) return { chosen: numbered[0], ambiguous: true, options: numbered };
    return { chosen: candidates[0], ambiguous: true, options: candidates };
}

function readClass(dir, signature, rootPath) {
    const { entries, audioDir, videoDir } = signature;
    const folderName = path.basename(dir);
    const parent = path.dirname(dir);

    const videos = mediaFiles(path.join(dir, videoDir), VIDEO_EXT);
    const audios = mediaFiles(path.join(dir, audioDir), AUDIO_EXT);
    // Live-Mix se busca por nombre y sin importar la caja, y va al final para que
    // A1…A9 sigan siendo los canales numerados del Rodecaster.
    const liveMix = audios.find(a => LIVE_MIX_RE.test(a.name)) || null;
    const orderedAudios = audios
        .filter(a => a !== liveMix)
        .concat(liveMix ? [liveMix] : [])
        .map(a => ({ ...a, isLiveMix: a === liveMix }));

    const candidates = xmlCandidates(dir, entries);
    const pick = pickXml(candidates);

    const stamp = timestampFromName(folderName);
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch (e) { /* ruta que se fue */ }

    const cls = {
        folder: dir,
        folderName,
        dayName: parent === rootPath ? null : path.basename(parent),
        parent,
        xmlPath: pick.chosen ? pick.chosen.path : null,
        xmlName: pick.chosen ? pick.chosen.name : null,
        xmlAmbiguous: Boolean(pick.ambiguous),
        xmlOptions: pick.options ? pick.options.map(o => ({ name: o.name, path: o.path })) : null,
        videos,
        audios: orderedAudios,
        liveMixPath: liveMix ? liveMix.path : null,
        timestamp: stamp,
        sortKey: stamp ? stamp.key : String(mtime),
        mtime,
        classNumber: null,
        sequenceName: null,
        timebase: null,
        markerCount: 0,
        blockCount: 0,
        views: {},
        nominalDurationSec: null,
        durationSec: null,
        fps: null,
        problems: [],
        warnings: [],
        selected: true,
        duplicate: false,
        alreadyProcessed: false,
        // Lo que la clase guardó dentro de su carpeta la última vez, si hay.
        trabajoGuardado: null
    };

    if (!pick.chosen) {
        cls.problems.push({ code: 'sin_xml', message: 'No hay XML del Rodecaster en esta carpeta.' });
    } else {
        const parsed = rodecaster.parseFile(pick.chosen.path);
        if (!parsed.ok) {
            cls.problems.push({ code: 'xml_ilegible', message: parsed.error });
        } else {
            cls.sequenceName = parsed.sequenceName;
            cls.classNumber = parsed.classNumber;
            cls.timebase = parsed.timebase;
            cls.mediaTimebase = parsed.mediaTimebase;
            cls.markerCount = parsed.markerCount;
            cls.blockCount = parsed.blockCount;
            cls.views = parsed.views;
            // Los bloques viajan enteros: la tabla los muestra al abrir una clase y
            // las etapas siguientes (alinear, cortar) trabajan sobre esto mismo.
            cls.blocks = parsed.blocks;
            cls.lastBlockEndSec = parsed.blocks.length
                ? Math.max(...parsed.blocks.map(b => b.endSec))
                : null;
            cls.nominalDurationSec = parsed.nominalDurationSec;
            cls.hasClap = Boolean(parsed.clap);
            cls.clapSec = parsed.clap ? parsed.clap.seconds : null;
            cls.warnings.push(...parsed.warnings);
            if (cls.classNumber == null) {
                cls.warnings.push({
                    code: 'sin_numero',
                    message: 'La secuencia no empieza con número: se ordena por fecha de grabación.'
                });
            }
        }
    }

    if (cls.xmlAmbiguous) {
        cls.problems.push({
            code: 'xml_ambiguo',
            message: `Hay ${candidates.length} XML en la carpeta: elegí cuál es el de la clase.`
        });
    }
    if (!videos.length) {
        cls.problems.push({ code: 'sin_video', message: 'La carpeta Video está vacía.' });
    }
    if (!orderedAudios.length) {
        cls.problems.push({ code: 'sin_audio', message: 'La carpeta Audio está vacía.' });
    } else if (!liveMix) {
        // Sin Live-Mix no hay con qué alinear, pero la clase sirve igual: se
        // exporta con los marcadores donde el CD los dejó, avisando.
        cls.warnings.push({
            code: 'sin_live_mix',
            message: 'No hay Live-Mix: la clase se exporta sin alinear los marcadores.'
        });
    }

    cls.processable = cls.problems.length === 0;
    // La raíz por la que se llegó a esta clase: es lo que decide dónde va su
    // "The Cutter". Viaja en la clase y no aparte porque ahora pueden estar
    // cargadas varias carpetas a la vez, y cada clase tiene que saber de cuál es.
    cls.root = rootPath;
    // El id es la carpeta de la clase, no su nombre de secuencia. Con dos
    // carpetas cargadas, dos cursos distintos pueden traer una "Clase 01" cada
    // uno, y con el nombre como id la segunda pisaba a la primera en todos los
    // mapas de la ventana. La ruta es única en el disco por construcción, y es
    // la misma cada vez que se vuelve a escanear.
    cls.id = dir;
    return cls;
}

/** Recorre en profundidad buscando firmas de clase, sin entrar en lo que no toca. */
function walk(dir, rootPath, depth, found) {
    const signature = classSignature(dir);
    if (signature) {
        found.push(readClass(dir, signature, rootPath));
        return; // una clase no contiene otras clases
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory()) continue;
        if (isJunk(entry.name)) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), rootPath, depth + 1, found);
    }
}

function outputDir(rootPath) {
    return path.join(rootPath, OUTPUT_DIR);
}

function processedSequences(rootPath) {
    const done = new Map();
    for (const entry of listDir(outputDir(rootPath))) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.xml') continue;
        const name = path.basename(entry.name, path.extname(entry.name));
        let mtime = null;
        try { mtime = fs.statSync(path.join(outputDir(rootPath), entry.name)).mtimeMs; } catch (e) { /* vacío */ }
        done.set(name, mtime);
    }
    return done;
}

function canWrite(dir) {
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Escanea una ruta y devuelve qué se entendió + las clases encontradas.
 * @param {string} rootPath carpeta que soltó el editor (curso, día o clase)
 */
function scan(rootPath) {
    const resolved = path.resolve(rootPath);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (e) {
        return { ok: false, error: `No se puede leer la carpeta: ${e.message}`, root: resolved };
    }
    if (!stat.isDirectory()) {
        return { ok: false, error: 'Eso no es una carpeta.', root: resolved };
    }
    if (path.basename(resolved).toLowerCase() === OUTPUT_DIR.toLowerCase()) {
        return {
            ok: false,
            error: `"${OUTPUT_DIR}" es la carpeta que genera Class Cut. Agregá la carpeta del curso, del día o de la clase.`,
            root: resolved
        };
    }

    const found = [];
    walk(resolved, resolved, 0, found);

    const warnings = [];
    if (!canWrite(resolved)) {
        warnings.push({
            code: 'raiz_sin_escritura',
            message: 'No puedo escribir en esta carpeta: al exportar vas a tener que elegir otra para "The Cutter".'
        });
    }

    // ── Orden: por número de clase; sin número, por fecha de grabación ──
    found.sort((a, b) => {
        if (a.classNumber != null && b.classNumber != null) return a.classNumber - b.classNumber;
        if (a.classNumber != null) return -1;
        if (b.classNumber != null) return 1;
        return a.sortKey.localeCompare(b.sortKey);
    });

    // ── Duplicados: una clase re-grabada aparece dos veces. Se muestran las dos y
    // queda marcada la más nueva; procesar ambas escribiría el mismo XML. ──
    const byNumber = new Map();
    for (const cls of found) {
        if (cls.classNumber == null) continue;
        if (!byNumber.has(cls.classNumber)) byNumber.set(cls.classNumber, []);
        byNumber.get(cls.classNumber).push(cls);
    }
    for (const [number, group] of byNumber) {
        if (group.length < 2) continue;
        const newest = group.reduce((best, c) => (c.sortKey > best.sortKey ? c : best), group[0]);
        for (const cls of group) {
            cls.duplicate = true;
            cls.selected = cls === newest && cls.processable;
            cls.warnings.push({
                code: 'clase_duplicada',
                message: cls === newest
                    ? `Hay otra carpeta con la clase ${number}: quedó marcada esta, la más reciente.`
                    : `Otra carpeta más reciente tiene la clase ${number}: esta queda sin marcar.`
            });
        }
        warnings.push({
            code: 'clase_duplicada',
            message: `La clase ${number} aparece en ${group.length} carpetas.`
        });
    }

    const done = processedSequences(resolved);
    for (const cls of found) {
        if (!cls.processable) cls.selected = false;
        if (cls.sequenceName && done.has(cls.sequenceName)) {
            cls.alreadyProcessed = true;
            cls.processedAt = done.get(cls.sequenceName);
        }

        // Las clases procesadas antes de que existiera el archivo tienen su
        // trabajo solo en este Backup: se les da el suyo ahora, antes de que a
        // alguien se le ocurra mover la carpeta.
        if (cls.processable) estadoClase.rescatar({ root: resolved, cls });

        // Y lo que la clase se guardó a sí misma, que es lo que sobrevive a
        // entrar por otra carpeta. Manda sobre el XML de salida: puede haber
        // trabajo hecho sin XML en ESTA raíz, que es justo el caso que esto
        // viene a resolver.
        const guardado = estadoClase.resumen(cls);
        if (!guardado) continue;
        cls.alreadyProcessed = true;
        cls.trabajoGuardado = {
            procesadaEn: guardado.procesadaEn,
            sirve: guardado.vale,
            porque: guardado.porque,
            modelo: guardado.modelo,
            // Cuánto dura la clase ya cortada y cuánto costó cortarla. Es lo que
            // la tabla muestra en vez de repetir la duración del material, que
            // para una clase ya hecha es el dato que menos importa.
            duracionFinalSec: guardado.duracionFinalSec,
            msProceso: guardado.msProceso,
            tokens: guardado.tokens
        };
        if (!guardado.vale) {
            cls.warnings.push({
                code: 'trabajo_viejo',
                message: `${guardado.porque} Se va a rehacer lo que haga falta.`
            });
        }
    }

    // ── Qué le dieron ──
    const days = new Set(found.filter(c => c.parent !== resolved).map(c => c.parent));
    let kind = 'empty';
    if (found.length) {
        if (found.length === 1 && found[0].folder === resolved) kind = 'class';
        else if (days.size === 0) kind = 'day';
        else kind = 'course';
    }

    return {
        ok: true,
        root: resolved,
        rootName: path.basename(resolved),
        outputDir: outputDir(resolved),
        writable: canWrite(resolved),
        kind,
        dayCount: days.size,
        dayNames: [...days].map(d => path.basename(d)).sort(),
        classes: found,
        classCount: found.length,
        processableCount: found.filter(c => c.processable).length,
        warnings
    };
}

module.exports = { scan, OUTPUT_DIR, outputDir, timestampFromName, numericPrefix, LIVE_MIX_RE };
