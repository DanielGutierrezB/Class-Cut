'use strict';
/** Números y texto tal como se leen en pantalla. Nada acá toca el DOM. */

/** Una duración: "41:56", "1:12:03". */
export function fmtDur(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Un momento dentro de la clase: "07:32". */
export function fmtClock(seconds) {
    if (seconds == null) return '—';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return h ? `${h}:${base}` : base;
}

/**
 * La hora del día de un instante en milisegundos: "15:07:03".
 *
 * Es lo que se muestra en la toma de notas en vivo, donde todo va con la hora
 * del día: el editor la compara contra su reloj, no contra el arranque de nada.
 */
export function fmtHora(ms) {
    if (ms == null) return '—';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * Con qué clase se pinta el cartelito de una vista, en las pantallas de después.
 *
 * Solo `PV` y `R` tienen color propio acá, y es a propósito: son las dos
 * etiquetas de clip del XML (`CLIP_LABELS` en `fcp-xml.js`) y los dos `.cam-N`
 * del reproductor, así que ese color ya está diciendo de qué fuente salió el
 * bloque que se está mirando. Las demás vistas no salen de una tercera fuente
 * —`S`, `MG` y `X2` se graban con el grabador de pantalla, igual que `R`—, así
 * que pintarlas de otro color sería inventar una fuente que no existe, y
 * pintarlas de rosa sería decir que son `R`. Van neutras, con su nombre escrito.
 *
 * Ojo: esto NO es lo mismo que el color de la lista de tomas de Grabar, donde
 * cada vista tiene el suyo (`colorEnLaApp` en `engine/notas-vivo.js`). Allá la
 * pregunta es qué eligió el director; acá, con qué se grabó. Vivía escrito en
 * tres pantallas y dos se habían quedado con la respuesta de cuando las vistas
 * eran dos: un bloque `S` salía rosa, o sea con el nombre de una vista y el
 * color de otra.
 */
export function claseDeVista(nombre) {
    if (nombre === 'PV') return 'badge-pv';
    return nombre === 'R' ? 'badge-r' : 'badge-info';
}

/**
 * Dónde está una carpeta, en una línea que se pueda leer de un vistazo:
 * "/Volumes/Trabajo/…/2026".
 *
 * Se pliega por el MEDIO y no por el final, que es lo que hace un `text-overflow`
 * y es justo al revés de lo que sirve. Los dos extremos son los que dicen algo:
 * la cabeza es de qué disco se trata —el externo que hay que enchufar, o la Mac—
 * y la cola es el nido en el que está. El medio es lo repetido: todos los cursos
 * de alguien viven abajo de las mismas cuatro carpetas, así que una lista cortada
 * por el final son seis renglones que empiezan igual y no terminan nunca.
 *
 * Dos de cabeza y UNO de cola, no dos y dos. Con dos de cola la línea le seguía
 * ganando al ancho que tiene en la fila y el navegador la recortaba por el final
 * otra vez, o sea que se plegaba por el medio para después perder igual la cola:
 * lo peor de las dos. Plegar de más y que entre es mejor que plegar de menos y
 * que lo corte otro, porque el que corta no elige por dónde.
 *
 * El último tramo —el nombre del curso, que es lo que distingue dos— no va acá:
 * se muestra aparte y entero, porque es lo único que nunca se puede plegar.
 */
export function rutaPlegada(ruta, cabeza = 2, cola = 1) {
    const texto = String(ruta || '');
    const partes = texto.split('/').filter(Boolean);
    if (!partes.length) return texto;
    const raiz = texto.startsWith('/') ? '/' : '';
    if (partes.length <= cabeza + cola) return raiz + partes.join('/');
    return raiz + [...partes.slice(0, cabeza), '…', ...partes.slice(-cola)].join('/');
}

/**
 * Cuánto tardó algo, en milisegundos: "8,4 s", "4:12", "1:12:03".
 *
 * Aparte de `fmtDur` porque abajo del minuto la diferencia importa: una etapa
 * que tardó 800 ms y otra que tardó 40 s salían las dos como "0:01" y "0:40",
 * y la primera se leía como un segundo entero.
 */
export function fmtMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
    return fmtDur(ms / 1000);
}

/**
 * Una cantidad de tokens: "812", "31,4k", "1,2M".
 *
 * Se abrevia porque los números de verdad son grandes —una consulta al Cursor
 * CLI arrastra ~31k solo del prompt del propio CLI— y "31365" en una celda de
 * tabla no se lee de un vistazo. El número exacto va en el globito.
 */
export function fmtTokens(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`;
    return `${(n / 1000000).toFixed(2).replace('.', ',')}M`;
}

/**
 * Cuánto falta: "~4 min", "~1 h 20 min", "menos de 1 min".
 *
 * Redondeado a propósito y con el "~" adelante: un estimado con segundos
 * ("faltan 4:07") se lee como una promesa, y esto es una proyección de lo que
 * se midió hasta recién. Null es null: si no hay con qué estimar, no se muestra
 * nada — mejor callarse que inventar un número.
 */
export function fmtFalta(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 60000) return 'menos de 1 min';
    const minutos = Math.round(ms / 60000);
    if (minutos < 60) return `~${minutos} min`;
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `~${horas} h ${resto} min` : `~${horas} h`;
}
