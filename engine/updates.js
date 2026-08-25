'use strict';
/**
 * updates.js — Si hay una versión nueva, y cómo bajarla.
 *
 * No usa `electron-updater` a propósito. Ese instala solo, pero en macOS el paso
 * de instalación valida que la firma del build nuevo case con la de la app que
 * está corriendo, y sin un Developer ID de Apple la firma es ad-hoc: su
 * identificador cambia en cada compilación y la validación falla. Antes que un
 * botón que a veces no hace nada, esto baja el PKG y se lo abre al editor, que
 * hace clic en Continuar como cualquier instalador de Mac.
 *
 * El PKG que se baja es el de actualización —solo la app, ~120 MB—, no el
 * completo: los modelos ya están instalados fuera del `.app` y ahí se quedan
 * (ver `tools/build-pkg.sh` y `paths.dataDirs`).
 *
 * Nada de esto puede tumbar la app: sin internet, sin releases publicados o con
 * GitHub caído, se devuelve "no hay nada nuevo" y la app sigue cortando clases.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULTS = {
    owner: 'DanielGutierrezB',
    // Los releases viven en el mismo repo que el código. Tenerlos aparte tendría
    // sentido si el código fuera privado y solo los instaladores públicos; acá
    // los dos son públicos, así que un segundo repo sería una cosa más que
    // mantener y otro sitio donde equivocarse de nombre.
    repo: 'Class-Cut',
    timeoutMs: 8000,
    // Las pruebas y el banco de interfaz lo apuntan a un servidor local, para
    // probar el camino de verdad —IPC, HTTP, descarga— sin publicar un release.
    _base: process.env.CLASSCUT_UPDATE_BASE || 'https://api.github.com'
};

/** http o https según la url, que en las pruebas no es la de GitHub. */
const agente = url => (String(url).startsWith('https:') ? https : http);

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/**
 * Compara dos versiones tipo 1.2.10.
 *
 * @returns {number} negativo si `a` es anterior, 0 si son la misma, positivo si posterior
 */
function compare(a, b) {
    const parse = v => String(v || '')
        .trim()
        .replace(/^v/i, '')
        // Un sufijo tipo "-beta.2" no participa: acá solo se decide si hay algo
        // más nuevo, y para eso alcanzan los números.
        .split('-')[0]
        .split('.')
        .map(n => parseInt(n, 10) || 0);

    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const diff = (x[i] || 0) - (y[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

/** El PKG de actualización de un release, que es el único que nos sirve. */
function updateAsset(release) {
    const assets = (release && release.assets) || [];
    return assets.find(a => /-update\.pkg$/i.test(a.name || ''))
        || assets.find(a => /\.pkg$/i.test(a.name || ''))
        || null;
}

function getJson(url, options) {
    return new Promise((resolve, reject) => {
        const request = agente(url).get(url, {
            headers: {
                // GitHub rechaza los pedidos sin User-Agent con un 403 escueto.
                'User-Agent': 'Class-Cut',
                Accept: 'application/vnd.github+json'
            },
            timeout: opt(options, 'timeoutMs')
        }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`GitHub respondió ${response.statusCode}`));
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('respuesta ilegible')); }
            });
        });
        request.on('timeout', () => request.destroy(new Error('GitHub no contestó a tiempo')));
        request.on('error', reject);
    });
}

/**
 * ¿Hay algo más nuevo que lo que corre ahora?
 *
 * @param {object} params { currentVersion, owner, repo }
 * @returns {Promise<{hay:boolean, version?:string, notas?:string, url?:string, tamañoBytes?:number, motivo?:string}>}
 */
async function check(params) {
    const current = (params && params.currentVersion) || '0.0.0';
    const url = `${opt(params, '_base')}/repos/${opt(params, 'owner')}/${opt(params, 'repo')}/releases/latest`;

    let release;
    try {
        release = await getJson(url, params);
    } catch (err) {
        return { hay: false, motivo: `No se pudo consultar si hay novedades: ${err.message}` };
    }

    const version = String(release.tag_name || release.name || '').replace(/^v/i, '');
    if (!version) return { hay: false, motivo: 'El último release no tiene versión.' };
    if (compare(version, current) <= 0) {
        return { hay: false, version, motivo: 'Ya estás en la última versión.' };
    }

    const asset = updateAsset(release);
    if (!asset) {
        return { hay: false, version, motivo: `La versión ${version} está publicada pero sin instalador.` };
    }

    return {
        hay: true,
        version,
        notas: release.body || '',
        url: asset.browser_download_url,
        nombre: asset.name,
        tamañoBytes: asset.size || 0
    };
}

/** Sigue las redirecciones de GitHub hasta el archivo de verdad. */
function openStream(url, options, saltos) {
    const restantes = saltos == null ? 5 : saltos;
    return new Promise((resolve, reject) => {
        const request = agente(url).get(url, {
            headers: { 'User-Agent': 'Class-Cut' },
            timeout: opt(options, 'timeoutMs')
        }, response => {
            const { statusCode, headers } = response;
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (!restantes) { reject(new Error('demasiadas redirecciones')); return; }
                openStream(headers.location, options, restantes - 1).then(resolve, reject);
                return;
            }
            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`la descarga respondió ${statusCode}`));
                return;
            }
            resolve(response);
        });
        request.on('timeout', () => request.destroy(new Error('la descarga se quedó sin respuesta')));
        request.on('error', reject);
    });
}

/**
 * Baja el instalador.
 *
 * Escribe a un archivo temporal y recién al final lo renombra: si se corta la
 * conexión a mitad, lo que queda no es un PKG a medias que el editor pueda
 * abrir por error.
 *
 * @param {object} params { url, destDir, nombre, onProgress, signal }
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
async function download(params) {
    const { url, destDir, onProgress, signal } = params;
    const nombre = params.nombre || 'ClassCut-update.pkg';
    const destino = path.join(destDir, nombre);
    const parcial = `${destino}.parcial`;

    let response;
    try {
        response = await openStream(url, params);
    } catch (err) {
        return { ok: false, error: `No se pudo descargar: ${err.message}` };
    }

    const total = Number(response.headers['content-length']) || 0;
    let bajado = 0;
    let ultimoAviso = 0;

    try {
        fs.mkdirSync(destDir, { recursive: true });
        await new Promise((resolve, reject) => {
            const salida = fs.createWriteStream(parcial);
            const cortar = err => {
                response.destroy();
                salida.destroy();
                reject(err);
            };

            if (signal) {
                if (signal.aborted) { cortar(new Error('cancelado')); return; }
                signal.addEventListener('abort', () => cortar(new Error('cancelado')), { once: true });
            }

            response.on('data', chunk => {
                bajado += chunk.length;
                // Un aviso por cada punto porcentual: redibujar la barra con cada
                // bloque de 64 KB son miles de mensajes para 120 MB.
                const percent = total ? Math.floor((bajado / total) * 100) : 0;
                if (onProgress && percent > ultimoAviso) {
                    ultimoAviso = percent;
                    onProgress({ percent, bajado, total });
                }
            });
            response.on('error', cortar);
            salida.on('error', cortar);
            salida.on('finish', resolve);
            response.pipe(salida);
        });
    } catch (err) {
        try { fs.unlinkSync(parcial); } catch (e) { /* no llegó a existir */ }
        return { ok: false, error: err.message === 'cancelado' ? 'Descarga cancelada.' : `No se pudo descargar: ${err.message}` };
    }

    if (total && bajado !== total) {
        try { fs.unlinkSync(parcial); } catch (e) { /* ya no está */ }
        return { ok: false, error: 'La descarga llegó incompleta.' };
    }

    try {
        fs.renameSync(parcial, destino);
    } catch (err) {
        return { ok: false, error: `No se pudo guardar el instalador: ${err.message}` };
    }
    return { ok: true, path: destino };
}

module.exports = { check, download, compare, updateAsset, DEFAULTS };
