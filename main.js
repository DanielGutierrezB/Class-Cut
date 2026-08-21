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

const scanner = require('./engine/course-scan');
const probe = require('./engine/media-probe');
const paths = require('./engine/paths');

let mainWindow = null;

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
        await new Promise(r => setTimeout(r, 400));
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

ipcMain.handle('doctor', () => paths.doctor());

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
    return result;
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
