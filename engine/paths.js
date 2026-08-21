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

/**
 * Chequeo de arranque: qué hay y qué falta. Se muestra tal cual en la pantalla de
 * diagnóstico, porque "no se pudo leer el video" sin decir que falta ffprobe manda
 * a buscar la culpa al lugar equivocado.
 */
function doctor() {
    const tools = [
        { key: 'ffprobe', required: true, info: ffprobe() },
        { key: 'ffmpeg', required: true, info: ffmpeg() },
        { key: 'whisper-cli', required: false, info: whisper() }
    ];
    return {
        arch: process.arch,
        appleSilicon: process.arch === 'arm64',
        tools: tools.map(t => ({
            key: t.key,
            required: t.required,
            found: Boolean(t.info.path),
            path: t.info.path,
            source: t.info.source,
            searched: t.info.searched
        })),
        ok: tools.filter(t => t.required).every(t => Boolean(t.info.path))
    };
}

function clearCache() { cache.clear(); }

module.exports = { resolveTool, ffprobe, ffmpeg, whisper, doctor, clearCache, appRoot };
