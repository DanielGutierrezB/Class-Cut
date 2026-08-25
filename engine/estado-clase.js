'use strict';
/**
 * estado-clase.js — El trabajo hecho, guardado junto al material.
 *
 * Todo lo que produce el pipeline vive en `<raíz>/The Cutter/Backup/`, y esa raíz
 * es la carpeta que el editor arrastró. Ahí está el problema: la misma clase
 * arrastrada de otra manera es una clase nueva. Se procesa el día 1 soltando
 * `Day_1/`, al día siguiente se suelta el curso entero para incluir el día 2, y
 * las trece clases del día 1 aparecen sin procesar —el `The Cutter` con su
 * trabajo quedó dentro de `Day_1/`, que ahora es una subcarpeta—. Una hora de
 * Whisper por delante para volver a obtener exactamente lo mismo.
 *
 * Así que el trabajo también se guarda DENTRO de la carpeta de la clase, al lado
 * del XML del Rodecaster, en un solo archivo. Ahí no depende de por dónde se
 * entre: la carpeta se puede mover, renombrar el día, meter en otro curso, y lo
 * hecho viaja con ella.
 *
 * Y va entero, no una nota que diga "ya se procesó". Un recibo con la fecha
 * evita repetir el trabajo solo mientras el original siga a mano; en cuanto la
 * carpeta se mueve, el recibo apunta a un sitio que ya no existe y el trabajo se
 * perdió igual. Guardarlo completo cuesta medio mega contra los gigas de video
 * que tiene al lado, y a cambio la regla es simple: **mover la carpeta no pierde
 * nada**.
 *
 * Lo que NO hace es sustituir al Backup. El Backup sigue siendo dónde se mira
 * qué pasó en una corrida; esto es de qué parte se puede no volver a empezar.
 */

const fs = require('fs');
const path = require('path');

const workspace = require('./workspace');

const ARCHIVO = 'class-cut.json';
const VERSION = 1;

// Qué se lleva dentro. Son los artefactos que cuestan: el transcript son minutos
// de Whisper, la coherencia son minutos de modelo, y las notas no se pueden
// recalcular porque las escribió una persona.
const GUARDADOS = ['transcript', 'align', 'cutplan', 'coherence', 'silencios', 'notas'];

function ruta(carpeta) {
    return path.join(carpeta, ARCHIVO);
}

/** El estado guardado de una clase, o null si no hay o no se entiende. */
function leer(carpeta) {
    if (!carpeta) return null;
    const datos = workspace.readJson(ruta(carpeta));
    if (!datos || datos.version !== VERSION) return null;
    return datos;
}

/**
 * De qué material se hizo este trabajo.
 *
 * Solo el XML y el Live-Mix: son los dos que, si cambian, invalidan lo hecho. El
 * XML porque trae los marcadores, y el audio porque es lo que se transcribió.
 * Los videos pueden cambiar de nombre o recodificarse sin que nada de esto deje
 * de valer.
 */
function huellas(cls) {
    return {
        xml: cls.xmlPath ? workspace.fingerprint(cls.xmlPath) : null,
        liveMix: cls.liveMixPath ? workspace.fingerprint(cls.liveMixPath) : null
    };
}

/**
 * ¿El trabajo guardado sigue describiendo a este material?
 *
 * @returns {{vale: boolean, porque: string}}
 */
function vigente(estado, cls) {
    if (!estado) return { vale: false, porque: 'No hay trabajo guardado.' };
    if (estado.secuencia !== cls.sequenceName) {
        return { vale: false, porque: 'El XML cambió de nombre de secuencia.' };
    }

    const ahora = huellas(cls);
    const antes = estado.material || {};

    if (ahora.xml && !workspace.sameFingerprint(ahora.xml, antes.xml)) {
        return { vale: false, porque: 'El XML del Rodecaster cambió desde la última vez.' };
    }
    if (ahora.liveMix && !workspace.sameFingerprint(ahora.liveMix, antes.liveMix)) {
        return { vale: false, porque: 'El Live-Mix cambió desde la última vez.' };
    }
    // Antes había audio y ahora no, o al revés: lo guardado no se hizo sobre
    // este material.
    if (Boolean(ahora.liveMix) !== Boolean(antes.liveMix)) {
        return { vale: false, porque: 'El Live-Mix ya no es el mismo archivo.' };
    }

    return { vale: true, porque: '' };
}

/**
 * Guarda el trabajo de una clase dentro de su carpeta.
 *
 * Lee los artefactos del Backup en vez de recibirlos: así guarda exactamente lo
 * que quedó en disco, sin una segunda versión de la verdad que pueda diferir de
 * la que el visor va a leer después.
 *
 * @param {object} params { root, cls, resumen }
 * @returns {{ok: boolean, archivo?: string, error?: string}}
 */
function guardar(params) {
    const { root, cls, resumen } = params;
    if (!cls.folder || !cls.sequenceName) return { ok: false, error: 'La clase no tiene carpeta ni secuencia.' };

    const trabajo = {};
    for (const clave of GUARDADOS) {
        const datos = workspace.readJson(workspace.artifact(root, cls.sequenceName, clave));
        if (datos) trabajo[clave] = datos;
    }

    const estado = {
        version: VERSION,
        secuencia: cls.sequenceName,
        clase: cls.classNumber,
        procesadaEn: new Date().toISOString(),
        app: resumen && resumen.app ? resumen.app : null,
        modelo: resumen && resumen.modelo ? resumen.modelo : null,
        material: huellas(cls),
        // De dónde salió, para poder decirlo en la interfaz. No se usa para
        // encontrar nada: lo que hace falta está acá adentro.
        salida: {
            raiz: root,
            xml: workspace.finalXml(root, cls.sequenceName)
        },
        resumen: resumen && resumen.datos ? resumen.datos : null,
        trabajo
    };

    try {
        workspace.writeJson(ruta(cls.folder), estado);
        return { ok: true, archivo: ruta(cls.folder) };
    } catch (err) {
        // Que no se pueda escribir en la carpeta del curso no puede tumbar una
        // corrida que ya terminó bien: el XML está y el Backup también.
        return { ok: false, error: err.message };
    }
}

/**
 * Devuelve al Backup de esta raíz el trabajo que la clase trae guardado.
 *
 * Es lo que hace que procesar desde otra carpeta no vuelva a empezar. En vez de
 * enseñarle a cada etapa a buscar en dos sitios, se deja el Backup como si la
 * clase ya se hubiera procesado acá y el resto del pipeline sigue igual: el
 * transcript lo encuentra su caché, el visor encuentra el alineado.
 *
 * No pisa lo que ya esté: si en esta raíz hay un artefacto, es de una corrida
 * más reciente que lo guardado.
 *
 * @returns {{restaurados: string[], desde: string|null}}
 */
function hidratar(params) {
    const { root, cls } = params;
    const estado = leer(cls.folder);
    const restaurados = [];
    if (!estado || !estado.trabajo) return { restaurados, desde: null };
    if (!vigente(estado, cls).vale) return { restaurados, desde: null };

    for (const clave of GUARDADOS) {
        const datos = estado.trabajo[clave];
        if (!datos) continue;
        const destino = workspace.artifact(root, cls.sequenceName, clave);
        if (fs.existsSync(destino)) continue;
        try {
            workspace.writeJson(destino, datos);
            restaurados.push(clave);
        } catch (e) { /* lo que no se pueda restaurar se vuelve a calcular */ }
    }

    return { restaurados, desde: estado.procesadaEn };
}

/**
 * Le da su archivo a una clase que se procesó antes de que esto existiera.
 *
 * El trabajo de esas clases está entero en el `Backup` de la raíz por la que se
 * procesaron, y hasta que no se vuelva a procesar no tendrían archivo propio: es
 * decir, seguirían perdiéndose al mover la carpeta, que es justo lo que hay que
 * evitar. Se rescata al escanear, una sola vez por clase.
 *
 * Solo si hay un plan de cortes: es lo que prueba que la clase llegó al final.
 * Un Backup a medias, de una corrida cancelada, no es trabajo que valga guardar.
 *
 * @returns {boolean} si escribió el archivo
 */
function rescatar(params) {
    const { root, cls } = params;
    if (!cls.folder || !cls.sequenceName) return false;
    if (leer(cls.folder)) return false;
    if (!fs.existsSync(workspace.artifact(root, cls.sequenceName, 'cutplan'))) return false;
    return guardar({ root, cls, resumen: {} }).ok;
}

/**
 * Mete al archivo guardado lo que acaba de cambiar en el Backup.
 *
 * Existe por las notas. Se escriben después de procesar, cuando alguien revisa,
 * y son lo único de todo esto que no se puede volver a calcular: si el archivo
 * se quedara con las de la corrida, mover la carpeta perdería justo lo que costó
 * una persona. Reescribe el archivo entero, que son un par de milisegundos.
 *
 * Si la clase nunca se procesó no hace nada: esto actualiza un estado, no lo
 * inventa.
 *
 * @param {object} params { root, cls, claves }
 */
function actualizar(params) {
    const { root, cls, claves } = params;
    const estado = leer(cls.folder);
    if (!estado) return { ok: false, error: 'Esta clase no tiene trabajo guardado.' };

    const trabajo = { ...(estado.trabajo || {}) };
    for (const clave of claves || GUARDADOS) {
        if (!GUARDADOS.includes(clave)) continue;
        const datos = workspace.readJson(workspace.artifact(root, cls.sequenceName, clave));
        if (datos) trabajo[clave] = datos;
    }

    try {
        workspace.writeJson(ruta(cls.folder), { ...estado, trabajo });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Cuánto dura la clase ya cortada, según el plan que quedó guardado.
 *
 * Sale del cutplan y no de una copia en el resumen a propósito: el visor puede
 * mover bordes y regenerar el XML, y ahí `actualizar(['align','cutplan'])`
 * reescribe el plan. Una copia del número en otro sitio se quedaría con la
 * duración de la corrida original y la tabla mostraría un corte que ya no
 * existe.
 */
function duracionFinal(estado) {
    const plan = estado && estado.trabajo && estado.trabajo.cutplan;
    const total = plan && plan.totals ? plan.totals.keepSec : null;
    return typeof total === 'number' ? total : null;
}

/**
 * Lo que la interfaz necesita saber de una clase sin cargar el trabajo entero.
 * @returns {{procesada: boolean, procesadaEn: string|null, vale: boolean, porque: string,
 *   modelo: string|null, duracionFinalSec: number|null, msProceso: number|null}|null}
 */
function resumen(cls) {
    const estado = leer(cls.folder);
    if (!estado) return null;
    const estaVigente = vigente(estado, cls);
    const datos = estado.resumen || {};
    return {
        procesada: true,
        procesadaEn: estado.procesadaEn || null,
        vale: estaVigente.vale,
        porque: estaVigente.porque,
        modelo: estado.modelo || null,
        clase: estado.clase == null ? null : estado.clase,
        duracionFinalSec: duracionFinal(estado),
        // Lo único de la corrida que no se puede recalcular mirando el disco: si
        // no se guarda, se pierde. Las clases rescatadas de antes de que esto
        // existiera no lo tienen, y por eso puede ser null y la tabla lo omite
        // en vez de mostrar un cero.
        msProceso: typeof datos.msProceso === 'number' ? datos.msProceso : null,
        tokens: datos.tokens || null,
        bloques: typeof datos.bloques === 'number' ? datos.bloques : null
    };
}

module.exports = {
    ARCHIVO, VERSION, GUARDADOS,
    ruta, leer, guardar, actualizar, rescatar, hidratar, vigente, huellas, resumen, duracionFinal
};
