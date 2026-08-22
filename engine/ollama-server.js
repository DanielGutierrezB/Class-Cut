'use strict';
/**
 * ollama-server.js — El modelo local, sin pedirle nada al editor.
 *
 * La app trae su propio Ollama y su propio modelo, así que la capa de criterio
 * funciona en una Mac recién sacada de la caja. Este módulo lo levanta cuando
 * hace falta y lo baja al cerrar.
 *
 * Corre SIEMPRE en un puerto propio, nunca en el 11434. Si el editor ya usa
 * Ollama para otra cosa, ese proceso es suyo: no se le reinicia, no se le
 * cambian variables y no se compite por el puerto. La única cosa que sí se mira
 * de su instalación son los modelos, porque si ya tiene uno más grande
 * descargado es mejor usar ese que el que traemos —y son gigabytes que ya pagó.
 *
 * El servidor se levanta tarde, recién cuando se va a procesar algo: un modelo
 * cargado ocupa memoria, y abrir la app para mirar una clase no tiene por qué
 * costar eso.
 */

const { spawn } = require('child_process');
const net = require('net');
const paths = require('./paths');
const ai = require('./ai-local');

// De mejor a peor para esta tarea. Medido con tools/bench-models.js sobre el
// curso real: para elegir puntos de corte el modelo grande no acierta más que el
// chico —coinciden en el 95% de los bordes y donde difieren se reparten los
// aciertos—, pero en la revisión de sentido de la clase entera el grande
// encuentra cosas que el chico deja pasar. Por eso, si ya está descargado, se
// prefiere; y si no, el chico hace el trabajo.
const PREFERENCE = [
    'qwen3.8:27b',
    'gemma4:31b',
    'qwen3:32b',
    'qwen3:14b',
    'qwen3:8b',
    'qwen3:4b'
];

const BUNDLED = 'qwen3:4b';
const FIRST_PORT = 11466;

let server = null;
let ready = null;

function inUse(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        const done = result => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(400);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
    });
}

async function freePort() {
    for (let port = FIRST_PORT; port < FIRST_PORT + 20; port++) {
        if (!(await inUse(port))) return port;
    }
    return FIRST_PORT;
}

/**
 * Qué almacén de modelos usar y con qué modelo.
 *
 * Un almacén, no dos: Ollama lee de un solo directorio, así que se elige el que
 * tenga el mejor modelo disponible en vez de intentar mezclarlos.
 */
function chooseStore() {
    const bundled = paths.ollamaModels();
    const user = paths.userOllamaModels();

    const options = [];
    if (user) options.push({ store: user, models: paths.modelsIn(user), own: false });
    if (bundled.path) options.push({ store: bundled.path, models: paths.modelsIn(bundled.path), own: true });

    let best = null;
    for (const option of options) {
        for (const name of option.models) {
            const rank = PREFERENCE.indexOf(name);
            if (rank === -1) continue;
            if (!best || rank < best.rank) {
                best = { rank, model: name, store: option.store, own: option.own };
            }
        }
    }
    if (best) return best;

    // Ningún modelo conocido: si el editor tiene alguno suyo se usa igual, que es
    // mejor que apagar el criterio por no reconocer el nombre.
    if (user) {
        const any = paths.modelsIn(user)[0];
        if (any) return { model: any, store: user, own: false, rank: PREFERENCE.length };
    }
    return null;
}

async function waitUntilUp(url, signal) {
    for (let i = 0; i < 60; i++) {
        if (signal && signal.aborted) return false;
        try {
            const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) return true;
        } catch (e) { /* todavía no */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

/**
 * Deja el modelo listo para responder.
 * @returns {Promise<{ok:boolean, url?:string, model?:string, source?:string, reason:string}>}
 */
async function ensure(options) {
    if (ready) return ready;
    ready = start(options).catch(err => {
        ready = null;
        return { ok: false, reason: `No se pudo levantar el modelo local: ${err.message}` };
    });
    return ready;
}

async function start(options) {
    const binary = paths.ollama();
    if (!binary.path) {
        return { ok: false, reason: 'No está el motor del modelo local (ollama).' };
    }

    const choice = chooseStore();
    if (!choice) {
        return { ok: false, reason: 'No hay ningún modelo local descargado.' };
    }

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    server = spawn(binary.path, ['serve'], {
        env: {
            ...process.env,
            OLLAMA_HOST: `127.0.0.1:${port}`,
            OLLAMA_MODELS: choice.store,
            // Sin esto Ollama descarga el modelo de memoria a los 5 minutos y la
            // clase siguiente vuelve a pagar la carga entera.
            OLLAMA_KEEP_ALIVE: '30m',
            OLLAMA_NO_CLOUD: '1'
        },
        stdio: 'ignore',
        detached: false
    });
    server.on('exit', () => { server = null; ready = null; });
    server.on('error', () => { server = null; ready = null; });

    // Un hijo vivo mantiene despierto a Node aunque ya no quede trabajo: sin esto
    // las herramientas de línea de comandos terminan la clase y se quedan
    // colgadas para siempre. `unref` lo saca de esa cuenta, y el gancho de salida
    // se encarga de que no quede un servidor huérfano comiendo memoria.
    server.unref();
    hookExit();

    const up = await waitUntilUp(url, options && options.signal);
    if (!up) {
        stop();
        return { ok: false, reason: 'El modelo local no respondió al arrancar.' };
    }

    ai.configure({ url, model: choice.model });
    return {
        ok: true,
        url,
        model: choice.model,
        port,
        source: choice.own ? 'incluido en la app' : 'ya estaba en esta Mac',
        reason: choice.own
            ? `Modelo ${choice.model}, el que viene con la app.`
            : `Modelo ${choice.model}, que ya estaba en esta Mac.`
    };
}

function stop() {
    if (server) {
        try { server.kill('SIGTERM'); } catch (e) { /* ya no estaba */ }
        server = null;
    }
    ready = null;
}

// Se registra una sola vez y recién cuando hay algo que bajar, para no dejar
// oyentes puestos en un proceso que nunca levantó el modelo.
let hooked = false;
function hookExit() {
    if (hooked) return;
    hooked = true;
    process.on('exit', stop);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            stop();
            process.exit(0);
        });
    }
}

/** Lo que se muestra en Diagnóstico, sin levantar nada. */
function status() {
    const binary = paths.ollama();
    const choice = chooseStore();
    return {
        binary: binary.path,
        binarySource: binary.source,
        model: choice ? choice.model : null,
        modelSource: choice ? (choice.own ? 'incluido en la app' : 'ya estaba en esta Mac') : null,
        running: Boolean(server),
        ok: Boolean(binary.path && choice)
    };
}

module.exports = { ensure, stop, status, chooseStore, PREFERENCE, BUNDLED, FIRST_PORT };
