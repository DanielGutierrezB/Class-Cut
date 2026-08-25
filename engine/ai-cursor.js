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
 * Una pregunta, una respuesta en JSON. Nunca lanza: contesta `{error}`.
 *
 * @param {object} config { bin, model, system, prompt, signal, timeoutMs }
 */
function preguntar(config) {
    return new Promise(resolve => {
        // El CLI recibe UN prompt: el sistema va delante, separado, como lo
        // pegan los propios chats.
        const texto = [config.system, config.prompt].filter(Boolean).join('\n\n');
        const args = [
            '-p', '--trust',
            '--output-format', 'text',
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

        const cerrar = respuesta => {
            if (terminado) return;
            terminado = true;
            clearTimeout(timer);
            if (config.signal) config.signal.removeEventListener('abort', abortar);
            resolve(respuesta);
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
                    const detalle = (err || out).trim().split('\n').slice(-3).join(' ');
                    cerrar({ error: `el Cursor CLI salió con ${code}. ${detalle}`.trim() });
                    return;
                }
                const parsed = ai.parseJson(out);
                if (!parsed) {
                    cerrar({ error: `el modelo no contestó JSON: ${String(out).trim().slice(0, 160)}` });
                    return;
                }
                cerrar(parsed);
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
    return {
        model,
        proveedor: 'cursor',
        contextoGrande: true,
        // Cada consulta es un proceso y un viaje de red: tres a la vez van bien.
        // Más es invitar al límite de uso — midiendo el curso entero ya se vio
        // al CLI empezar a fallar tras cuarenta minutos de consultas seguidas.
        paralelo: 3,
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
            // Un reintento, y solo uno. Midiendo el curso entero, tras cuarenta
            // minutos de consultas el CLI empezó a fallar suelto y una clase
            // salió "limpia" porque su lectura entera se cayó. Una falla suelta
            // se reintenta; dos seguidas son un problema de verdad y se informa.
            // Lo cancelado no: cancelar es una orden, no una falla.
            if (!primera.error || primera.error === 'cancelado') return primera;
            if (params.signal && params.signal.aborted) return primera;
            return preguntar(pedido);
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
    const res = await preguntar({
        bin,
        model: config.model,
        system: 'Contestás SOLO JSON válido.',
        prompt: 'Contestá exactamente: {"ok": true}',
        timeoutMs: 60000
    });
    if (res.error) return { ok: false, reason: res.error };
    return { ok: true, ms: Date.now() - desde, reason: `Contestó en ${((Date.now() - desde) / 1000).toFixed(1)} s.` };
}

module.exports = { cliente, modelos, probar, binario, parsearLista, DEFAULTS };
