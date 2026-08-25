'use strict';
/**
 * carpetas.js — Qué hacer cuando se agrega una carpeta y ya había otras.
 *
 * Se pueden tener varias cargadas a la vez, pero no pueden solaparse: si el
 * editor agregó `Day_1` y después arrastra el curso entero, esas clases están
 * en las dos y aparecerían duplicadas — con dos raíces distintas, dos "The
 * Cutter" distintos y dos filas para el mismo material.
 *
 * La regla es la contención, que es la única relación que importa entre dos
 * carpetas del mismo disco:
 *
 * - La carpeta nueva **contiene** a una cargada → la nueva la reemplaza. Es un
 *   superconjunto: trae esas clases y más.
 * - La carpeta nueva **está dentro** de una cargada → ya está cubierta y no se
 *   agrega. Sus clases ya están en la tabla.
 * - Es la misma → se vuelve a escanear en su lugar, que es lo que uno espera al
 *   volver a arrastrar la misma carpeta: refrescar.
 * - No se tocan → se suma una carpeta más.
 */

const path = require('path');

/** Normaliza para comparar: sin barra final, resuelta. */
function normal(ruta) {
    return path.resolve(String(ruta || ''));
}

/**
 * ¿`hijo` está dentro de `padre`? (o es el mismo)
 *
 * Se compara por segmentos y no con `startsWith`: `/Cursos/Spec` y
 * `/Cursos/Spec-viejo` comparten el prefijo de texto y no tienen nada que ver.
 */
function dentroDe(hijo, padre) {
    const a = normal(hijo);
    const b = normal(padre);
    if (a === b) return true;
    const relativo = path.relative(b, a);
    return Boolean(relativo) && !relativo.startsWith('..') && !path.isAbsolute(relativo);
}

/**
 * Qué hacer con `nueva` dado lo que ya está cargado.
 *
 * @param {string[]} cargadas raíces ya cargadas
 * @param {string} nueva la que se está agregando
 * @returns {{accion: 'agregar'|'refrescar'|'cubierta', reemplaza: string[], cubiertaPor: string|null}}
 *   `reemplaza` son las cargadas que la nueva deja sin sentido.
 */
function fusionar(cargadas, nueva) {
    const raiz = normal(nueva);
    const lista = (cargadas || []).map(normal);

    if (lista.includes(raiz)) {
        return { accion: 'refrescar', reemplaza: [raiz], cubiertaPor: null };
    }

    // Que esté dentro de una cargada se mira primero: si el editor arrastra una
    // clase suelta de un curso que ya está entero en la tabla, la respuesta es
    // "ya la tenés", no "reemplazá el curso por esta clase".
    const padre = lista.find(cargada => dentroDe(raiz, cargada));
    if (padre) return { accion: 'cubierta', reemplaza: [], cubiertaPor: padre };

    const hijas = lista.filter(cargada => dentroDe(cargada, raiz));
    return { accion: 'agregar', reemplaza: hijas, cubiertaPor: null };
}

module.exports = { dentroDe, fusionar, normal };
