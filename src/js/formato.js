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
