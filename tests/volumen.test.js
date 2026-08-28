'use strict';
/**
 * La escala del volumen de «Ver la clase».
 *
 * Lo que se prueba acá es la cuenta, que es donde está el riesgo silencioso:
 * `video.volume` topa en 1 por especificación —asignarle 1,5 no tira, se guarda
 * 1— así que un número mal traducido no falla, simplemente no sube y el editor
 * cree que el control no anda. El grafo de Web Audio y el sonido de verdad se
 * verifican con el arnés, no con dobles.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'volumen.js')).href);
}

module.exports = async t => {
    const vol = await cargar();

    t.group('el volumen de la clase · la escala');

    t.test('el 100% es el nivel del archivo, sin tocar nada', () => {
        t.eq(vol.gananciaDe(100), 1);
        t.eq(vol.volumenDelElemento(100), 1);
        t.eq(vol.puedeSaturar(100), false, 'en el tope del sistema todavía no satura');
    });

    t.test('arriba del 100% la ganancia sube y el elemento se queda en 1', () => {
        // Es la razón de existir del grafo: pedirle 1,5 al elemento es pedirle 1.
        t.eq(vol.gananciaDe(150), 1.5);
        t.eq(vol.volumenDelElemento(150), 1);
        t.eq(vol.puedeSaturar(150), true);
    });

    t.test('abajo del 100% las dos vías dan lo mismo', () => {
        // Ahí no hace falta grafo ninguno, y por eso no se arma.
        t.eq(vol.gananciaDe(40), 0.4);
        t.eq(vol.volumenDelElemento(40), 0.4);
        t.eq(vol.puedeSaturar(40), false);
    });

    t.test('nada pasa del máximo ni baja de cero', () => {
        t.eq(vol.porcentajeValido(400), vol.MAXIMO);
        t.eq(vol.porcentajeValido(-20), 0);
        t.eq(vol.gananciaDe(400), vol.MAXIMO / 100);
    });

    t.test('lo que viene del almacenamiento es texto, y puede ser basura', () => {
        // `localStorage` devuelve strings, y de una versión anterior puede volver
        // cualquier cosa. Sin esto, `gain.value = NaN` deja la clase muda.
        t.eq(vol.porcentajeValido('130'), 130);
        t.eq(vol.porcentajeValido('nada'), 100, 'lo ilegible vuelve al de fábrica');
        t.eq(vol.porcentajeValido(null), 100);
        t.eq(vol.porcentajeValido(undefined), 100);
        t.eq(vol.porcentajeValido(NaN), 100);
        t.ok(Number.isFinite(vol.gananciaDe('nada')));
    });

    t.test('el porcentaje que se muestra es entero', () => {
        // El deslizador va de a 5, pero un valor guardado a mano no tiene por
        // qué: "127,4%" en la barra no dice más que "127%" y ocupa más.
        t.eq(vol.porcentajeValido(127.4), 127);
        t.eq(vol.porcentajeValido(99.6), 100);
    });
};
