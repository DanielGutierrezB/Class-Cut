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
const carpetasLib = require('./engine/carpetas');
const probe = require('./engine/media-probe');
const paths = require('./engine/paths');
const pipeline = require('./engine/pipeline');
const workspace = require('./engine/workspace');
const review = require('./engine/review');
const notas = require('./engine/notas');
const estadoClase = require('./engine/estado-clase');
const waveform = require('./engine/waveform');
const ollamaServer = require('./engine/ollama-server');
const ia = require('./engine/ia');
const ajustes = require('./engine/ajustes');
const aiCursor = require('./engine/ai-cursor');
const claves = require('./engine/claves');
const claudeOauth = require('./engine/claude-oauth');
const updates = require('./engine/updates');
const mediaServer = require('./engine/media-server');
const devShot = require('./dev-shot');

let mainWindow = null;
let currentRun = null;
// Las carpetas cargadas, por raíz, con el material ya medido. El visor y el
// guardado las necesitan enteras (bloques, cámaras, audios) y la ventana solo
// maneja ids. Son varias porque el editor puede tener cargado el curso de un
// cliente y el día de otro a la vez.
const carpetas = new Map();

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
    // El arnés de desarrollo (capturas, JS inyectado) vive en `dev-shot.js` y
    // sin sus flags no hace nada.
    mainWindow.webContents.once('did-finish-load', () => devShot.correr(mainWindow));
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
app.on('before-quit', () => { ia.parar(); });

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
    report.ai = ia.estado();
    return report;
});

// ─── Ajustes ──────────────────────────────────────────────────────────

// La ventana recibe los ajustes y un "hay clave guardada" (sí/no). El secreto
// en sí no cruza nunca el puente: vive en el Llavero y lo lee este proceso
// cuando arma el cliente.
function ajustesParaLaVentana() {
    return { ...ajustes.leer(), secretos: { anthropic: Boolean(claves.leer('anthropic')) } };
}

ipcMain.handle('ajustes-leer', () => ajustesParaLaVentana());

ipcMain.handle('ajustes-guardar', (event, datos) => {
    try {
        // Una clave pegada a mano viaja UNA vez por acá y termina en el Llavero;
        // `ajustes.guardar` (sanear) la descarta del JSON.
        const pegada = datos && datos.ia && datos.ia.anthropic && datos.ia.anthropic.apiKey;
        if (pegada) claves.guardar('anthropic', String(pegada).trim());
        ajustes.guardar(datos);
        return { ok: true, ajustes: ajustesParaLaVentana() };
    } catch (err) {
        return { ok: false, error: `No se pudieron guardar los ajustes: ${err.message}` };
    }
});

// ─── Iniciar sesión con Claude ────────────────────────────────────────

// El verificador PKCE de la sesión en curso. En memoria y de a uno: pedir otro
// inicio invalida el anterior, que es lo que uno espera al tocar el botón de
// nuevo.
let claudeVerifier = null;

ipcMain.handle('claude-login-empezar', () => {
    const { url, verifier } = claudeOauth.empezar();
    claudeVerifier = verifier;
    shell.openExternal(url);
    return { ok: true };
});

ipcMain.handle('claude-login-codigo', async (event, pegado) => {
    if (!claudeVerifier) return { ok: false, error: 'Primero tocá «Iniciar sesión» para abrir el navegador.' };
    const res = await claudeOauth.terminar(pegado, claudeVerifier);
    if (res.error) return { ok: false, error: res.error };
    try {
        claves.guardar('anthropic', res.clave);
    } catch (err) {
        return { ok: false, error: `La clave llegó pero el Llavero no la aceptó: ${err.message}` };
    }
    claudeVerifier = null;
    return { ok: true, ajustes: ajustesParaLaVentana() };
});

ipcMain.handle('claude-salir', () => {
    claves.borrar('anthropic');
    return { ok: true, ajustes: ajustesParaLaVentana() };
});

// Prueba una configuración SIN guardarla: el editor primero ve que contesta y
// recién después decide quedársela.
ipcMain.handle('ia-probar', (event, config) => ia.probar(config || {}));

// Los modelos que ofrece el Cursor CLI, para el selector de Ajustes.
ipcMain.handle('cursor-modelos', () => aiCursor.modelos());

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

// Con cuál está corriendo, para el cabezal. Contesta por el proveedor activo
// en Ajustes; el `preferido` solo aplica al local, donde el selector de la
// corrida puede pisar el modelo.
ipcMain.handle('modelo', async (event, preferido) => ia.estado(preferido || null));

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

/** Escanea una carpeta y mide su material, dejándola cargada. */
async function escanearYMedir(folder) {
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
    return result;
}

/**
 * Agrega una carpeta a las que ya están. El escaneo es inmediato; medir con
 * ffprobe tarda (unos 150 ms por clase), así que la tabla se manda primero y las
 * duraciones van llegando.
 *
 * Dos carpetas que se solapan no pueden convivir (ver `engine/carpetas.js`): la
 * respuesta dice qué se reemplazó para que la ventana muestre lo mismo que hay
 * cargado acá.
 */
ipcMain.handle('scan', async (event, folder) => {
    if (!folder || typeof folder !== 'string') {
        return { ok: false, error: 'No llegó ninguna carpeta.' };
    }

    const plan = carpetasLib.fusionar([...carpetas.keys()], folder);
    if (plan.accion === 'cubierta') {
        return {
            ok: false,
            yaCubierta: plan.cubiertaPor,
            error: `Esa carpeta ya está cargada dentro de «${path.basename(plan.cubiertaPor)}».`
        };
    }

    const result = await escanearYMedir(folder);
    if (!result.ok) return result;

    for (const vieja of plan.reemplaza) carpetas.delete(vieja);
    carpetas.set(result.root, result);
    return { ...result, accion: plan.accion, reemplaza: plan.reemplaza };
});

ipcMain.handle('quitar-carpeta', (event, root) => {
    carpetas.delete(carpetasLib.normal(root || ''));
    return { ok: true, cargadas: [...carpetas.keys()] };
});

function classById(id) {
    for (const scan of carpetas.values()) {
        const cls = scan.classes.find(c => c.id === id);
        if (cls) return cls;
    }
    return null;
}

ipcMain.handle('load-review', (event, { id, buckets }) => {
    const cls = classById(id);
    if (!cls) return { ok: false, error: 'Esa clase ya no está cargada. Volvé a agregar la carpeta.' };
    const data = review.loadReview({ root: cls.root, cls, buckets });
    if (data.ok) {
        // El reproductor pide los videos por `clase://`, así que las rutas de
        // esta clase quedan habilitadas al abrirla y no antes. Y SOLO las de
        // esta: sin el borrón, cada clase visitada dejaba las suyas servibles
        // para el resto de la sesión y la lista solo sabía crecer.
        mediaPermitida.clear();
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
    if (!cls) return { ok: false, error: 'Esa clase ya no está cargada.' };
    const res = review.saveReview({ root: cls.root, cls, segments, viewMap });
    // Los bordes que el editor movió a mano son tan poco recalculables como las
    // notas: si se rehace el XML, el archivo de la clase tiene que quedar con
    // ese XML y no con el de antes.
    if (res && res.ok) estadoClase.actualizar({ root: cls.root, cls, claves: ['align', 'cutplan'] });
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
    if (!cls) return { ok: false, error: 'Esa clase ya no está cargada.' };
    try {
        const guardadas = notas.guardar(cls.root, cls.sequenceName, { bloques, comentarios });
        // Y al archivo de la clase, que es el que viaja con la carpeta.
        estadoClase.actualizar({ root: cls.root, cls, claves: ['notas'] });
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
 * Procesa las clases marcadas, de las carpetas que sean. Se vuelve a escanear y
 * a medir antes de empezar: lo que llega de la ventana son ids, no el material —
 * el disco pudo cambiar mientras el editor miraba la tabla.
 */
ipcMain.handle('process', async (event, payload) => {
    const { ids = [], viewMap, force, useAi, model } = payload || {};
    if (currentRun) return { ok: false, error: 'Ya hay un procesamiento en curso.' };

    const wanted = new Set(ids);
    // Las carpetas que tienen algo marcado. Puede ser más de una, y cada clase
    // lleva su raíz, así que el pipeline escribe cada XML donde corresponde.
    const raices = [...carpetas.keys()]
        .filter(root => carpetas.get(root).classes.some(c => wanted.has(c.id)));

    const classes = [];
    for (const root of raices) {
        const scan = scanner.scan(root);
        if (!scan.ok) continue;
        classes.push(...scan.classes.filter(c => wanted.has(c.id)));
    }
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

        // Y se vuelven a leer las carpetas tocadas: acaban de aparecer XML y
        // archivos de estado que la tabla tiene que mostrar como "ya procesada".
        // Sin esto había que salir a "Agregar carpeta" y volver a entrar para
        // que el visor te dejara abrir lo que se acababa de procesar.
        const refrescadas = [];
        for (const root of raices) {
            const fresca = await escanearYMedir(root);
            if (!fresca.ok) continue;
            carpetas.set(root, fresca);
            refrescadas.push(fresca);
        }

        return {
            ok: true,
            cancelled: controller.signal.aborted,
            salidas: raices.map(root => ({ root, dir: workspace.outputRoot(root), nombre: path.basename(root) })),
            carpetas: refrescadas,
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
