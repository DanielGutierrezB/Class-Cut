'use strict';
/**
 * ollama-store.js — Dónde está Ollama y qué modelos hay descargados.
 *
 * Esto no es resolver rutas de herramientas —para eso está `paths.js`— sino leer
 * el formato en el que Ollama guarda sus cosas en el disco: un árbol de
 * manifiestos (`manifests/registry.ollama.ai/library/<nombre>/<tag>`) y una
 * bolsa de blobs por hash. Es el formato de un proveedor concreto y cambia
 * cuando ellos quieran, así que vive en un solo archivo y se prueba solo.
 *
 * Hay dos almacenes posibles y nunca se mezclan: el que trae la app y el que ya
 * tenga el editor en su carpeta personal. Ollama lee de un directorio por vez.
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// Ollama viene en su propia carpeta y no en `bin/`, porque el servidor busca a
// `llama-server` como hermano suyo y no en el PATH: separarlos lo deja corriendo
// en CPU sin avisar.
function binDirs() {
    const dirs = [];
    if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin', 'ollama'));
    dirs.push(path.join(paths.appRoot(), 'bin', 'mac', 'ollama'));
    return dirs;
}

/** El ejecutable de Ollama: el de la app primero, el del sistema como respaldo. */
function binary() {
    const searched = [];
    for (const dir of binDirs()) {
        const candidate = path.join(dir, 'ollama');
        searched.push(candidate);
        // Sin `llama-server` al lado, el servidor levanta igual pero se cae al
        // primer pedido: no alcanza con que exista el binario principal.
        if (paths.isExecutable(candidate) && paths.isExecutable(path.join(dir, 'llama-server'))) {
            return { path: candidate, dir, source: 'incluido en la app', searched };
        }
    }
    const system = paths.resolveTool('ollama');
    return system.path
        ? { path: system.path, dir: path.dirname(system.path), source: system.source, searched: [...searched, ...system.searched] }
        : { path: null, dir: null, source: 'no encontrado', searched: [...searched, ...system.searched] };
}

/**
 * El almacén de modelos que instaló el instalador.
 *
 * Vive fuera del `.app` (ver `paths.dataDirs`): son 2.3 GB que no cambian entre
 * versiones y meterlos adentro haría que cada actualización los volviera a bajar.
 */
function bundled() {
    return paths.dataDirs('ollama-models')
        .find(dir => fs.existsSync(path.join(dir, 'manifests'))) || null;
}

/** El almacén del editor, que puede tener modelos mejores que el que traemos. */
function user() {
    const dir = process.env.OLLAMA_MODELS
        || path.join(process.env.HOME || '', '.ollama', 'models');
    return fs.existsSync(path.join(dir, 'manifests')) ? dir : null;
}

/** Qué modelos hay en un almacén, leyendo los manifiestos. */
function modelsIn(store) {
    const base = path.join(store || '', 'manifests', 'registry.ollama.ai', 'library');
    const names = [];
    let libs = [];
    try { libs = fs.readdirSync(base); } catch (e) { return names; }
    for (const name of libs) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(base, name)); } catch (e) { continue; }
        for (const tag of tags) names.push(`${name}:${tag}`);
    }
    return names;
}

/** Los almacenes que hay, en orden de preferencia a igualdad de modelo. */
function stores() {
    const list = [];
    // El del editor primero: si tiene el mismo modelo, son gigabytes que ya pagó.
    const mine = user();
    if (mine) list.push({ store: mine, own: false });
    const ours = bundled();
    if (ours) list.push({ store: ours, own: true });
    return list;
}

module.exports = { binary, bundled, user, modelsIn, stores };
