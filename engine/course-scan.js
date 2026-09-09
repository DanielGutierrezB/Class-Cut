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
const nombreDeClase = require('./nombre-de-clase');
const estadoClase = require('./estado-clase');
const workspace = require('./workspace');

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

/**
 * Qué número de clase es esta carpeta, mirando solo su nombre.
 *
 * El Rodecaster las nombra "Clase 01 - Default_2026-08-18_1_13-01-47", así que el
 * número no está al principio y `numericPrefix` no lo ve. Hace falta para
 * emparejar una clase con el XML de notas que se tomó en vivo, que vive en otra
 * carpeta: sin XML adentro no hay nombre de secuencia de donde sacarlo.
 */
function classNumberFromFolder(name) {
    const m = String(name == null ? '' : name).match(/\bclase\s*0*(\d{1,3})\b/i);
    if (m) return parseInt(m[1], 10);
    return numericPrefix(String(name == null ? '' : name));
}

/** Cómo se la nombra en un aviso: "clase 4", o "clase 4 (parte 2)" si la tiene. */
function nombreDeLaClase(cls) {
    return `clase ${cls.classNumber}${cls.parte > 1 ? ` (parte ${cls.parte})` : ''}`;
}

function byNumericPrefix(a, b) {
    const na = numericPrefix(a.name);
    const nb = numericPrefix(b.name);
    if (na != null && nb != null) return na - nb || a.name.localeCompare(b.name);
    if (na != null) return -1;
    if (nb != null) return 1;
    return a.name.localeCompare(b.name);
}

/**
 * Marca de tiempo del nombre de carpeta del Rodecaster ("…_2026-08-18_4_16-10-29").
 *
 * Es el ARRANQUE de esa grabación, medido en el curso real: la clase 1 empieza
 * a las 13:01:47 y dura 42 min, la 2 arranca 13:56:35 y dura 47, la 3 arranca
 * 15:03:47. Por eso `ms` sirve para emparejar la carpeta con el XML que se
 * escribió tomando notas, que lleva su propia hora de arranque.
 *
 * `ms` se interpreta en la zona de esta máquina, sin `Z` ni desfase: el
 * Rodecaster escribe la hora de su propio reloj de pared, y la herramienta de
 * notas también (ver `nombre-de-clase.js`).
 */
function timestampFromName(name) {
    const m = String(name).match(/(\d{4})-(\d{2})-(\d{2})[_\s-]+(\d+)[_\s-]+(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, seq, hh, mm, ss] = m;
    return {
        key: `${y}${mo}${d}-${hh}${mm}${ss}-${String(seq).padStart(3, '0')}`,
        date: `${y}-${mo}-${d}`,
        time: `${hh}:${mm}:${ss}`,
        ms: new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}`).getTime()
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

/**
 * Más de esto entre la carpeta y el XML y se empareja igual, pero avisando: es
 * la señal de que alguien reusó la carpeta de notas de otro día de rodaje.
 */
const LEJOS_MS = 12 * 60 * 60 * 1000;

/**
 * El XML de una clase que no lo tiene adentro, buscado en la carpeta de notas.
 *
 * Hace falta porque las notas y el material nacen en sitios distintos: la
 * herramienta de toma de notas en vivo (paso "Grabar") escribe el XML en la
 * carpeta que el editor eligió, y no puede escribirlo junto a las grabaciones
 * porque esas están en la tarjeta del Rodecaster y no aparecen en la Mac hasta
 * que la grabación termina y alguien las copia.
 *
 * Se emparejan **por número de clase y por hora de arranque**. El número solo no
 * alcanza: una clase se puede grabar en dos tandas, y entonces hay dos carpetas
 * que dicen "Clase 01" y dos XML que empiezan en "01". Antes ganaba el primero
 * que apareciera, así que las dos carpetas se llevaban el mismo XML y una
 * quedaba con los marcadores de la otra. La hora las separa: cada carpeta se
 * lleva la que arrancó más cerca, y entre dos tandas de la misma clase pasan
 * decenas de minutos.
 *
 * Las dos horas son del reloj de pared —la del Rodecaster y la de esta app— así
 * que se restan sin convertir nada (ver `nombre-de-clase.js`). Un XML de los
 * viejos no lleva hora en el nombre; se sigue aceptando por número, pero después
 * de cualquiera que sí la tenga.
 *
 * De cada carpeta de notas se miran los dos pisos donde puede haber un XML
 * (`workspace.notasConXml`): la app los escribe dentro de `xml/`, pero una clase
 * grabada antes de que la carpeta tuviera forma —o un XML que el editor dejó a
 * mano— sigue estando suelta en la raíz. Buscar en uno solo es cómo un cambio de
 * rutas deja de emparejar clases dos semanas después, sin decir nada.
 *
 * @param {number|null} classNumber el de la carpeta de la clase
 * @param {number|null} cuandoMs cuándo arrancó a grabar esa carpeta
 * @param {string[]} dirs carpetas de notas
 * @returns {{name, path, deNotas, lejosMs}|null}
 */
function xmlDeNotas(classNumber, cuandoMs, dirs) {
    if (classNumber == null || !dirs || !dirs.length) return null;

    let mejor = null;
    for (const notas of dirs) {
        for (const dir of workspace.notasConXml(notas)) {
            for (const e of listDir(dir)) {
                if (!e.isFile() || isJunk(e.name)) continue;
                if (path.extname(e.name).toLowerCase() !== '.xml') continue;

                const leido = nombreDeClase.leer(e.name);
                if (!leido || leido.clase !== classNumber) continue;

                // Sin hora de un lado o del otro no hay distancia que medir: vale
                // como último recurso, que es lo que se hacía antes de que la hora
                // existiera. `Infinity` lo deja detrás de cualquiera que sí la tenga.
                const lejos = leido.cuandoMs == null || cuandoMs == null
                    ? Infinity
                    : Math.abs(leido.cuandoMs - cuandoMs);
                if (!mejor || lejos < mejor.lejos) {
                    mejor = { name: e.name, path: path.join(dir, e.name), lejos };
                }
            }
        }
    }

    if (!mejor) return null;
    return {
        name: mejor.name,
        path: mejor.path,
        deNotas: true,
        lejosMs: Number.isFinite(mejor.lejos) ? mejor.lejos : null
    };
}

/** De varios XML gana el que se llama como una secuencia del Rodecaster ("04_…"). */
function pickXml(candidates) {
    if (candidates.length <= 1) return { chosen: candidates[0] || null, ambiguous: false };
    const numbered = candidates.filter(c => numericPrefix(c.name) != null);
    if (numbered.length === 1) return { chosen: numbered[0], ambiguous: false };
    if (numbered.length > 1) return { chosen: numbered[0], ambiguous: true, options: numbered };
    return { chosen: candidates[0], ambiguous: true, options: candidates };
}

/**
 * @param {object} contexto lo que toda clase del recorrido necesita saber y no
 *   puede deducir de su carpeta: `rootPath` (por dónde se entró) y `notasDirs`
 *   (dónde buscar el XML si no lo tiene adentro)
 */
function readClass(dir, signature, contexto) {
    const { rootPath, notasDirs } = contexto;
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

    // Cuándo arrancó a grabar esta carpeta: es la mitad del emparejamiento con
    // el XML de notas, así que se lee antes de elegirlo.
    const stamp = timestampFromName(folderName);

    const candidates = xmlCandidates(dir, entries);
    // Solo si no hay ninguno adentro: el que viaja con el material manda. Si la
    // clase ya tiene su XML, uno de la carpeta de notas sería una versión vieja
    // de lo mismo o, peor, de otra clase con el mismo número.
    const pick = candidates.length
        ? pickXml(candidates)
        : {
            chosen: xmlDeNotas(
                classNumberFromFolder(folderName), stamp ? stamp.ms : null, notasDirs),
            ambiguous: false
        };

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
        // Cuál de las tandas de esa clase es esta. Casi siempre 1: solo cambia
        // cuando una clase se grabó en dos veces y cada tanda tiene su carpeta.
        parte: 1,
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
        cls.problems.push({
            code: 'sin_xml',
            message: notasDirs.length
                ? 'No hay XML acá ni en la carpeta de notas uno con este número de clase.'
                : 'No hay XML del Rodecaster en esta carpeta.'
        });
    } else {
        // De dónde salió, para que la tabla lo pueda decir: un XML que vive en
        // otra carpeta se puede borrar sin darse cuenta de que era de esta clase.
        cls.xmlDeNotas = Boolean(pick.chosen.deNotas);
        if (pick.chosen.lejosMs > LEJOS_MS) {
            // Se empareja igual —es el único con este número— pero conviene
            // mirarlo: lo normal es que las dos horas estén a minutos.
            cls.warnings.push({
                code: 'notas_de_otro_dia',
                message: `El XML de notas se grabó ${Math.round(pick.chosen.lejosMs / 3600000)} h ` +
                    'antes o después que esta carpeta. Fijate que sea el de esta clase.'
            });
        }
        const parsed = rodecaster.parseFile(pick.chosen.path);
        if (!parsed.ok) {
            cls.problems.push({ code: 'xml_ilegible', message: parsed.error });
        } else {
            cls.sequenceName = parsed.sequenceName;
            cls.classNumber = parsed.classNumber;
            // La parte sale del nombre de la secuencia, que es donde la escribió
            // la herramienta de notas ("01_p2_…"). Un XML del director de
            // contenido no la lleva y queda en 1, que es lo que era.
            const leido = nombreDeClase.leer(parsed.sequenceName);
            cls.parte = leido ? leido.parte : 1;
            cls.timebase = parsed.timebase;
            cls.mediaTimebase = parsed.mediaTimebase;
            cls.deNotasEnVivo = Boolean(parsed.deNotasEnVivo);
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
function walk(dir, depth, found, contexto) {
    const signature = classSignature(dir);
    if (signature) {
        found.push(readClass(dir, signature, contexto));
        return; // una clase no contiene otras clases
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of listDir(dir)) {
        if (!entry.isDirectory()) continue;
        if (isJunk(entry.name)) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), depth + 1, found, contexto);
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
 *
 * No lee ajustes ni nada fuera de la carpeta que se le da: es una función del
 * disco, y así se la puede probar y correr desde una herramienta sin que el
 * resultado dependa de lo que el usuario de esa máquina tenga configurado. Quien
 * quiera que vea los XML de notas de la app le pasa `ajustes.carpetasDeNotas()`.
 *
 * @param {string} rootPath carpeta que soltó el editor (curso, día o clase)
 * @param {object} [options] `{notasDirs}`: carpetas donde buscar el XML de una
 *   clase que no lo tiene adentro (ver `xmlDeNotas`)
 */
function scan(rootPath, options) {
    const resolved = path.resolve(rootPath);
    const contexto = {
        rootPath: resolved,
        notasDirs: (options && options.notasDirs) || []
    };
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
    walk(resolved, 0, found, contexto);

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
    // queda marcada la más nueva; procesar ambas escribiría el mismo XML.
    //
    // Se agrupa por número Y por parte: una clase grabada en dos tandas son dos
    // carpetas que dicen "Clase 01" y las dos van, cada una con su XML de notas
    // (ver `xmlDeNotas`). Agrupando solo por número, la segunda tanda quedaba sin
    // marcar y media clase se perdía sin que nadie lo pidiera. ──
    const byNumber = new Map();
    for (const cls of found) {
        if (cls.classNumber == null) continue;
        const clave = `${cls.classNumber}-${cls.parte}`;
        if (!byNumber.has(clave)) byNumber.set(clave, []);
        byNumber.get(clave).push(cls);
    }
    for (const group of byNumber.values()) {
        if (group.length < 2) continue;
        const cual = nombreDeLaClase(group[0]);
        const newest = group.reduce((best, c) => (c.sortKey > best.sortKey ? c : best), group[0]);
        for (const cls of group) {
            cls.duplicate = true;
            cls.selected = cls === newest && cls.processable;
            cls.warnings.push({
                code: 'clase_duplicada',
                message: cls === newest
                    ? `Hay otra carpeta con la ${cual}: quedó marcada esta, la más reciente.`
                    : `Otra carpeta más reciente tiene la ${cual}: esta queda sin marcar.`
            });
        }
        warnings.push({
            code: 'clase_duplicada',
            message: `La ${cual} aparece en ${group.length} carpetas.`
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
