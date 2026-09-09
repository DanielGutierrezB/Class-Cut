'use strict';
/**
 * paths.js — Dónde están las herramientas externas en ESTA máquina.
 *
 * La app se distribuye con todo adentro (ffmpeg, ffprobe, whisper-cli y su
 * modelo), así que lo primero que se mira es el bundle. Pero en desarrollo esos
 * binarios todavía no están copiados y el PATH de un Electron lanzado desde el
 * Finder no es el de la terminal, así que también se buscan en los lugares
 * conocidos de Homebrew antes de rendirse.
 *
 * La ruta se resuelve una vez y se recuerda: `which` por cada llamada es tiempo
 * regalado cuando hay 13 clases y 130 archivos que medir.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KNOWN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

const cache = new Map();

function appRoot() {
    return path.resolve(__dirname, '..');
}

/** Carpeta de recursos: dentro del .app empaquetado o del repo en desarrollo. */
function bundledDirs() {
    const dirs = [];
    if (process.resourcesPath) {
        dirs.push(path.join(process.resourcesPath, 'bin'));
    }
    dirs.push(path.join(appRoot(), 'bin', 'mac'));
    dirs.push(path.join(appRoot(), 'bin'));
    return dirs;
}

/** Donde el instalador deja los modelos, fuera del `.app`. */
const DATA_DIR = '/Library/Application Support/Class Cut';

/**
 * Lo que pesa y no cambia con la app.
 *
 * Los modelos son 3.8 de los 3.9 GB del paquete y son los mismos entre versiones,
 * así que no pueden vivir dentro del `.app`: reemplazar la app en una
 * actualización se los llevaría puestos y habría que volver a bajar cuatro
 * gigas para cambiar unos kilobytes de código. El instalador los deja una vez en
 * `DATA_DIR` y de ahí los lee cualquier versión que se instale después.
 *
 * Se sigue mirando dentro del bundle al final para no romper las instalaciones
 * viejas, que los tenían adentro.
 */
function dataDirs(kind) {
    const dirs = [
        path.join(DATA_DIR, kind),
        path.join(process.env.HOME || '', 'Library', 'Application Support', 'Class Cut', kind)
    ];
    if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin', kind));
    dirs.push(path.join(appRoot(), 'bin', 'mac', kind));
    return dirs.filter(Boolean);
}

function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch (e) {
        return false;
    }
}

function fromPath(name) {
    try {
        const out = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
        return out && isExecutable(out) ? out : null;
    } catch (e) {
        return null;
    }
}

/**
 * @returns {{name:string, path:string|null, source:string, searched:string[]}}
 */
function resolveTool(name) {
    if (cache.has(name)) return cache.get(name);

    const searched = [];
    let found = null;
    let source = 'no encontrado';

    for (const dir of bundledDirs()) {
        const candidate = path.join(dir, name);
        searched.push(candidate);
        if (isExecutable(candidate)) { found = candidate; source = 'incluido en la app'; break; }
    }
    if (!found) {
        for (const dir of KNOWN_DIRS) {
            const candidate = path.join(dir, name);
            searched.push(candidate);
            if (isExecutable(candidate)) { found = candidate; source = dir; break; }
        }
    }
    if (!found) {
        const viaPath = fromPath(name);
        searched.push('PATH');
        if (viaPath) { found = viaPath; source = 'PATH'; }
    }

    const result = { name, path: found, source, searched };
    cache.set(name, result);
    return result;
}

const ffprobe = () => resolveTool('ffprobe');
const ffmpeg = () => resolveTool('ffmpeg');
const whisper = () => resolveTool('whisper-cli');


// ─── Modelos ──────────────────────────────────────────────────────────

// De mejor a peor para esta tarea. `large-v3-turbo` da prácticamente la misma
// calidad que `large-v3` a varias veces la velocidad, y acá se transcriben horas.
const MODEL_PREFERENCE = [
    'ggml-large-v3-turbo.bin',
    'ggml-large-v3.bin',
    'ggml-large-v2.bin',
    'ggml-large.bin',
    'ggml-medium.bin',
    'ggml-small.bin',
    'ggml-base.bin'
];

function modelDirs() {
    return dataDirs('models');
}

function findModel(envVar, matcher, preference) {
    const searched = [];

    const explicit = process.env[envVar];
    if (explicit) {
        searched.push(explicit);
        if (fs.existsSync(explicit)) {
            return { path: explicit, name: path.basename(explicit), source: envVar, searched };
        }
    }

    const found = [];
    for (const dir of modelDirs()) {
        searched.push(dir);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of entries) {
            if (matcher(name)) found.push({ dir, name });
        }
    }
    if (!found.length) return { path: null, name: null, source: 'no encontrado', searched };

    const best = preference
        ? found.sort((a, b) => rank(a.name, preference) - rank(b.name, preference))[0]
        : found[0];
    return {
        path: path.join(best.dir, best.name),
        name: best.name,
        source: best.dir,
        searched
    };
}

function rank(name, preference) {
    const i = preference.indexOf(name);
    return i === -1 ? preference.length : i;
}

function whisperModel() {
    return findModel(
        'CLASSCUT_WHISPER_MODEL',
        n => n.startsWith('ggml-') && n.endsWith('.bin') && !/silero|vad/i.test(n),
        MODEL_PREFERENCE
    );
}

/**
 * Ya no se usa para transcribir: el detector de voz delante de Whisper arruinaba
 * los tiempos de cada palabra (ver `transcribe.js`). Queda resuelto porque el
 * modelo sigue viniendo en las instalaciones viejas y el diagnóstico lo lista si
 * está, pero nada falla si no aparece.
 */
function vadModel() {
    return findModel('CLASSCUT_VAD_MODEL', n => /silero|vad/i.test(n) && n.endsWith('.bin'), null);
}

/**
 * Los modelos chicos, de menor a mayor.
 *
 * Los usa el ciclo de señales de la toma de notas en vivo (`engine/oir.js`), que
 * solo busca tres palabras conocidas y tira el texto: ahí lo que importa es
 * cuánto tarda, no cuánto acierta.
 */
const MODELOS_LIVIANOS = ['ggml-base.bin', 'ggml-small.bin', 'ggml-medium.bin'];

/**
 * Memoizado junto con las herramientas, y no en quien lo pide: el ciclo de
 * señales lo consulta cada tres segundos, y recorrer las carpetas de modelos cada
 * vez es tirar disco. Al vivir en el mismo `cache`, `clearCache` lo suelta con
 * el resto, y Diagnóstico y el ciclo ven siempre lo mismo.
 */
function modeloLiviano() {
    if (!cache.has('modelo-liviano')) {
        cache.set('modelo-liviano', findModel(
            'CLASSCUT_WHISPER_MODELO_LIVIANO',
            n => MODELOS_LIVIANOS.includes(n),
            MODELOS_LIVIANOS
        ));
    }
    return cache.get('modelo-liviano');
}

/**
 * Chequeo de arranque: qué hay y qué falta. Se muestra tal cual en la pantalla de
 * diagnóstico, porque "no se pudo leer el video" sin decir que falta ffprobe manda
 * a buscar la culpa al lugar equivocado.
 */
function doctor() {
    const tools = [
        { key: 'ffprobe', required: true, info: ffprobe() },
        { key: 'ffmpeg', required: true, info: ffmpeg() },
        { key: 'whisper-cli', required: true, info: whisper() },
        { key: 'modelo de Whisper', required: true, info: whisperModel() },
        {
            key: 'modelo liviano (notas en vivo)',
            required: false,
            nota: 'Sin él, la toma de notas en vivo escucha las señales del profesor ' +
                'con el modelo grande: funciona, pero gasta un segundo cada tres en vez ' +
                'de un décimo, durante los cuarenta minutos que dura una clase.',
            info: modeloLiviano()
        }
    ];
    return {
        arch: process.arch,
        appleSilicon: process.arch === 'arm64',
        tools: tools.map(t => ({
            key: t.key,
            required: t.required,
            nota: t.nota || null,
            found: Boolean(t.info.path),
            path: t.info.path,
            name: t.info.name || null,
            source: t.info.source,
            searched: t.info.searched
        })),
        ok: tools.filter(t => t.required).every(t => Boolean(t.info.path))
    };
}

function clearCache() { cache.clear(); }

module.exports = {
    resolveTool, ffprobe, ffmpeg, whisper,
    whisperModel, vadModel, modeloLiviano, modelDirs, MODEL_PREFERENCE,
    // Primitivas que usa quien resuelve otras cosas (ver `ollama-store.js`).
    isExecutable, rank, appRoot, dataDirs, DATA_DIR,
    doctor, clearCache
};
