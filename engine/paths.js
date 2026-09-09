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

/**
 * Un nombre de archivo que es un modelo de transcripción y no otra cosa.
 *
 * Se pregunta desde dos sitios —cuál es el modelo grande y qué hay instalado
 * (`modelosInstalados`)— y tiene que ser la misma pregunta: con dos redacciones,
 * el escalón de abajo podría ofrecer el VAD como si fuera un modelo con el que
 * transcribir.
 */
function esModeloDeWhisper(nombre) {
    return nombre.startsWith('ggml-') && nombre.endsWith('.bin') && !/silero|vad/i.test(nombre);
}

function whisperModel() {
    return findModel('CLASSCUT_WHISPER_MODEL', esModeloDeWhisper, MODEL_PREFERENCE);
}

/**
 * Todos los modelos que hay en esta máquina, con lo que pesa cada uno.
 *
 * **El peso es el dato, y no el orden de `MODEL_PREFERENCE`.** Esa lista está
 * ordenada de mejor a peor PARA TRANSCRIBIR, y para eso está bien; pero cuando
 * el sistema se lleva por delante a whisper-cli lo que hay que bajar es la
 * memoria, y las dos cosas no van en el mismo sentido. En esta Mac se ve en el
 * primer renglón: `large-v3-turbo` encabeza la preferencia y pesa 1,5 GB,
 * mientras que el que le sigue en la lista, `large-v3`, pesa 2,9 GB. Bajar por
 * la lista sería pedirle a una máquina que acaba de quedarse sin memoria que
 * cargue el doble.
 *
 * El tamaño del archivo es la medida honesta que se tiene sin correr nada: un
 * `.bin` de ggml es casi todo pesos, y whisper.cpp los mapea a memoria tal cual.
 * `statSync` sigue los enlaces simbólicos, que es lo que hace falta: en esta Mac
 * `ggml-large-v3.bin` es un enlace a la carpeta de otra app.
 *
 * Memoizado con las herramientas, y por lo mismo: lo consulta la política de
 * reintento en medio de una grabación, y `clearCache` lo suelta con el resto.
 */
function modelosInstalados() {
    if (cache.has('modelos-instalados')) return cache.get('modelos-instalados');

    const vistos = new Map();
    for (const dir of modelDirs()) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        for (const nombre of entries) {
            // El primero gana: `modelDirs` va de la carpeta del instalador a la
            // del repo, que es el mismo orden con el que `findModel` elige.
            if (!esModeloDeWhisper(nombre) || vistos.has(nombre)) continue;
            const suyo = path.join(dir, nombre);
            let bytes = 0;
            try { bytes = fs.statSync(suyo).size; } catch (e) { continue; }
            vistos.set(nombre, { name: nombre, path: suyo, bytes });
        }
    }

    const lista = [...vistos.values()].sort((a, b) => b.bytes - a.bytes);
    cache.set('modelos-instalados', lista);
    return lista;
}

/**
 * El escalón de abajo: el más pesado de los que pesan menos que este.
 *
 * **Un escalón y no el sótano.** Si hay `medium` y `base` instalados y el grande
 * se murió, se prueba con `medium`: es el que más se parece al texto que se
 * quería, y bajar hasta el más chico de una sola vez sería pagar de entrada toda
 * la pérdida de calidad para resolver un problema que puede ceder con la mitad.
 * Si `medium` también se muere, la política vuelve a preguntar y ahí sí aparece
 * `base` — un escalón por muerte, que es un intento por hipótesis.
 *
 * Puro y con la lista por parámetro para poder probarlo sin depender de qué haya
 * instalado en la máquina donde corran las pruebas.
 *
 * @param {{name:string, bytes:number}|null} suyo el modelo del que se baja
 * @param {Array} instalados los de `modelosInstalados`
 */
function elDeAbajo(suyo, instalados) {
    if (!suyo || suyo.bytes == null) return null;
    return (instalados || [])
        .filter(m => m.bytes < suyo.bytes)
        .sort((a, b) => b.bytes - a.bytes)[0] || null;
}

/**
 * En esta Mac, hoy, el escalón del turbo de 1,5 GB es `ggml-small.bin` (488 MB),
 * y de él ya no se baja a ninguna parte. Estuvo en null un tiempo —no había
 * ningún modelo instalado más liviano que el grande— y por eso la rama de bajar
 * se probó entera contra un whisper-cli de mentira. Ejercitada contra los ggml de
 * verdad está en `tools/sonda-escalon.js`, que mata las pasadas del grande con el
 * binario de la app y mira que el chico levante y escriba.
 *
 * @param {{name:string, path:string}|string} modelo el que se está usando
 * @returns {{name:string, path:string, bytes:number}|null} null si no hay ninguno
 *   más liviano, que sigue siendo un resultado y tiene que poder decirse
 */
function escalonDebajo(modelo) {
    const pedido = typeof modelo === 'string' ? { name: modelo } : (modelo || {});
    const instalados = modelosInstalados();
    // Un modelo puede venir de `CLASSCUT_WHISPER_MODEL` y no estar en ninguna de
    // las carpetas que se recorren: entonces se lo pesa por su ruta.
    const suyo = instalados.find(m => m.name === pedido.name) || conPeso(pedido);
    return elDeAbajo(suyo, instalados);
}

function conPeso(modelo) {
    if (!modelo || !modelo.path) return null;
    try {
        return { ...modelo, bytes: fs.statSync(modelo.path).size };
    } catch (e) {
        return null;
    }
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
 *
 * **En esta Mac el liviano y el escalón de abajo son el mismo archivo**, y no es
 * casualidad ni desprolijidad: las dos preguntas son la misma —cuál es el modelo
 * más chico que igual sirve— vistas desde el tiempo y desde la memoria. Que
 * coincidan sale gratis dos veces. Una, medida con nuestro binario sobre 4 s de
 * la clase 02: el ciclo pasa de 815 ms por pasada con el turbo a 317 ms con
 * `small`, o sea de ocupar un cuarto de cada ciclo a ocupar un noveno. Y la otra,
 * que es la que importa el día que el sistema se lleve al grande: el escalón al
 * que se baja es un archivo que el ciclo de señales ya viene mapeando cada tres
 * segundos, así que sus páginas están calientes y bajar no cuesta leer 488 MB de
 * disco con la máquina justo en el peor momento.
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

/** El escalón de abajo del modelo grande, con la forma que Diagnóstico dibuja. */
function escalonDelGrande() {
    const grande = whisperModel();
    const abajo = grande.name ? escalonDebajo(grande) : null;
    return {
        path: abajo ? abajo.path : null,
        name: abajo ? abajo.name : null,
        source: abajo
            ? `${path.dirname(abajo.path)} · ${mega(abajo.bytes)} contra ${mega(pesoDe(grande))} del grande`
            : 'ninguno más liviano que el grande',
        searched: modelDirs()
    };
}

function pesoDe(modelo) {
    const con = conPeso(modelo);
    return con ? con.bytes : 0;
}

function mega(bytes) {
    return `${Math.round(bytes / 1e8) / 10} GB`;
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
        },
        // Y el escalón de abajo, que solo se sabe si está mirando lo que pesa cada
        // modelo (`escalonDebajo`). Va acá porque es lo único que se puede
        // averiguar ANTES de la clase: si el sistema se lleva al modelo grande en
        // medio de una toma y no hay ninguno más liviano instalado, esa toma se
        // queda con el texto descartable y no hay nada que la app pueda hacer.
        // Enterarse el día del rodaje, con la clase ya grabada, es tarde.
        {
            key: 'modelo al que bajar si el grande se muere',
            required: false,
            nota: 'Sin uno más liviano que el grande, la toma que el sistema le arranque a ' +
                'whisper-cli queda marcada como sin releer y hay que apretarle "Regenerar" ' +
                'después. Bajar por la lista de preferencia no sirve: el que le sigue al ' +
                'grande pesa el doble.',
            info: escalonDelGrande()
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
    // El escalón de abajo, que es lo que la política de reintento le pregunta
    // cuando el sistema se lleva a whisper-cli (`engine/insistir.js`).
    modelosInstalados, elDeAbajo, escalonDebajo,
    // Primitivas que usa quien resuelve otras cosas (ver `ollama-store.js`).
    isExecutable, rank, appRoot, dataDirs, DATA_DIR,
    doctor, clearCache
};
