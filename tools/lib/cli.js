'use strict';
/**
 * cli.js — Lo que comparten las herramientas de línea de comandos.
 *
 * Cada herramienta tenía su `arg()` y su formateador de tiempo, y no coincidían:
 * una entendía `--clase=2`, otra `--parte archivo`, y dos funciones llamadas
 * igual formateaban cosas distintas (una hora del día, una duración). Acá hay
 * una de cada, con nombre que dice qué es.
 */

/**
 * El valor de una bandera, escrita como `--nombre=valor` o `--nombre valor`.
 *
 * Las dos formas, porque las herramientas viejas se llaman de las dos maneras y
 * un lote que corre cuatro horas no se vuelve a lanzar por un `=`.
 *
 * @param {string} nombre con o sin los dos guiones
 */
function arg(nombre, porDefecto) {
    const clave = nombre.startsWith('--') ? nombre : `--${nombre}`;
    const pegado = process.argv.find(a => a.startsWith(`${clave}=`));
    if (pegado) return pegado.slice(clave.length + 1);
    const i = process.argv.indexOf(clave);
    return i === -1 || i + 1 >= process.argv.length ? porDefecto : process.argv[i + 1];
}

/** La hora del día de un instante en ms: "15:07:03". */
function horaDelDia(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Una duración en segundos, corta: "1:35", "41:56". */
function mmss(seg) {
    const s = Math.max(0, Math.round(seg));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Una duración en ms, para leerla en un parte: "4m 05s", "1h 4m 05s". */
function tardo(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return (h ? `${h}h ` : '') + `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

module.exports = { arg, horaDelDia, mmss, tardo };
