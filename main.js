'use strict';
/**
 * main.js — Proceso principal de Class Cut.
 *
 * Todo el trabajo pesado (escanear, medir con ffprobe, más adelante transcribir y
 * exportar) vive acá, en Node. La ventana solo dibuja y manda pedidos: así un
 * escaneo de 130 archivos no congela la interfaz y el motor se puede probar sin
 * abrir la app (`node tests/run.js`).
 */

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const scanner = require('./engine/course-scan');
const probe = require('./engine/media-probe');
const paths = require('./engine/paths');
const pipeline = require('./engine/pipeline');
const workspace = require('./engine/workspace');
const review = require('./engine/review');
const notas = require('./engine/notas');
const estadoClase = require('./engine/estado-clase');
const waveform = require('./engine/waveform');
const ollamaServer = require('./engine/ollama-server');
const updates = require('./engine/updates');
const mediaServer = require('./engine/media-server');

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

/** Avisarle algo a la ventana, si todavía está. */
function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ─── El video, hasta la ventana ───────────────────────────────────────

/**
 * `clase://` — le sirve a la ventana los archivos de cámara para el reproductor.
 *
 * No se usa `file://` directo: la ventana corre con `sandbox` y aislamiento, y
 * apagar `webSecurity` para que pueda leer el disco le abriría la puerta a todo
 * lo demás. Con un protocolo propio la ventana solo alcanza lo que esta lista
 * deja pasar, que son las cámaras de la clase que el editor abrió.
 *
 * `stream: true` es lo que permite contestar de a pedazos; quién arma esos
 * pedazos está en `engine/media-server.js`.
 */
protocol.registerSchemesAsPrivileged([{
    scheme: 'clase',
    // Sin `bypassCSP`: el video está declarado en la política de la ventana
    // (`media-src … clase:`), así que la política sigue siendo la frontera real
    // y no algo que este protocolo se saltea.
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
}]);

const mediaPermitida = new Set();

/** Habilita los videos de una clase y devuelve las urls con las que pedirlos. */
function permitirMedia(files) {
    return (files || []).map(file => {
        const real = path.resolve(file);
        mediaPermitida.add(real);
        return `clase://media/${encodeURIComponent(real)}`;
    });
}

function servirMedia() {
    protocol.handle('clase', request => mediaServer.responder(request, mediaPermitida));
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
 *   electron . --folder=/ruta/al/curso --shot=/tmp/class-cut.png --js='dev.abrirClase(id)'
 * Carga la carpeta, espera a que la tabla termine de medir, corre el JS que se le
 * pase, guarda el PNG y sale.
 *
 * Para atajos de teclado hay `--key=Space` (una tecla de verdad, con su acción
 * por defecto) y `--js-despues=` para mirar cómo quedó todo.
 */
async function devShot() {
    const shot = argValue('shot');
    const folder = argValue('folder');
    const extraJs = argValue('js');
    if (!shot && !folder) return;

    if (folder) {
        await mainWindow.webContents.executeJavaScript(`dev.addFolder(${JSON.stringify(folder)})`);
        await new Promise(r => setTimeout(r, 4000));
    }
    if (extraJs) {
        // Sin esto, lo que el JS de prueba imprime se queda en la consola de la
        // ventana y desde afuera solo queda mirar el PNG y opinar.
        mainWindow.webContents.on('console-message', (_e, _nivel, texto) => console.log(texto));
        const salida = await mainWindow.webContents.executeJavaScript(extraJs);
        if (salida !== undefined) console.log(salida);
        await new Promise(r => setTimeout(r, Number(argValue('wait')) || 400));
    }

    // Y `elemento.click()` tampoco mueve el foco como lo mueve el mouse, que es
    // de dónde salen la mitad de los problemas con los atajos.
    const click = argValue('click');
    if (click) {
        const [x, y] = click.split(',').map(Number);
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 300));
    }

    // Un atajo de teclado no se puede probar con `new KeyboardEvent`: un evento
    // fabricado no arrastra la acción del navegador, así que el scroll de la
    // barra espaciadora —que es justo lo que se quiere ver— nunca aparece.
    const key = argValue('key');
    if (key) {
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: key });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
        await new Promise(r => setTimeout(r, 500));
        const despues = argValue('js-despues');
        if (despues) {
            const salida = await mainWindow.webContents.executeJavaScript(despues);
            if (salida !== undefined) console.log(salida);
        }
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
    servirMedia();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// El modelo es un proceso aparte y no se entera de que la app cerró: sin esto
// queda cargado ocupando memoria hasta que alguien lo mate a mano.
app.on('before-quit', () => { ollamaServer.stop(); });

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
    // los bordes dudosos y la lectura del guion. Por eso se informa aparte, y sin
    // levantar el servidor: abrir Diagnóstico no debería cargar un modelo en
    // memoria.
    report.ai = ollamaServer.estado();
    return report;
});

// ─── Actualizaciones ──────────────────────────────────────────────────

let descargaEnCurso = null;

ipcMain.handle('update-check', async () => updates.check({ currentVersion: appVersion() }));

/**
 * Baja el instalador y lo abre.
 *
 * Se abre en vez de instalarlo solo: sin Developer ID de Apple la app va firmada
 * ad-hoc, y el instalador silencioso de macOS valida firmas que no tenemos (ver
 * `engine/updates.js`). Abrir el PKG deja al editor a un clic de Continuar.
 */
ipcMain.handle('update-download', async (event, payload) => {
    if (descargaEnCurso) return { ok: false, error: 'Ya se está descargando.' };
    const { url, nombre } = payload || {};
    if (!url) return { ok: false, error: 'No llegó de dónde bajarla.' };

    const controller = new AbortController();
    descargaEnCurso = controller;
    try {
        const result = await updates.download({
            url,
            nombre,
            // A Descargas y no a una carpeta temporal: si algo sale mal a mitad
            // de la instalación, el editor todavía tiene el instalador a mano.
            destDir: app.getPath('downloads'),
            signal: controller.signal,
            onProgress: info => send('update-progress', info)
        });
        if (result.ok) {
            // El instalador reemplaza la app que está corriendo, así que macOS
            // pide cerrarla. Se le avisa a la ventana para que lo diga antes.
            send('update-ready', { path: result.path });
        }
        return result;
    } finally {
        descargaEnCurso = null;
    }
});

ipcMain.handle('update-cancel', () => {
    if (descargaEnCurso) descargaEnCurso.abort();
    return { ok: true };
});

ipcMain.handle('update-install', async (event, target) => {
    if (!target || !fs.existsSync(target)) {
        return { ok: false, error: 'El instalador ya no está donde se bajó.' };
    }
    // A mitad de un curso no: cerrar acá deja las clases a medio procesar y el
    // instalador puede esperar.
    if (currentRun) {
        return { ok: false, error: 'Hay un curso procesando. Esperá a que termine.' };
    }

    const error = await shell.openPath(target);
    if (error) return { ok: false, error };

    // El instalador reemplaza este mismo `.app`. Si seguimos abiertos, lo que
    // queda corriendo es una app cuyos archivos en disco ya no son los suyos:
    // todo lo que cargue tarde —una ventana, un binario— sale de la versión
    // nueva o directamente falla. Nos apartamos y que el editor la vuelva a abrir.
    setTimeout(() => app.quit(), 1500);
    return { ok: true, cerrando: true };
});

// Los modelos que hay para elegir. Se leen del disco cada vez: el editor puede
// bajarse uno con Ollama sin cerrar la app.
ipcMain.handle('modelos', async () => ollamaServer.modelos());

// Con cuál está corriendo, para el cabezal. Lleva el elegido a mano porque esa
// preferencia vive en la ventana: sin ella acá se contestaría el del orden de
// preferencia y el cabezal mostraría un modelo que no es el que se va a usar.
ipcMain.handle('modelo', async (event, preferido) => ollamaServer.estado(preferido || null));

/**
 * Un sí o no para lo que no se puede deshacer. Va por el diálogo del sistema y
 * no por uno dibujado en la ventana: este es el que bloquea de verdad y el que
 * se ve igual con la app de fondo.
 */
ipcMain.handle('confirmar', async (event, { titulo, mensaje, ok } = {}) => {
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: [ok || 'Continuar', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: titulo || 'Confirmar',
        message: titulo || 'Confirmar',
        detail: mensaje || ''
    });
    return result.response === 0;
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
    const data = review.loadReview({ root: lastScan.root, cls, buckets });
    if (data.ok) {
        // El reproductor pide los videos por `clase://`, así que las rutas de
        // esta clase quedan habilitadas al abrirla y no antes.
        const urls = permitirMedia(data.cameras.map(c => c.path));
        data.cameras = data.cameras.map((c, i) => ({ index: c.index, name: c.name, url: urls[i] }));
    }
    return data;
});

ipcMain.handle('waveform-window', (event, { path: wavPath, fromSec, toSec, buckets }) => {
    if (!wavPath) return null;
    return waveform.peaks(wavPath, buckets || 1200, { fromSec, toSec });
});

ipcMain.handle('save-review', (event, { id, segments, viewMap }) => {
    const cls = classById(id);
    if (!cls) return { ok: false, error: 'Esa clase ya no está en el escaneo.' };
    const res = review.saveReview({ root: lastScan.root, cls, segments, viewMap });
    // Los bordes que el editor movió a mano son tan poco recalculables como las
    // notas: si se rehace el XML, el archivo de la clase tiene que quedar con
    // ese XML y no con el de antes.
    if (res && res.ok) estadoClase.actualizar({ root: lastScan.root, cls, claves: ['align', 'cutplan'] });
    return res;
});

/**
 * Las notas se guardan solas, sin esperar a "Guardar y regenerar".
 *
 * Es lo único de la revisión que no se puede recalcular: si alguien escribe un
 * comentario, cambia de clase y se va, tiene que seguir ahí. Los bordes no
 * corren esa suerte porque volver a moverlos cuesta un clic.
 */
ipcMain.handle('save-notas', (event, { id, bloques, comentarios }) => {
    const cls = classById(id);
    if (!cls) return { ok: false, error: 'Esa clase ya no está en el escaneo.' };
    try {
        const guardadas = notas.guardar(lastScan.root, cls.sequenceName, { bloques, comentarios });
        // Y al archivo de la clase, que es el que viaja con la carpeta.
        estadoClase.actualizar({ root: lastScan.root, cls, claves: ['notas'] });
        return { ok: true, notas: guardadas };
    } catch (err) {
        return { ok: false, error: `No se pudieron guardar las notas: ${err.message}` };
    }
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
    const { root, ids = [], viewMap, force, useAi, model } = payload || {};
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

    const controller = new AbortController();
    currentRun = controller;
    try {
        const results = await pipeline.processClasses({
            root: scan.root,
            classes: usable,
            viewMap,
            force,
            appVersion: appVersion(),
            useAi: useAi !== false,
            model: model || null,
            signal: controller.signal,
            onStage: (stage, info) => send('process-stage', { stage, ...info }),
            // La fase 'modelo' llega una vez y sin clase: es de la corrida
            // entera, no de ninguna en particular.
            onClass: (phase, info) => send('process-class', phase === 'modelo'
                ? { phase, modelo: { reason: info.modelo.reason, model: info.modelo.model || null } }
                : {
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
