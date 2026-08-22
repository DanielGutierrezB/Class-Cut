'use strict';
/**
 * workspace.js — Dónde escribe Class Cut, que es en un solo lugar.
 *
 * Toda la salida vive en `<raíz agregada>/The Cutter/`: los XML finales de las
 * clases juntos y, al lado, `Backup/<secuencia>/` con lo que se usó para generar
 * cada uno. El árbol del curso no se toca nunca — el XML del Rodecaster se lee y
 * se deja donde está.
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
