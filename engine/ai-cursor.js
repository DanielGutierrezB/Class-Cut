'use strict';
/**
 * ai-cursor.js — El criterio por el Cursor CLI, con el modelo que el editor
 * tenga contratado ahí.
 *
 * Es el mismo contrato que el modelo local (`ask` → JSON chico que quien llama
 * valida), con otra maquinaria detrás: se lanza `cursor-agent` en modo
 * impresión, de solo lectura, en un directorio de trabajo propio y vacío. El
 * CLI ya viene autenticado por el editor; acá no se guardan claves.
 *
 * Cada consulta es un proceso. Cuesta un segundo y pico de arranque, y a cambio
 * no hay sesión que se pueda quedar colgada entre clases ni estado compartido
 * entre consultas — exactamente como el resto del motor, donde cada pregunta
 * viaja completa.
 *
 * Determinismo: no hay semilla que fijar acá. Con el modelo local, reprocesar
 * da el corte idéntico; con un proveedor remoto da un corte equivalente pero no
 * bit a bit. Es el precio de un modelo más capaz, y se elige en Ajustes.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ai = require('./ai-local');
const tokens = require('./tokens');

const DEFAULTS = {
    // Los modelos con razonamiento tardan más que Ollama en el peor caso, y un
    // timeout corto convertiría una consulta lenta en un corte sin criterio.
    timeoutMs: 180000
};

/** Dónde puede estar el CLI cuando la app se abre desde el Finder, sin PATH. */
const CANDIDATOS = [
    path.join(os.homedir(), '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent'
];

function binario() {
    for (const candidato of CANDIDATOS) {
        try {
            fs.accessSync(candidato, fs.constants.X_OK);
            return candidato;
        } catch (err) { /* siguiente */ }
    }
    try {
        const { execFileSync } = require('child_process');
        const hallado = execFileSync('/usr/bin/which', ['cursor-agent'], { encoding: 'utf8' }).trim();
        if (hallado) return hallado;
    } catch (err) { /* no está */ }
    return null;
}

/**
 * El directorio de trabajo del CLI: propio, vacío y confiado.
 *
 * Importa que NO sea la carpeta del curso ni la de la app: el modo impresión
 * puede leer el directorio en el que corre, y el criterio no necesita ver
 * ningún archivo — todo lo que le hace falta viaja en el prompt.
 */
function directorioDeTrabajo() {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Class Cut', 'cli');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** El PATH con los lugares donde suele vivir el CLI, para sus subprocesos. */
function entorno() {
    const extra = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
    return { ...process.env, PATH: `${extra.join(':')}:${process.env.PATH || ''}` };
}

/**
 * El uso de una respuesta del CLI, traducido a la forma de `engine/tokens.js`.
 *
 * Medido contra `cursor-agent 2026.08.11`: el sobre trae
 * `usage:{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, y en
 * modo impresión casi todo el prompt cae en `cacheWriteTokens` —una consulta
 * trivial dio `inputTokens: 2` y `cacheWriteTokens: 31354`—. Por eso las cuatro
 * cubetas viajan enteras y sumarlas es cosa de `tokens.totales`.
 *
 * Devuelve null si el sobre no trae `usage`: una versión del CLI que deje de
 * informarlo tiene que verse como "no informa", no como "gastó cero".
 */
function usoDelSobre(sobre) {
    const uso = sobre && sobre.usage;
    if (!uso || typeof uso !== 'object') return null;
    return {
        entrada: uso.inputTokens,
        salida: uso.outputTokens,
        cacheLectura: uso.cacheReadTokens,
        cacheEscritura: uso.cacheWriteTokens
    };
}

/**
 * El sobre del CLI, abierto: la respuesta del modelo y lo que costó.
 *
 * Si lo que salió no es un sobre se intenta leerlo como la respuesta pelada,
 * que es lo que devolvía `--output-format text`. No es paranoia gratuita: es la
 * forma de que una versión del CLI que cambie el sobre siga cortando bien, solo
 * que sin poder decir los tokens.
 *
 * @returns {[object, object|null]} lo que espera `cerrar`
 */
function desenvolver(salida) {
    const sobre = ai.parseJson(salida);
    if (!sobre) return [{ error: `el modelo no contestó JSON: ${String(salida).trim().slice(0, 160)}` }, null];

    if (typeof sobre.result !== 'string') {
        // No es un sobre: es la respuesta del modelo tal cual.
        return [sobre, null];
    }
    if (sobre.is_error) {
        return [{ error: `el Cursor CLI falló: ${String(sobre.result).slice(0, 160)}` }, null];
    }

    const parsed = ai.parseJson(sobre.result);
    if (!parsed) return [{ error: `el modelo no contestó JSON: ${sobre.result.trim().slice(0, 160)}` }, usoDelSobre(sobre)];
    // El uso viaja aunque la respuesta no sirva: los tokens se gastaron igual.
    return [parsed, usoDelSobre(sobre)];
}

/**
 * Una pregunta, una respuesta en JSON. Nunca lanza: contesta `{respuesta:{error}}`.
 *
 * @param {object} config { bin, model, system, prompt, signal, timeoutMs }
 * @returns {Promise<{respuesta: object, uso: object|null}>}
 */
function preguntar(config) {
    return new Promise(resolve => {
        // El CLI recibe UN prompt: el sistema va delante, separado, como lo
        // pegan los propios chats.
        const texto = [config.system, config.prompt].filter(Boolean).join('\n\n');
        const args = [
            '-p', '--trust',
            // `json` y no `text` por los tokens: con `text` el CLI escupe la
            // respuesta pelada y no hay forma de saber qué costó. Con `json`
            // viene envuelta en un sobre que trae `usage`, y eso es lo único que
            // permite mostrar el gasto en vez de inventarlo. La respuesta del
            // modelo es el campo `result` del sobre, así que se desenvuelve acá
            // y el resto del motor sigue recibiendo lo mismo de antes.
            '--output-format', 'json',
            // Solo lectura: el criterio contesta números, no toca archivos.
            '--mode', 'ask',
            '--model', config.model,
            texto
        ];

        const child = spawn(config.bin, args, {
            cwd: directorioDeTrabajo(),
            env: entorno(),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let out = '';
        let err = '';
        let terminado = false;

        const cerrar = (respuesta, uso) => {
            if (terminado) return;
            terminado = true;
            clearTimeout(timer);
            if (config.signal) config.signal.removeEventListener('abort', abortar);
            resolve({ respuesta, uso: uso || null });
        };

        const matar = () => { try { child.kill('SIGKILL'); } catch (e) { /* ya murió */ } };
        const abortar = () => { matar(); cerrar({ error: 'cancelado' }); };

        const timer = setTimeout(() => {
            matar();
            cerrar({ error: `el Cursor CLI no contestó en ${Math.round(config.timeoutMs / 1000)} s` });
        }, config.timeoutMs);

        if (config.signal) {
            if (config.signal.aborted) { abortar(); return; }
            config.signal.addEventListener('abort', abortar, { once: true });
        }

        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('error', e => cerrar({ error: `no se pudo lanzar el Cursor CLI: ${e.message}` }));
        // Sobre `exit` y no sobre `close`: el CLI deja detrás un `worker-server`
        // que hereda la tubería de salida, así que `close` no llega nunca aunque
        // el proceso ya haya terminado — cada consulta se colgaba los tres
        // minutos del timeout. Con `exit`, un respiro corto deja entrar lo que
        // quede en la tubería (la respuesta son unas decenas de bytes).
        child.on('exit', code => {
            setTimeout(() => {
                if (code !== 0) {
                    // El sobre JSON solo aparece cuando el CLI termina bien.
                    // Cuando falla escribe una línea suelta ("ActionRequiredError:
                    // Request blocked…"), así que acá no hay nada que parsear.
                    const detalle = (err || out).trim().split('\n').slice(-3).join(' ');
                    cerrar({ error: `el Cursor CLI salió con ${code}. ${detalle}`.trim() });
                    return;
                }
                cerrar(...desenvolver(out));
            }, 150);
        });
    });
}

/**
 * Un cliente atado a UN modelo, con el mismo contrato que el local.
 *
 * `contextoGrande` es la diferencia que el resto del motor mira: estos modelos
 * traen ventana de un millón de tokens, así que la clase entera les entra de
 * fondo al decidir un corte — cosa que con el modelo local se midió y no
 * conviene (ver README).
 */
function cliente(config) {
    const bin = (config && config.bin) || binario();
    const model = config.model;
    // Vive en el cliente y no en un global: la corrida arma UN cliente y le
    // pregunta desde varias etapas, así que este contador es exactamente "lo
    // que gastó esta corrida". Con un global, dos mediciones en paralelo
    // (`tools/bench-models.js`) se sumarían entre ellas.
    const uso = tokens.contador();

    return {
        model,
        proveedor: 'cursor',
        contextoGrande: true,
        // Cada consulta es un proceso y un viaje de red: tres a la vez van bien.
        // Más es invitar al límite de uso — midiendo el curso entero ya se vio
        // al CLI empezar a fallar tras cuarenta minutos de consultas seguidas.
        paralelo: 3,
        uso,
        ask: async params => {
            if (!bin) return { error: 'No está el Cursor CLI en esta Mac.' };
            const pedido = {
                bin, model,
                system: params.system,
                prompt: params.prompt,
                signal: params.signal,
                timeoutMs: (config && config.timeoutMs) || DEFAULTS.timeoutMs
            };
            const primera = await preguntar(pedido);
            tokens.sumar(uso, primera.uso);
            // Un reintento, y solo uno. Midiendo el curso entero, tras cuarenta
            // minutos de consultas el CLI empezó a fallar suelto y una clase
            // salió "limpia" porque su lectura entera se cayó. Una falla suelta
            // se reintenta; dos seguidas son un problema de verdad y se informa.
            // Lo cancelado no: cancelar es una orden, no una falla.
            if (!primera.respuesta.error || primera.respuesta.error === 'cancelado') return primera.respuesta;
            if (params.signal && params.signal.aborted) return primera.respuesta;

            const segunda = await preguntar(pedido);
            tokens.sumar(uso, segunda.uso);
            return segunda.respuesta;
        }
    };
}

/** Las líneas de `--list-models`, hechas lista. Aparte para poder probarlo. */
function parsearLista(stdout) {
    return String(stdout || '').split('\n')
        .map(line => {
            const m = line.match(/^([a-z0-9][\w.[\]=,-]*)\s+-\s+(.+)$/i);
            return m ? { id: m[1], nombre: m[2].trim() } : null;
        })
        .filter(Boolean);
}

/** Los modelos que el CLI ofrece, para la página de Ajustes. */
function modelos() {
    return new Promise(resolve => {
        const bin = binario();
        if (!bin) { resolve({ ok: false, reason: 'No está el Cursor CLI en esta Mac.', modelos: [] }); return; }
        execFile(bin, ['--list-models'], { env: entorno(), timeout: 15000 }, (err, stdout) => {
            if (err) { resolve({ ok: false, reason: `El CLI no pudo listar modelos: ${err.message}`, modelos: [] }); return; }
            const lista = parsearLista(stdout);
            resolve({ ok: lista.length > 0, reason: lista.length ? '' : 'El CLI no devolvió modelos.', modelos: lista });
        });
    });
}

/** ¿Está el CLI y contesta con este modelo? Para el botón Probar. */
async function probar(config) {
    const bin = binario();
    if (!bin) return { ok: false, reason: 'No está el Cursor CLI en esta Mac. Instalalo con: curl https://cursor.com/install -fsS | bash' };
    const desde = Date.now();
    const { respuesta, uso } = await preguntar({
        bin,
        model: config.model,
        system: 'Contestás SOLO JSON válido.',
        prompt: 'Contestá exactamente: {"ok": true}',
        timeoutMs: 60000
    });
    if (respuesta.error) return { ok: false, reason: respuesta.error };

    const ms = Date.now() - desde;
    // El botón Probar es donde se ve, sin procesar nada, si este CLI informa
    // tokens: si no lo dijera acá habría que arrancar una corrida para
    // enterarse.
    const gasto = uso ? tokens.totales(tokens.sumar(tokens.contador(), uso)) : null;
    return {
        ok: true,
        ms,
        tokens: gasto,
        reason: `Contestó en ${(ms / 1000).toFixed(1)} s.` +
            (gasto ? ` Informa tokens (${gasto.total} en esta consulta).` : ' Este CLI no informa tokens.')
    };
}

module.exports = { cliente, modelos, probar, binario, parsearLista, desenvolver, usoDelSobre, DEFAULTS };
