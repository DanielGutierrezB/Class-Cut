'use strict';
/**
 * Que el aviso de actualización no mienta ni moleste.
 *
 * Lo que se prueba acá es sobre todo lo que NO tiene que pasar: ofrecer una
 * versión más vieja, quedarse colgado sin internet, o dejar un PKG a medio bajar
 * que el editor pueda abrir. Un servidor de mentira levantado en el momento
 * evita salir a GitHub para probarlo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const updates = require('../engine/updates');
const paths = require('../engine/paths');

/** Un GitHub de mentira. Devuelve la url base y cómo apagarlo. */
function fakeGitHub(handler) {
    const server = http.createServer(handler);
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-update-'));
}

module.exports = t => {

    t.group('los modelos sobreviven a la actualización');

    // Todo el diseño de la actualización se apoya en esto: los modelos viven
    // fuera del `.app`. Si alguien los vuelve a meter adentro o cambia el orden
    // de búsqueda, actualizar pasa a costar 3.8 GB en vez de 146 MB y encima
    // borra lo que ya estaba instalado.

    t.test('primero se buscan donde los deja el instalador', () => {
        const dirs = paths.dataDirs('models');
        t.eq(dirs[0], '/Library/Application Support/Class Cut/models');
    });

    t.test('lo que quedó dentro del .app nunca le gana a lo instalado', () => {
        const dirs = paths.dataDirs('models');
        const fuera = dirs.findIndex(d => d.startsWith(paths.DATA_DIR));
        const dentro = dirs.findIndex(d => d.includes('bin/mac') || d.includes('Resources'));
        t.ok(fuera < dentro, `fuera del bundle (${fuera}) tiene que ir antes que adentro (${dentro})`);
    });

    t.test('el almacén de Ollama se busca en el mismo lugar', () => {
        const dirs = paths.dataDirs('ollama-models');
        t.eq(dirs[0], '/Library/Application Support/Class Cut/ollama-models');
    });

    t.test('los modelos se encuentran estando solo fuera del .app', () => {
        // Una máquina recién instalada: nada adentro de la app, todo en la
        // carpeta de datos.
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'classcut-home-'));
        const dir = path.join(home, 'Library', 'Application Support', 'Class Cut', 'models');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'ggml-large-v3-turbo.bin'), 'x');

        const previo = process.env.HOME;
        process.env.HOME = home;
        try {
            const encontrado = paths.whisperModel();
            t.ok(encontrado.path && encontrado.path.startsWith(home),
                `debería salir de la carpeta de datos y salió de ${encontrado.path}`);
        } finally {
            process.env.HOME = previo;
        }
    });

    t.group('comparar versiones');

    t.test('0.2.0 es posterior a 0.1.0', () => {
        t.ok(updates.compare('0.2.0', '0.1.0') > 0);
    });

    t.test('la misma versión no ofrece nada', () => {
        t.eq(updates.compare('1.4.2', '1.4.2'), 0);
    });

    t.test('no se ofrece una versión más vieja que la instalada', () => {
        t.ok(updates.compare('0.9.0', '1.0.0') < 0);
    });

    t.test('10 es mayor que 9, no menor', () => {
        // Comparar como texto pone "0.1.10" antes que "0.1.9" y el editor se
        // queda sin actualizaciones para siempre.
        t.ok(updates.compare('0.1.10', '0.1.9') > 0);
    });

    t.test('la v de la etiqueta no cuenta', () => {
        t.eq(updates.compare('v1.2.3', '1.2.3'), 0);
    });

    t.test('las versiones cortas se completan con ceros', () => {
        t.eq(updates.compare('1.2', '1.2.0'), 0);
        t.ok(updates.compare('1.3', '1.2.9') > 0);
    });

    t.group('elegir el instalador del release');

    t.test('se prefiere el PKG de actualización y no el completo', () => {
        // El completo trae los 3.8 GB de modelos que el editor ya tiene.
        const asset = updates.updateAsset({
            assets: [
                { name: 'ClassCut-0.2.0-arm64.pkg' },
                { name: 'ClassCut-0.2.0-arm64-update.pkg' }
            ]
        });
        t.eq(asset.name, 'ClassCut-0.2.0-arm64-update.pkg');
    });

    t.test('un release sin PKG no ofrece nada que abrir', () => {
        t.eq(updates.updateAsset({ assets: [{ name: 'notas.txt' }] }), null);
        t.eq(updates.updateAsset({}), null);
    });

    t.group('consultar si hay novedades');

    t.test('avisa cuando hay una versión nueva con instalador', async () => {
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                tag_name: 'v0.3.0',
                body: '- Cortes más precisos',
                assets: [{
                    name: 'ClassCut-0.3.0-arm64-update.pkg',
                    size: 120 * 1024 * 1024,
                    browser_download_url: `${gh.url}/pkg`
                }]
            }));
        });
        try {
            const res = await conBase(gh.url, { currentVersion: '0.1.0' });
            t.ok(res.hay, 'debería ofrecer la 0.3.0');
            t.eq(res.version, '0.3.0');
            t.eq(res.nombre, 'ClassCut-0.3.0-arm64-update.pkg');
        } finally {
            await gh.close();
        }
    });

    t.test('estando al día no molesta', async () => {
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tag_name: 'v0.1.0', assets: [] }));
        });
        try {
            const res = await conBase(gh.url, { currentVersion: '0.1.0' });
            t.ok(!res.hay, 'no hay nada más nuevo que lo instalado');
        } finally {
            await gh.close();
        }
    });

    t.test('una versión nueva sin instalador no ofrece un botón que falla', async () => {
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tag_name: 'v9.0.0', assets: [{ name: 'notas.txt' }] }));
        });
        try {
            const res = await conBase(gh.url, { currentVersion: '0.1.0' });
            t.ok(!res.hay, 'sin PKG no hay nada para descargar');
            t.ok(/sin instalador/.test(res.motivo), res.motivo);
        } finally {
            await gh.close();
        }
    });

    t.test('sin internet la app sigue funcionando', async () => {
        // El puerto 1 no escucha nadie: es la manera portable de simular que no
        // se puede salir. Esto no puede tirar una excepción a la ventana.
        const res = await updates.check({
            currentVersion: '0.1.0',
            owner: 'nadie',
            repo: 'nada',
            timeoutMs: 500,
            _base: 'http://127.0.0.1:1'
        });
        t.ok(!res.hay, 'sin conexión, no hay novedades');
        t.ok(res.motivo, 'y se explica por qué');
    });

    t.test('un 403 de GitHub no rompe nada', async () => {
        const gh = await fakeGitHub((req, res) => { res.writeHead(403); res.end('nope'); });
        try {
            const res = await conBase(gh.url, { currentVersion: '0.1.0' });
            t.ok(!res.hay);
            t.ok(/403/.test(res.motivo), res.motivo);
        } finally {
            await gh.close();
        }
    });

    t.group('descargar el instalador');

    t.test('baja el archivo y avisa cómo va', async () => {
        const contenido = Buffer.alloc(256 * 1024, 7);
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(contenido.length)
            });
            res.end(contenido);
        });
        const dir = tmpdir();
        try {
            const avisos = [];
            const res = await updates.download({
                url: `${gh.url}/pkg`,
                destDir: dir,
                nombre: 'ClassCut-update.pkg',
                onProgress: info => avisos.push(info.percent)
            });
            t.ok(res.ok, res.error);
            t.eq(fs.statSync(res.path).size, contenido.length);
            t.ok(avisos.length > 0, 'tiene que informar el avance');
            t.eq(avisos[avisos.length - 1], 100);
        } finally {
            await gh.close();
        }
    });

    t.test('una descarga cortada no deja un PKG que se pueda abrir', async () => {
        // Si quedara el archivo a medias, el editor lo abre, el instalador
        // falla y la culpa se la lleva la app.
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': '999999'
            });
            res.write(Buffer.alloc(1024, 3));
            res.destroy();
        });
        const dir = tmpdir();
        try {
            const res = await updates.download({
                url: `${gh.url}/pkg`,
                destDir: dir,
                nombre: 'ClassCut-update.pkg'
            });
            t.ok(!res.ok, 'una descarga incompleta no puede darse por buena');
            t.eq(fs.readdirSync(dir).length, 0, 'no queda ni el archivo ni el parcial');
        } finally {
            await gh.close();
        }
    });

    t.test('sigue la redirección de GitHub al archivo real', async () => {
        // La API contesta con un 302 a objects.githubusercontent.com; sin
        // seguirlo se descargan cero bytes.
        let gh;
        gh = await fakeGitHub((req, res) => {
            if (req.url === '/pkg') {
                res.writeHead(302, { Location: `${gh.url}/real` });
                res.end();
                return;
            }
            const cuerpo = Buffer.alloc(2048, 1);
            res.writeHead(200, { 'Content-Length': String(cuerpo.length) });
            res.end(cuerpo);
        });
        const dir = tmpdir();
        try {
            const res = await updates.download({
                url: `${gh.url}/pkg`,
                destDir: dir,
                nombre: 'ClassCut-update.pkg'
            });
            t.ok(res.ok, res.error);
            t.eq(fs.statSync(res.path).size, 2048);
        } finally {
            await gh.close();
        }
    });

    t.test('se puede cancelar a mitad', async () => {
        const gh = await fakeGitHub((req, res) => {
            res.writeHead(200, { 'Content-Length': '99999999' });
            // Va goteando: da tiempo a cancelar.
            const timer = setInterval(() => res.write(Buffer.alloc(4096, 5)), 5);
            res.on('close', () => clearInterval(timer));
        });
        const dir = tmpdir();
        const controller = new AbortController();
        try {
            setTimeout(() => controller.abort(), 60);
            const res = await updates.download({
                url: `${gh.url}/pkg`,
                destDir: dir,
                nombre: 'ClassCut-update.pkg',
                signal: controller.signal
            });
            t.ok(!res.ok, 'cancelar tiene que cancelar');
            t.eq(fs.readdirSync(dir).length, 0, 'y no dejar restos');
        } finally {
            await gh.close();
        }
    });
};

/** `check` contra el servidor de mentira en vez de contra GitHub. */
function conBase(base, params) {
    return updates.check(Object.assign({ owner: 'quien', repo: 'sea', _base: base }, params));
}
