'use strict';
/**
 * workspace.js — Dónde escribe Class Cut, que es en dos lugares y en ninguno más.
 *
 * Lo que sale de cortar una clase vive en `<raíz agregada>/The Cutter/`: los XML
 * finales de las clases juntos y, al lado, `Backup/` con lo que se usó para
 * generar cada uno. El árbol del curso no se toca nunca — el XML del Rodecaster
 * se lee y se deja donde está.
 *
 * Lo que sale de tomar notas en vivo vive en la carpeta que eligió el editor,
 * repartido en `xml/` (ver más abajo). Es otra raíz y otro flujo, pero la forma
 * de la carpeta se decide acá por lo mismo: la ruta la arman cuatro archivos y
 * un `path.join` suelto en cualquiera de ellos escribe donde nadie busca.
 *
 * Se escribe siempre a un temporal y se renombra: si la app se cierra a mitad, lo
 * que queda en disco es lo de antes y no medio archivo que el editor importaría
 * sin sospechar nada.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = 'The Cutter';
const BACKUP_DIR = 'Backup';

// El sufijo que lleva cada artefacto. Los dos XML son los que el editor puede
// importar para ver en qué paso se rompió algo.
const FILES = {
    transcript: 'transcript.json',
    align: 'align.json',
    cutplan: 'cutplan.json',
    coherence: 'coherence.json',
    // Dónde la clase se queda callada. Sale del audio, tarda casi un segundo de
    // disco y no cambia nunca: se calcula la primera vez que se abre el visor y
    // queda guardado.
    silencios: 'silencios.json',
    // Dónde suena alguien, a resolución de sílaba. Sale del audio y tampoco
    // cambia nunca: con él se corrigen los tiempos de las palabras, que Whisper
    // no mide (`voz.js`, `retimeo.js`).
    voz: 'voz.json',
    // Lo escribe el editor, no el pipeline: es lo único del Backup que no se
    // puede volver a calcular, así que reprocesar no lo toca.
    notas: 'notas.json',
    log: 'run.log',
    populatedXml: 'poblada.xml',
    alignedXml: 'alineada.xml'
};

function outputRoot(root) {
    return path.join(root, OUTPUT_DIR);
}

function backupRoot(root) {
    return path.join(outputRoot(root), BACKUP_DIR);
}

/**
 * Los artefactos van sueltos dentro de `Backup/`, con el nombre de la secuencia
 * y qué son al final: `04_…_105913_alineada.xml`. Una carpeta por clase obligaba
 * a entrar y salir de trece carpetas para comparar dos alineados.
 */
function artifact(root, sequenceName, key) {
    const file = FILES[key];
    if (!file) throw new Error(`Artefacto desconocido: ${key}`);
    return path.join(backupRoot(root), `${safeName(sequenceName)}_${file}`);
}

/**
 * Pasa los Backup viejos (una carpeta por clase) al formato plano. Es de un solo
 * uso y no borra nada que no haya movido: sin esto, los transcripts guardados
 * quedarían invisibles y habría que volver a pasar Whisper por horas de audio.
 * @returns {{moved: number, folders: number}}
 */
function migrateBackup(root) {
    const base = backupRoot(root);
    let moved = 0;
    let folders = 0;

    let entries;
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
        return { moved, folders };
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        let inside;
        try { inside = fs.readdirSync(dir); } catch (e) { continue; }

        for (const name of inside) {
            const target = path.join(base, `${entry.name}_${name}`);
            if (fs.existsSync(target)) continue;
            try {
                fs.renameSync(path.join(dir, name), target);
                moved++;
            } catch (e) { /* lo que no se pueda mover se queda donde está */ }
        }
        try {
            if (!fs.readdirSync(dir).length) { fs.rmdirSync(dir); folders++; }
        } catch (e) { /* la carpeta se queda si algo quedó adentro */ }
    }
    return { moved, folders };
}

function finalXml(root, sequenceName) {
    return path.join(outputRoot(root), `${safeName(sequenceName)}.xml`);
}

function masterXml(root) {
    return path.join(outputRoot(root), 'Sync.xml');
}


// ─── La carpeta de notas en vivo ──────────────────────────────────────

/**
 * Cómo se reparte la carpeta que el editor eligió para tomar notas.
 *
 *   <la carpeta>/
 *     xml/
 *       01_curso_2026-09-08_13-01-47.xml      lo que se importa en Premiere
 *       Audio/                                 el WAV de cada grabación
 *       Datos/                                 el archivo con la hora del día
 *
 * Antes caía todo suelto en la raíz. Con trece clases eso son trece XML, trece
 * JSON y una carpeta de audio mezclados con lo que el editor tenga ahí, y lo
 * único que él va a buscar a mano es el XML: por eso los XML quedan sueltos y
 * lo demás baja un piso.
 *
 * `Audio` va con mayúscula porque es la del Rodecaster —el editor ya abre
 * carpetas que se llaman así todo el día— y `Datos` la sigue. Se llama `Datos`
 * y no `Notas` porque las notas son el XML: esto es lo que la app se guarda
 * para sí misma, y el nombre tiene que decir "acá no hay nada que importar".
 */
const NOTAS_XML_DIR = 'xml';
const NOTAS_AUDIO_DIR = 'Audio';
const NOTAS_DATOS_DIR = 'Datos';

/**
 * Cómo termina el archivo con la hora del día, que es lo que hace visible a una
 * clase: la lista de grabadas se arma buscando este sufijo (`grabacion.listar`).
 */
const SUFIJO_SIDECAR = '_notas-en-vivo.json';

/** Donde iba el audio cuando la carpeta no tenía forma. Solo se lee. */
const NOTAS_AUDIO_PLANO = 'audio';

function notasXmlDir(base) {
    return path.join(base, NOTAS_XML_DIR);
}

function notasAudioDir(base) {
    return path.join(notasXmlDir(base), NOTAS_AUDIO_DIR);
}

function notasDatosDir(base) {
    return path.join(notasXmlDir(base), NOTAS_DATOS_DIR);
}

/**
 * Dónde van el XML y el archivo con la hora del día de una clase.
 *
 * `nombre` llega limpio de quien lo arma (`safeName` en `grabacion.escribir`) o
 * tal cual del disco cuando se está releyendo una clase que ya existe. No se
 * limpia acá a propósito: sobre un nombre que salió de `readdir` cambiar un
 * caracter apuntaría a un archivo que no está.
 */
function notasArchivos(base, nombre) {
    return {
        xml: path.join(notasXmlDir(base), `${nombre}.xml`),
        json: path.join(notasDatosDir(base), `${nombre}${SUFIJO_SIDECAR}`)
    };
}

/**
 * De vuelta: a partir del archivo con la hora del día, dónde está el resto.
 *
 * Hace falta porque una clase ya grabada se abre y se edita pasando ese archivo
 * y nada más (`editarGrabada`, `regenerar`, y el puente que los llama): del
 * sidecar cuelga todo lo demás. Y hace falta que entienda las dos formas —la de
 * ahora y la plana de antes—, porque una clase que quedó en la raíz tiene que
 * poder abrirse y editarse igual mientras no se la haya mudado.
 *
 * `audios` son las dos carpetas donde puede estar el WAV, en ese orden. Se
 * devuelven las dos y no la que corresponda al sitio del sidecar porque la
 * mudanza pasa archivo por archivo: entre que se mueve el sidecar y se mueve el
 * audio hay un instante en que están en pisos distintos, y "regenerar" no puede
 * depender de no caer justo ahí.
 */
function notasDeClase(json) {
    const dir = path.dirname(json);
    const nombre = path.basename(json, SUFIJO_SIDECAR);
    const enSuSitio = path.basename(dir) === NOTAS_DATOS_DIR
        && path.basename(path.dirname(dir)) === NOTAS_XML_DIR;
    const base = enSuSitio ? path.dirname(path.dirname(dir)) : dir;
    return {
        base,
        nombre,
        xml: enSuSitio
            ? path.join(notasXmlDir(base), `${nombre}.xml`)
            : path.join(base, `${nombre}.xml`),
        json,
        audios: [notasAudioDir(base), path.join(base, NOTAS_AUDIO_PLANO)]
    };
}

/**
 * Dónde buscar un XML de notas, de mejor a peor.
 *
 * La raíz sigue en la lista para las clases que todavía no se mudaron —una
 * carpeta de notas en un disco de solo lectura no se muda nunca— y porque el
 * editor puede haber dejado ahí un XML a mano. Va segunda: si la misma clase
 * está en los dos sitios, gana la de adentro, que es la que se reescribe.
 */
function notasConXml(base) {
    return [notasXmlDir(base), base];
}

/** Dónde buscar el archivo con la hora del día, en el mismo orden y por lo mismo. */
function notasConDatos(base) {
    return [notasDatosDir(base), base];
}

/**
 * Mueve un archivo a su sitio nuevo, sin pisar nada y sin explotar.
 *
 * Que un origen que no está cuente como movido es lo que hace que la mudanza se
 * pueda retomar: si se cortó después de mover el XML y antes del sidecar, la
 * pasada siguiente ve el XML ya en su sitio y termina el trabajo.
 *
 * @returns {boolean} si el origen ya no está donde estaba
 */
function mudar(origen, destino) {
    if (!fs.existsSync(origen)) return true;
    // Un archivo del editor no se pisa nunca. Lo que no se pueda mover se queda
    // en la raíz, y de ahí que se lo siga leyendo (`notasConDatos`).
    if (fs.existsSync(destino)) return false;
    try {
        ensureDir(path.dirname(destino));
        fs.renameSync(origen, destino);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Pasa una carpeta de notas de cuando todo caía suelto a la forma de ahora.
 *
 * Se corre al listar las clases de la carpeta, así que pasa sola y una vez; las
 * siguientes no encuentran nada que mover y son un `readdir`. Es el mismo trato
 * que se le dio a los Backup viejos (`migrateBackup`): mudanza de un solo uso,
 * no borra nada que no haya movido y no pisa nada.
 *
 * **Se muda en vez de leer los dos sitios para siempre** porque lo que el editor
 * pidió es que la carpeta deje de hacer ruido, y dejar las trece clases que ya
 * tiene tiradas en la raíz sería no haber hecho nada — con el agregado de que
 * ahora habría dos sitios donde mirar. Se lee igual la raíz, pero como red y no
 * como estructura: lo que no se pudo mover sigue apareciendo.
 *
 * **El orden es el que importa.** El sidecar es lo que hace visible a una clase,
 * así que se mueve último: si esto se corta a la mitad, la clase sigue en la
 * raíz y sigue en la lista. Al revés, una clase podría quedar apuntando a un XML
 * que ya no está ahí.
 *
 * @returns {{clases:number, audios:number}}
 */
function migrarNotas(base) {
    const movido = { clases: 0, audios: 0 };

    let entradas;
    try {
        entradas = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
        return movido; // una carpeta que ya no está no tiene nada que mudar
    }

    for (const entrada of entradas) {
        if (!entrada.isFile() || !entrada.name.endsWith(SUFIJO_SIDECAR)) continue;
        const nombre = entrada.name.slice(0, -SUFIJO_SIDECAR.length);
        const destino = notasArchivos(base, nombre);
        if (!mudar(path.join(base, `${nombre}.xml`), destino.xml)) continue;
        if (mudar(path.join(base, entrada.name), destino.json)) movido.clases++;
    }

    const viejo = path.join(base, NOTAS_AUDIO_PLANO);
    let wavs = [];
    try { wavs = fs.readdirSync(viejo); } catch (e) { return movido; }
    for (const wav of wavs) {
        if (mudar(path.join(viejo, wav), path.join(notasAudioDir(base), wav))) movido.audios++;
    }
    try {
        if (!fs.readdirSync(viejo).length) fs.rmdirSync(viejo);
    } catch (e) { /* algo quedó adentro: la carpeta se queda */ }

    return movido;
}


/** El nombre de secuencia va a ser un nombre de archivo: se limpia lo que no puede. */
function safeName(name) {
    return String(name == null ? '' : name)
        .replace(/[/\\:]/g, '-')
        .replace(/^\.+/, '')
        .trim() || 'sin-nombre';
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Escritura atómica: primero un temporal al lado (mismo volumen, para que el
 * rename sea instantáneo y no una copia), después el rename.
 */
function writeAtomic(filePath, contents) {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, filePath);
    return filePath;
}

function writeJson(filePath, value) {
    return writeAtomic(filePath, JSON.stringify(value, null, 2));
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function appendLog(filePath, line) {
    ensureDir(path.dirname(filePath));
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(filePath, `[${stamp}] ${line}\n`);
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
 * Huella del archivo de origen. Con esto se decide si un artefacto guardado sigue
 * valiendo: si el WAV cambió de tamaño o de fecha, lo que se calculó sobre él ya
 * no describe este audio.
 */
function fingerprint(filePath) {
    try {
        const st = fs.statSync(filePath);
        return { path: filePath, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
        return null;
    }
}

function sameFingerprint(a, b) {
    if (!a || !b) return false;
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

module.exports = {
    OUTPUT_DIR,
    BACKUP_DIR,
    FILES,
    outputRoot,
    backupRoot,
    artifact,
    migrateBackup,
    finalXml,
    masterXml,
    SUFIJO_SIDECAR,
    notasXmlDir,
    notasAudioDir,
    notasDatosDir,
    notasArchivos,
    notasDeClase,
    notasConXml,
    notasConDatos,
    migrarNotas,
    safeName,
    ensureDir,
    writeAtomic,
    writeJson,
    readJson,
    appendLog,
    canWrite,
    fingerprint,
    sameFingerprint
};
