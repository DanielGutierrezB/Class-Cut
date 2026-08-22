'use strict';
/**
 * Que el modelo local se elija bien y que la app nunca se meta con el Ollama del
 * editor. Todo con almacenes de mentira en disco: acá no se levanta ningún
 * servidor ni se carga ningún modelo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../engine/paths');
const server = require('../engine/ollama-server');

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

module.exports = function (t) {
    t.group('modelo local · se elige el mejor sin tocar el del editor');

    t.test('los modelos salen de los manifiestos, no de adivinar', () => {
        const store = fakeStore(['qwen3:4b', 'llama3:latest']);
        const found = paths.modelsIn(store).sort();
        t.deep(found, ['llama3:latest', 'qwen3:4b']);
    });

    t.test('un almacén vacío no rompe nada', () => {
        t.deep(paths.modelsIn('/no/existe/esto'), []);
        t.deep(paths.modelsIn(null), []);
    });

    t.test('si el editor ya tiene uno mejor, se usa el suyo', () => {
        const user = fakeStore(['qwen3.8:27b']);
        const bundled = fakeStore(['qwen3:4b']);
        const original = { user: paths.userOllamaModels, bundled: paths.ollamaModels };
        paths.userOllamaModels = () => user;
        paths.ollamaModels = () => ({ path: bundled, source: 'incluido en la app' });
        try {
            const choice = server.chooseStore();
            t.eq(choice.model, 'qwen3.8:27b');
            t.eq(choice.own, false, 'debería usar el almacén del editor');
            t.eq(choice.store, user);
        } finally {
            Object.assign(paths, { userOllamaModels: original.user, ollamaModels: original.bundled });
        }
    });

    t.test('sin nada instalado, se usa el que trae la app', () => {
        const bundled = fakeStore(['qwen3:4b']);
        const original = { user: paths.userOllamaModels, bundled: paths.ollamaModels };
        paths.userOllamaModels = () => null;
        paths.ollamaModels = () => ({ path: bundled, source: 'incluido en la app' });
        try {
            const choice = server.chooseStore();
            t.eq(choice.model, server.BUNDLED);
            t.eq(choice.own, true);
        } finally {
            Object.assign(paths, { userOllamaModels: original.user, ollamaModels: original.bundled });
        }
    });

    t.test('un modelo desconocido del editor se usa igual antes que rendirse', () => {
        const user = fakeStore(['algo-nuevo:latest']);
        const original = { user: paths.userOllamaModels, bundled: paths.ollamaModels };
        paths.userOllamaModels = () => user;
        paths.ollamaModels = () => ({ path: null, source: 'no encontrado' });
        try {
            const choice = server.chooseStore();
            t.eq(choice.model, 'algo-nuevo:latest');
        } finally {
            Object.assign(paths, { userOllamaModels: original.user, ollamaModels: original.bundled });
        }
    });

    t.test('sin ningún modelo se avisa en vez de inventar uno', () => {
        const original = { user: paths.userOllamaModels, bundled: paths.ollamaModels };
        paths.userOllamaModels = () => null;
        paths.ollamaModels = () => ({ path: null, source: 'no encontrado' });
        try {
            t.eq(server.chooseStore(), null);
        } finally {
            Object.assign(paths, { userOllamaModels: original.user, ollamaModels: original.bundled });
        }
    });

    t.test('el que trae la app es el último de la lista de preferencia', () => {
        // Si el empaquetado cambia de modelo y nadie toca la lista, la app
        // preferiría cualquier otro antes que el suyo y el bundle sobraría.
        t.ok(server.PREFERENCE.includes(server.BUNDLED), 'el modelo del bundle no está en la preferencia');
        t.eq(server.PREFERENCE[server.PREFERENCE.length - 1], server.BUNDLED);
    });

    t.test('nunca se arranca en el puerto del editor', () => {
        // 11434 es el de la instalación del editor. Levantar ahí sería pelearle el
        // puerto a un proceso que no es nuestro.
        t.ok(server.FIRST_PORT !== 11434, 'el puerto propio no puede ser el de Ollama');
        t.ok(server.FIRST_PORT > 1024, 'tiene que ser un puerto sin privilegios');
    });

    t.test('Diagnóstico informa sin levantar el modelo', () => {
        const status = server.status();
        t.eq(status.running, false, 'mirar el estado no debería arrancar nada');
        t.ok('ok' in status && 'model' in status, 'faltan datos para mostrar');
    });
};
