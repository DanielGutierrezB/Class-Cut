'use strict';
/**
 * Que el modelo local se elija bien y que la app nunca se meta con el Ollama del
 * editor. Todo con almacenes de mentira en disco: acá no se levanta ningún
 * servidor ni se carga ningún modelo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../engine/ollama-store');
const server = require('../engine/ollama-server');
const ai = require('../engine/ai-local');

/** Un almacén de modelos como el que arma Ollama: manifiestos y blobs. */
function fakeStore(models) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-store-'));
    for (const full of models) {
        const [name, tag = 'latest'] = full.split(':');
        const lib = path.join(dir, 'manifests', 'registry.ollama.ai', 'library', name);
        fs.mkdirSync(lib, { recursive: true });
        fs.writeFileSync(path.join(lib, tag), JSON.stringify({ schemaVersion: 2, layers: [] }));
    }
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    return dir;
}

const propio = models => ({ store: fakeStore(models), own: true });
const delEditor = models => ({ store: fakeStore(models), own: false });

module.exports = function (t) {
    t.group('modelo local · se elige el mejor sin tocar el del editor');

    t.test('los modelos salen de los manifiestos, no de adivinar', () => {
        const dir = fakeStore(['qwen3:4b', 'llama3:latest']);
        t.deep(store.modelsIn(dir).sort(), ['llama3:latest', 'qwen3:4b']);
    });

    t.test('un almacén vacío no rompe nada', () => {
        t.deep(store.modelsIn('/no/existe/esto'), []);
        t.deep(store.modelsIn(null), []);
    });

    t.test('si el editor ya tiene uno mejor, se usa el suyo', () => {
        const choice = server.elegirModelo([delEditor(['qwen3.8:27b']), propio(['qwen3:4b'])]);
        t.eq(choice.model, 'qwen3.8:27b');
        t.eq(choice.own, false, 'debería usar el almacén del editor');
    });

    t.test('sin nada instalado, se usa el que trae la app', () => {
        const choice = server.elegirModelo([propio([server.BUNDLED])]);
        t.eq(choice.model, server.BUNDLED);
        t.eq(choice.own, true);
    });

    t.test('a igual modelo gana el del editor, que ya pagó esos gigas', () => {
        const choice = server.elegirModelo([delEditor(['qwen3:4b']), propio(['qwen3:4b'])]);
        t.eq(choice.own, false);
    });

    t.test('un modelo desconocido se usa igual antes que rendirse', () => {
        t.eq(server.elegirModelo([delEditor(['algo-nuevo:latest'])]).model, 'algo-nuevo:latest');
    });

    t.test('y eso vale también para el que trae la app', () => {
        // Si el empaquetado cambia de modelo y nadie toca la lista de
        // preferencia, el bundle no puede quedar muerto: son gigabytes que
        // viajaron en el instalador para nada.
        const choice = server.elegirModelo([propio(['modelo-nuevo:8b'])]);
        t.ok(choice, 'debería elegir el del bundle aunque no lo conozca');
        t.eq(choice.model, 'modelo-nuevo:8b');
    });

    t.test('un modelo conocido le gana a uno desconocido', () => {
        const choice = server.elegirModelo([delEditor(['algo-raro:1b', 'qwen3:8b'])]);
        t.eq(choice.model, 'qwen3:8b');
    });

    t.test('sin ningún modelo se avisa en vez de inventar uno', () => {
        t.eq(server.elegirModelo([]), null);
        t.eq(server.elegirModelo([propio([])]), null);
    });

    t.test('el que trae la app es el último de la lista de preferencia', () => {
        t.ok(server.PREFERENCE.includes(server.BUNDLED), 'el modelo del bundle no está en la preferencia');
        t.eq(server.PREFERENCE[server.PREFERENCE.length - 1], server.BUNDLED);
    });

    t.test('Diagnóstico informa sin levantar el modelo', () => {
        const info = server.estado();
        t.ok(['corriendo', 'listo', 'falta'].includes(info.estado), `estado raro: ${info.estado}`);
        t.ok(typeof info.reason === 'string' && info.reason, 'siempre tiene que decir por qué');
    });

    t.group('cliente de IA · atado a un servidor, sin estado global');

    t.test('cada cliente recuerda a quién le habla', () => {
        // Con un singleton, el banco de pruebas terminaba midiendo contra el
        // Ollama del editor en el 11434 sin que nadie lo notara.
        const uno = ai.cliente({ url: 'http://127.0.0.1:1111', model: 'a' });
        const otro = ai.cliente({ url: 'http://127.0.0.1:2222', model: 'b' });
        t.eq(uno.url, 'http://127.0.0.1:1111');
        t.eq(uno.model, 'a');
        t.eq(otro.url, 'http://127.0.0.1:2222');
        t.eq(otro.model, 'b');
    });

    t.test('no hay puerto por defecto que pueda ser el del editor', () => {
        t.ok(!('url' in ai.DEFAULTS), 'un url por defecto termina apuntando al 11434 del editor');
        t.ok(!('model' in ai.DEFAULTS), 'el modelo lo decide quien levanta el servidor');
    });
};
