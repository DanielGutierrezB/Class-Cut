'use strict';
/**
 * seleccion.js — Qué palabras abarca lo que el editor dejó seleccionado.
 *
 * Tres pantallas dejan comentar seleccionando texto —el guion del visor, el
 * panel de letra al lado del video y las tomas en vivo— y las tres necesitan lo
 * mismo: los `span` de palabra que la selección toca, en orden. Qué hacer con
 * ellos (a qué bloque pertenecen, qué hora tienen) es de cada una, porque cada
 * una guarda en sus `span` una cosa distinta.
 */

/**
 * @param {Element} raiz dónde tienen que estar las palabras
 * @param {string} selector el de los `span` de palabra de esa pantalla
 * @returns {Element[]} vacío si no hay selección, o si cae fuera de `raiz`
 */
export function spansSeleccionados(raiz, selector) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const rango = sel.getRangeAt(0);
    // Una selección que arranca en otra parte de la pantalla no es de acá:
    // abriría una caja de comentario sobre palabras que nadie eligió.
    if (!raiz.contains(rango.commonAncestorContainer)) return [];
    return [...raiz.querySelectorAll(selector)].filter(span => rango.intersectsNode(span));
}
