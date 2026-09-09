'use strict';
/**
 * La lista de tomas de la grabación en vivo.
 *
 * Lo comprobable sin abrir la app es la cuenta que decide dónde queda el
 * marcador de un comentario: a qué horas del día se enganchó lo que se
 * seleccionó. El resto —que seleccionar abra la caja, que el clic derecho
 * pregunte— es DOM y se verificó con el arnés.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Un `<span>` como los que dibuja la lista, con lo único que se le mira. */
function span(ms, texto) {
    return { dataset: { t: String(ms) }, textContent: texto };
}

/**
 * Una selección de mentira sobre un contenedor de mentira.
 *
 * `intersectsNode` es lo que decide qué palabras entraron, así que acá se dice a
 * mano cuáles: es lo que el navegador contestaría. Deja el `window` falso puesto;
 * `conSeleccion` lo saca al terminar.
 */
function seleccionar(spans, elegidos, params) {
    const p = params || {};
    const contenedor = {
        querySelectorAll: () => spans,
        contains: () => p.adentro !== false
    };
    globalThis.window = {
        getSelection: () => ({
            isCollapsed: Boolean(p.vacia),
            rangeCount: p.sinRango ? 0 : 1,
            getRangeAt: () => ({
                commonAncestorContainer: {},
                intersectsNode: nodo => elegidos.includes(nodo)
            })
        })
    };
    return contenedor;
}

/**
 * Corre una prueba y restaura el `window` que hubiera antes. Todas las pruebas
 * corren en un proceso, y las que vienen después no pueden encontrarse con un
 * `window` de mentira que solo sabe `getSelection`.
 */
function conSeleccion(cuerpo) {
    const habia = globalThis.window;
    try {
        cuerpo();
    } finally {
        if (habia === undefined) delete globalThis.window;
        else globalThis.window = habia;
    }
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const tomas = await import(src('grabar/tomas.js'));
    const formato = await import(src('formato.js'));

    t.group('tomas en vivo · la hora del día en pantalla');

    t.test('se muestra la hora, que es lo que el editor compara con su reloj', () => {
        const ms = new Date(2026, 8, 4, 15, 7, 3).getTime();
        t.eq(formato.fmtHora(ms), '15:07:03');
    });

    t.test('sin hora no se inventa una', () => {
        t.eq(formato.fmtHora(null), '—');
    });

    t.group('tomas en vivo · comentar un pedazo del texto');

    const PALABRAS = [
        span(1000000, 'Piensa'),
        span(1000400, 'en'),
        span(1000900, 'el'),
        span(1001500, 'prompt'),
        span(1002100, 'que')
    ];

    t.test('el comentario abarca de la primera a la última palabra elegida', () => conSeleccion(() => {
        const donde = seleccionar(PALABRAS, [PALABRAS[1], PALABRAS[2], PALABRAS[3]]);
        const s = tomas.seleccion(donde);
        t.eq(s.desdeMs, 1000400);
        t.eq(s.hastaMs, 1001500);
        t.eq(s.texto, 'en el prompt');
    }));

    t.test('el final es el ARRANQUE de la última palabra, no su final', () => conSeleccion(() => {
        // Es la misma convención que el visor de cortes (`anclaDeSeleccion` en
        // `comentarios.js`) y por el mismo motivo: el final de una palabra es el
        // arranque de la siguiente, así que tomarlo estiraría el marcador hasta
        // una palabra que nadie seleccionó.
        const donde = seleccionar(PALABRAS, [PALABRAS[0], PALABRAS[1]]);
        t.eq(tomas.seleccion(donde).hastaMs, 1000400, 'la hora de "en", no la de "el"');
    }));

    t.test('una palabra sola también se puede comentar', () => conSeleccion(() => {
        const donde = seleccionar(PALABRAS, [PALABRAS[3]]);
        const s = tomas.seleccion(donde);
        t.eq(s.desdeMs, s.hastaMs, 'el marcador queda de un punto');
        t.eq(s.texto, 'prompt');
    }));

    t.test('sin seleccionar nada no hay comentario', () => conSeleccion(() => {
        t.eq(tomas.seleccion(seleccionar(PALABRAS, [], { vacia: true })), null);
        t.eq(tomas.seleccion(seleccionar(PALABRAS, [], { sinRango: true })), null);
        t.eq(tomas.seleccion(seleccionar(PALABRAS, [])), null, 'ninguna palabra tocada');
    }));

    t.test('una selección de otra parte de la pantalla no cuenta', () => conSeleccion(() => {
        // Si no se mirara, seleccionar el título de la columna de al lado abriría
        // una caja de comentario colgada de la toma que estuviera primera.
        const donde = seleccionar(PALABRAS, [PALABRAS[0]], { adentro: false });
        t.eq(tomas.seleccion(donde), null);
    }));
};
