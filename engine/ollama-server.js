'use strict';
/**
 * ollama-server.js — El modelo local, sin pedirle nada al editor.
 *
 * La app trae su propio Ollama y su propio modelo, así que la capa de criterio
 * funciona en una Mac recién sacada de la caja. Este módulo lo levanta cuando
 * hace falta y devuelve un cliente para hablarle.
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
const store = require('./ollama-store');
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

/** El que empaqueta `tools/bundle-ollama.sh`. */
const BUNDLED = 'qwen3:4b';

let server = null;
let lastError = '';

/**
 * Qué almacén usar y con qué modelo.
 *
 * Un almacén, no dos: Ollama lee de un solo directorio, así que se elige el que
 * tenga el mejor modelo en vez de intentar mezclarlos. Un nombre que no está en
 * la lista vale igual y va último —es mejor usar un modelo desconocido que
 * apagar el criterio por no reconocerlo—, y eso vale para los DOS almacenes: si
 * el empaquetado cambia de modelo, el que traemos no puede quedar muerto.
 *
 * @returns {{model:string, store:string, own:boolean}|null}
 */
function elegirModelo(almacenes) {
    const opciones = (almacenes || store.stores()).flatMap(a =>
        store.modelsIn(a.store).map(model => ({
            model, store: a.store, own: a.own, rank: paths.rank(model, PREFERENCE)
        })));

    // `sort` es estable, así que a igual rango gana el primero de la lista, que
    // es el almacén del editor.
    return opciones.sort((a, b) => a.rank - b.rank)[0] || null;
}

/**
 * Un puerto libre, preguntándoselo al sistema.
 *
 * Se le pide uno en vez de probar veinte a mano: `port 0` devuelve uno libre y
 * se suelta enseguida para dárselo a Ollama. Queda una rendija entre soltar y
 * arrancar, pero es mucho más chica que la de adivinar —y no hay número mágico
 * que algún día choque con el 11434 del editor.
 */
async function puertoLibre() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function esperarQueLevante(url, signal) {
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
 * Deja el modelo listo y devuelve con qué hablarle.
 *
 * No falla nunca: si no hay modelo devuelve `cliente: null` y el motivo, y quien
 * llama corta con las reglas solas.
 *
 * @returns {Promise<{cliente:object|null, model?:string, source?:string, reason:string}>}
 */
async function ensure(options) {
    if (server && server.resultado) return server.resultado;

    const binary = store.binary();
    if (!binary.path) {
        return { cliente: null, reason: 'No está el motor del modelo local (ollama).' };
    }

    const choice = elegirModelo();
    if (!choice) {
        return { cliente: null, reason: 'No hay ningún modelo local descargado.' };
    }

    let port;
    try {
        port = await puertoLibre();
    } catch (err) {
        return { cliente: null, reason: `No se pudo abrir un puerto para el modelo: ${err.message}` };
    }
    const url = `http://127.0.0.1:${port}`;

    const child = spawn(binary.path, ['serve'], {
        env: {
            ...process.env,
            OLLAMA_HOST: `127.0.0.1:${port}`,
            OLLAMA_MODELS: choice.store,
            // Sin esto Ollama descarga el modelo de memoria a los 5 minutos y la
            // clase siguiente vuelve a pagar la carga entera.
            OLLAMA_KEEP_ALIVE: '30m',
            OLLAMA_NO_CLOUD: '1'
        },
        stdio: ['ignore', 'ignore', 'pipe']
    });

    // Se guardan las últimas líneas de error: sin esto, "no respondió al
    // arrancar" es todo lo que el editor llega a saber, y no alcanza para nada.
    lastError = '';
    child.stderr.on('data', chunk => {
        lastError = (lastError + chunk.toString()).split('\n').slice(-6).join('\n');
    });
    // La tubería es un socket más, y un socket abierto cuenta como trabajo
    // pendiente: sin esto el proceso se queda esperando por un caño del que solo
    // salen mensajes de log.
    child.stderr.unref();
    child.on('exit', () => { server = null; });
    child.on('error', () => { server = null; });

    // Un hijo vivo mantiene despierto a Node aunque ya no quede trabajo: sin esto
    // las herramientas de línea de comandos terminan la clase y se quedan
    // colgadas para siempre. `unref` lo saca de esa cuenta; bajarlo al salir es
    // responsabilidad de quien lo levantó (ver `stop`).
    child.unref();
    server = { child, resultado: null };
    engancharSalida();

    if (!(await esperarQueLevante(url, options && options.signal))) {
        stop();
        const detalle = lastError.trim().split('\n').pop() || '';
        return {
            cliente: null,
            reason: `El modelo local no respondió al arrancar.${detalle ? ` ${detalle}` : ''}`
        };
    }

    server.resultado = {
        cliente: ai.cliente({ url, model: choice.model }),
        model: choice.model,
        source: choice.own ? 'incluido en la app' : 'ya estaba en esta Mac',
        reason: choice.own
            ? `Modelo ${choice.model}, el que viene con la app.`
            : `Modelo ${choice.model}, que ya estaba en esta Mac.`
    };
    return server.resultado;
}

function stop() {
    if (server) {
        try { server.child.kill('SIGTERM'); } catch (e) { /* ya no estaba */ }
        server = null;
    }
}

// Solo `exit`, y nada de señales: un módulo de librería que atiende SIGINT y
// llama a `process.exit` le cambia el apagado a toda la app —se saltea el
// `before-quit` de Electron y puede cortar una exportación por la mitad—. Quién
// atiende ctrl-C es decisión del programa, no de esto.
let enganchado = false;
function engancharSalida() {
    if (enganchado) return;
    enganchado = true;
    process.on('exit', stop);
}

/**
 * Lo que se muestra en Diagnóstico, sin levantar nada.
 *
 * Tres estados y no dos: "listo pero apagado" no es lo mismo que "no está", y el
 * editor necesita distinguirlos para saber si tiene algo que hacer.
 *
 * @returns {{estado:'corriendo'|'listo'|'falta', model:string|null, source:string|null, reason:string}}
 */
function estado() {
    if (server && server.resultado) {
        const { model, source, reason } = server.resultado;
        return { estado: 'corriendo', model, source, reason };
    }

    const binary = store.binary();
    if (!binary.path) {
        return { estado: 'falta', model: null, source: null, reason: 'No está el motor del modelo local (ollama).' };
    }
    const choice = elegirModelo();
    if (!choice) {
        return { estado: 'falta', model: null, source: null, reason: 'No hay ningún modelo local descargado.' };
    }
    const source = choice.own ? 'incluido en la app' : 'ya estaba en esta Mac';
    return {
        estado: 'listo',
        model: choice.model,
        source,
        reason: `${choice.model} (${source}). Arranca al procesar.`
    };
}

module.exports = { ensure, stop, estado, elegirModelo, PREFERENCE, BUNDLED };
