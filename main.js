'use strict';
/**
 * main.js — Proceso principal de Class Cut.
 *
 * Todo el trabajo pesado (escanear, medir con ffprobe, más adelante transcribir y
 * exportar) vive acá, en Node. La ventana solo dibuja y manda pedidos: así un
 * escaneo de 130 archivos no congela la interfaz y el motor se puede probar sin
 * abrir la app (`node tests/run.js`).
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const scanner = require('./engine/course-scan');
const probe = require('./engine/media-probe');
const paths = require('./engine/paths');
const pipeline = require('./engine/pipeline');
const workspace = require('./engine/workspace');
const review = require('./engine/review');
const waveform = require('./engine/waveform');
const aiLocal = require('./engine/ai-local');

let mainWindow = null;
let currentRun = null;
// El último escaneo, con el material ya medido. El visor y el guardado lo
// necesitan entero (bloques, cámaras, audios) y la ventana solo maneja ids.
let lastScan = null;

function appVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
    } catch (e) {
        return app.getVersion();
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 840,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#12141a',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadFile('src/index.html');
    mainWindow.webContents.once('did-finish-load', () => devShot());
}

function argValue(flag) {
    const hit = process.argv.find(a => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : null;
}

/**
 * Para iterar la interfaz sin abrir la app a mano:
 *   electron . --folder=/ruta/al/curso --shot=/tmp/class-cut.png --js='openDrawer(id)'
 * Carga la carpeta, espera a que la tabla termine de medir, corre el JS que se le
 * pase, guarda el PNG y sale.
 */
async function devShot() {
    const shot = argValue('shot');
    const folder = argValue('folder');
    const extraJs = argValue('js');
    if (!shot && !folder) return;

    if (folder) {
        await mainWindow.webContents.executeJavaScript(`addFolder(${JSON.stringify(folder)})`);
        await new Promise(r => setTimeout(r, 4000));
    }
    if (extraJs) {
        await mainWindow.webContents.executeJavaScript(extraJs);
        await new Promise(r => setTimeout(r, Number(argValue('wait')) || 400));
    }
    if (!shot) return;

    await new Promise(r => setTimeout(r, 500));
    try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
        console.log('captura:', shot);
    } catch (e) {
        console.error('no se pudo capturar:', e.message);
    }
    app.quit();
}

// Un fallo suelto no puede dejar la app viva pero muda: se registra y sigue.
process.on('uncaughtException', err => console.error('Excepción no atrapada:', err));
process.on('unhandledRejection', reason => console.error('Promesa rechazada:', reason));

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ─── Puente con la ventana ────────────────────────────────────────────

ipcMain.handle('app-info', () => ({
    version: appVersion(),
    arch: process.arch,
    electron: process.versions.electron,
    platform: process.platform
}));

ipcMain.handle('doctor', async () => {
    const report = paths.doctor();
    // La IA es opcional: sin ella la app corta igual, solo pierde el criterio en
    // los bordes dudosos y la lectura del guion. Por eso se informa aparte.
    report.ai = await aiLocal.probe();
    return report;
});

ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Elegí la carpeta del curso, del día o de la clase',
        buttonLabel: 'Agregar',
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

/**
 * Escanea y mide. El escaneo es inmediato; medir con ffprobe tarda (unos 150 ms
 * por clase), así que la tabla se manda primero y las duraciones van llegando.
 */
ipcMain.handle('scan', async (event, folder) => {
    if (!folder || typeof folder !== 'string') {
        return { ok: false, error: 'No llegó ninguna carpeta.' };
    }

    const result = scanner.scan(folder);
    if (!result.ok) return result;

    const send = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    };

    send('scan-found', result);

    await probe.probeClasses(result.classes, (done, total, cls) => {
        send('scan-progress', {
            done,
            total,
            id: cls.id,
            durationSec: cls.durationSec,
            fps: cls.fps,
            problems: cls.problems,
            warnings: cls.warnings,
            processable: cls.processable
        });
    });

    // Medir puede descalificar una clase (media ilegible), así que el resumen se
    // recalcula acá y no antes.
    result.processableCount = result.classes.filter(c => c.processable).length;
    for (const cls of result.classes) {
        if (!cls.processable) cls.selected = false;
    }
    result.totalDurationSec = result.classes.reduce((sum, c) => sum + (c.durationSec || 0), 0);
    lastScan = result;
    return result;
});

function classById(id) {
    if (!lastScan) return null;
    return lastScan.classes.find(c => c.id === id) || null;
}

ipcMain.handle('load-review', (event, { id, buckets }) => {
    const cls = classById(id);
    if (!cls) return { ok: false, error: 'Esa clase ya no está en el escaneo. Volvé a agregar la carpeta.' };
    return review.loadReview({ root: lastScan.root, cls, buckets });
});

ipcMain.handle('waveform-window', (event, { path: wavPath, fromSec, toSec, buckets }) => {
    if (!wavPath) return null;
    return waveform.peaks(wavPath, buckets || 1200, { fromSec, toSec });
});

ipcMain.handle('save-review', (event, { id, segments, viewMap }) => {
    const cls = classById(id);
    if (!cls) return { ok: false, error: 'Esa clase ya no está en el escaneo.' };
    return review.saveReview({ root: lastScan.root, cls, segments, viewMap });
});

/**
 * Un pedacito de audio para escuchar un borde antes de aceptarlo. Se extrae con
 * ffmpeg a mono 22 kHz: alcanza de sobra para oír dónde entra la voz y pesa lo
 * que se puede mandar a la ventana sin pensarlo.
 */
ipcMain.handle('audition', async (event, { path: wavPath, startSec, durationSec }) => {
    const tool = paths.ffmpeg();
    if (!tool.path) return { ok: false, error: 'Falta ffmpeg (mirá Diagnóstico).' };

    const out = path.join(app.getPath('temp'), `classcut-audition-${Date.now()}.wav`);
    const args = [
        '-v', 'error', '-y',
        '-ss', String(Math.max(0, startSec)),
        '-t', String(Math.max(0.2, Math.min(30, durationSec))),
        '-i', wavPath,
        '-ar', '22050', '-ac', '1', '-c:a', 'pcm_s16le',
        out
    ];

    return new Promise(resolve => {
        execFile(tool.path, args, { timeout: 20000 }, err => {
            if (err) return resolve({ ok: false, error: err.message });
            try {
                const data = fs.readFileSync(out);
                fs.unlinkSync(out);
                resolve({ ok: true, dataUrl: `data:audio/wav;base64,${data.toString('base64')}` });
            } catch (e) {
                resolve({ ok: false, error: e.message });
            }
        });
    });
});

/**
 * Procesa las clases marcadas. Se vuelve a escanear y a medir antes de empezar:
 * lo que llega de la ventana son ids, no el material — el disco pudo cambiar
 * mientras el editor miraba la tabla.
 */
ipcMain.handle('process', async (event, payload) => {
    const { root, ids = [], viewMap, force, useAi } = payload || {};
    if (currentRun) return { ok: false, error: 'Ya hay un procesamiento en curso.' };

    const scan = scanner.scan(root);
    if (!scan.ok) return scan;

    const wanted = new Set(ids);
    const classes = scan.classes.filter(c => wanted.has(c.id));
    if (!classes.length) return { ok: false, error: 'No quedó ninguna clase marcada.' };

    await probe.probeClasses(classes);
    const usable = classes.filter(c => c.processable);
    if (!usable.length) {
        return { ok: false, error: 'Ninguna de las clases marcadas se puede procesar. Mirá el detalle de cada fila.' };
    }

    const send = (channel, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
    };

    const controller = new AbortController();
    currentRun = controller;
    try {
        const results = await pipeline.processClasses({
            root: scan.root,
            classes: usable,
            viewMap,
            force,
            useAi: useAi !== false,
            signal: controller.signal,
            onStage: (stage, info) => send('process-stage', { stage, ...info }),
            onClass: (phase, info) => send('process-class', {
                phase,
                id: info.cls.id,
                index: info.index,
                total: info.total,
                result: info.result || null
            })
        });
        return {
            ok: true,
            cancelled: controller.signal.aborted,
            outputDir: workspace.outputRoot(scan.root),
            results
        };
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        currentRun = null;
    }
});

ipcMain.handle('cancel-process', () => {
    if (!currentRun) return false;
    currentRun.abort();
    return true;
});

ipcMain.handle('reveal', (event, target) => {
    if (typeof target !== 'string' || !target) return false;
    shell.showItemInFolder(target);
    return true;
});

ipcMain.handle('open-path', async (event, target) => {
    if (typeof target !== 'string' || !target) return false;
    const err = await shell.openPath(target);
    return !err;
});
