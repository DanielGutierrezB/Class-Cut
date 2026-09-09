'use strict';
/**
 * sonda-degradada.js — Cómo se ve en la pantalla una toma que se quedó sin
 * relectura.
 *
 *   node tools/sonda-degradada.js --capturas=/tmp/cc-degradada
 *
 * Es una sonda y no una prueba: lo que hay que comprobar del aviso —qué dice y
 * con qué clase— está en `tests/relectura-caida.test.js`, que corre sin ventana.
 * Esto es para MIRARLO, que es lo único que dice si un aviso pesa lo que tiene
 * que pesar en medio de una clase que se está grabando.
 *
 * Levanta la maqueta en el 4399, no en el 4321, que es el de quien esté mirando
 * el diseño, y la apaga al salir.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const electron = require('electron');
const cli = require('./lib/cli');

const PUERTO = Number(cli.arg('puerto', 4399));
const CAPTURAS = cli.arg('capturas', '/tmp/cc-degradada');

const dormir = ms => new Promise(r => setTimeout(r, ms));

function esperarMaqueta(url, hasta) {
    return new Promise((listo, mal) => {
        const probar = () => {
            http.get(url, res => {
                res.resume();
                if (res.statusCode === 200) return listo();
                reintentar();
            }).on('error', reintentar);
        };
        const reintentar = () => {
            if (Date.now() > hasta) return mal(new Error(`la maqueta no contestó en ${url}`));
            setTimeout(probar, 200);
        };
        probar();
    });
}

async function enNode() {
    const url = `http://localhost:${PUERTO}/?grabando`;
    const maqueta = spawn(process.execPath, [path.join(__dirname, 'maqueta.js'), `--puerto=${PUERTO}`], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'inherit']
    });
    await esperarMaqueta(url, Date.now() + 90000);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const ventana = spawn(electron, [__filename, ...process.argv.slice(2), `--url=${url}`], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
        env
    });
    ventana.on('exit', codigo => {
        maqueta.kill();
        process.exit(codigo == null ? 1 : codigo);
    });
}

async function enVentana() {
    const { app, BrowserWindow } = electron;
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1400, height: 1000, show: true,
        webPreferences: { contextIsolation: false, nodeIntegration: false }
    });
    await win.loadURL(cli.arg('url'));
    const wc = win.webContents;
    await dormir(3000);

    // Las dos marcas, puestas por abajo en la sesión de la maqueta para que la
    // única forma de que lleguen a la pantalla sea el empujón de cada tres
    // segundos, que es como llegan en la app.
    const puestas = await wc.executeJavaScript(`(() => {
        const s = window.maqueta.sesionEnVivo();
        const cerradas = s.tomas.filter(t => t.outMs != null);
        if (cerradas.length < 2) return 'la maqueta todavía no tiene dos tomas cerradas';
        cerradas[0].relectura = {
            estado: 'degradada', modelo: 'ggml-base.bin', bueno: 'ggml-large-v3-turbo.bin',
            porque: 'Esta toma se releyó con ggml-base.bin, que es más liviano que ' +
                'ggml-large-v3-turbo.bin: el sistema le cortó a whisper-cli las pasadas con el ' +
                'modelo bueno. El texto es peor que el del resto de la clase. "Regenerar" la ' +
                'vuelve a leer con ggml-large-v3-turbo.bin, con la máquina libre.'
        };
        cerradas[1].relectura = {
            estado: 'sin-leer', modelo: null, bueno: 'ggml-large-v3-turbo.bin',
            porque: 'A esta toma no se le pudo rehacer el texto: se intentó con ' +
                'ggml-large-v3-turbo.bin y no había ningún modelo más liviano al que bajar. ' +
                'Lo que se ve es el texto del ciclo de señales, que es el descartable. ' +
                '"Regenerar" la vuelve a leer con la máquina libre.'
        };
        return [cerradas[0].id, cerradas[1].id].join(',');
    })()`);
    console.log(`marcas puestas en las tomas ${puestas}`);
    await dormir(4500);

    const dibujado = await wc.executeJavaScript(`(() => {
        return [...document.querySelectorAll('#grabar-tomas .toma')].map(t => ({
            id: t.dataset.toma,
            avisos: [...t.querySelectorAll('.toma-aviso')].map(p => ({
                clase: p.className,
                color: getComputedStyle(p).color,
                borde: getComputedStyle(p).borderLeftColor,
                texto: p.textContent
            }))
        })).filter(t => t.avisos.length);
    })()`);
    console.log(JSON.stringify(dibujado, null, 2));

    fs.mkdirSync(CAPTURAS, { recursive: true });
    // La tarjeta sola y la pantalla entera: la primera dice cómo se lee el aviso,
    // la segunda si se lee como un cartel al lado de todo lo demás.
    await wc.executeJavaScript(
        `(document.querySelector('#grabar-tomas .toma .toma-aviso.es-degradada')
            .scrollIntoView({ block: 'center' }), 1)`);
    await dormir(400);
    const entera = path.join(CAPTURAS, 'pantalla.png');
    fs.writeFileSync(entera, (await wc.capturePage()).toPNG());
    console.log(`captura: ${entera}`);
    app.exit(0);
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    enVentana().catch(err => { console.error(err.stack); electron.app.exit(1); });
} else {
    enNode().catch(err => { console.error(err.stack); process.exit(1); });
}
