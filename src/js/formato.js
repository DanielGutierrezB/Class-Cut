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
