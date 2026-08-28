'use strict';
/**
 * Comentar sobre el guion leído de corrido.
 *
 * Lo comprobable sin abrir la app son las dos cuentas que deciden si el
 * comentario queda bien puesto: a qué palabras se enganchó lo que se seleccionó,
 * y a qué altura va cada tarjeta del margen. Lo demás —que seleccionar abra la
 * caja, que pasar por encima encienda la tarjeta— es DOM y se verificó con el
 * arnés contra el curso real.
 */

const path = require('path');
const { pathToFileURL } = require('url');

async function cargar(archivo) {
    return import(pathToFileURL(
        path.join(__dirname, '..', 'src', 'js', 'visor', archivo)).href);
}

/** Un `<span>` como los que dibuja el guion, con lo único que se le mira. */
function span(bloque, palabra) {
    return { dataset: { b: String(bloque), p: String(palabra) } };
}

module.exports = async t => {
    const guion = await cargar('guion.js');
    const comentarios = await cargar('comentarios.js');
    const traducir = guion.traducirTexto;

    const PALABRAS = {
        0: [
            { start: 10.0, text: 'El' },
            { start: 10.4, text: 'Bitcoin' },
            { start: 10.9, text: 'está' },
            { start: 11.3, text: 'muy' },
            { start: 11.6, text: 'bien.' }
        ],
        1: [
            { start: 30.0, text: 'Vamos' },
            { start: 30.5, text: 'a' },
            { start: 30.7, text: 'entender.' }
        ]
    };
    const bloqueDe = i => PALABRAS[i] || null;

    t.group('guion · a qué se engancha lo seleccionado');

    t.test('las palabras que tocó la selección, en orden', () => {
        const elegidas = guion.palabrasSeleccionadas(
            [span(0, 1), span(0, 2), span(0, 3)], bloqueDe);
        t.deep(elegidas.map(p => p.text), ['Bitcoin', 'está', 'muy']);
    });

    t.test('cruzar dos bloques se queda con el primero', () => {
        // Un comentario que abarca dos bloques no tiene un ancla claro: entre
        // los dos puede haber material que se cortó, así que el marcador saldría
        // cubriendo algo que en la clase no está.
        const elegidas = guion.palabrasSeleccionadas(
            [span(0, 3), span(0, 4), span(1, 0), span(1, 1)], bloqueDe);
        t.deep(elegidas.map(p => p.text), ['muy', 'bien.']);
    });

    t.test('sin selección o sobre un bloque sin palabras, nada', () => {
        t.eq(guion.palabrasSeleccionadas([], bloqueDe), null);
        t.eq(guion.palabrasSeleccionadas([span(9, 0)], bloqueDe), null);
    });

    t.test('el ancla va del arranque de la primera al de la última', () => {
        // El final es el ARRANQUE de la última palabra: su `end`, en el reloj del
        // DTW, es el arranque de la SIGUIENTE, y tomarlo estiraría el marcador
        // hasta una palabra que nadie seleccionó.
        const ancla = comentarios.anclaDeSeleccion(
            guion.palabrasSeleccionadas([span(0, 1), span(0, 2)], bloqueDe));
        t.eq(ancla.sourceStartSec, 10.4);
        t.eq(ancla.sourceEndSec, 10.9);
        t.eq(ancla.texto, 'Bitcoin está');
    });

    t.test('sin palabras no hay ancla que inventar', () => {
        t.eq(comentarios.anclaDeSeleccion(null), null);
        t.eq(comentarios.anclaDeSeleccion([]), null);
    });

    t.group('guion · el número de bloque es el mismo en toda la app');

    // Una clase donde se apagó un bloque: el guion numera entre los que quedaron
    // y la lista de cortes entre todos, así que a partir de ahí van corridos.
    // Pasa en 4 de las 13 clases del curso.
    const MAPA = new Map([[12, 13], [8, 9], [9, 10]]);

    t.test('el texto de la IA se traduce a la numeración que se ve', () => {
        // La mitad de los hallazgos del curso citan un bloque por su número, así
        // que cambiar el rótulo sin tocar el texto haría que la explicación
        // señale al bloque equivocado.
        t.eq(traducir('Repite el cierre del bloque 12.', MAPA),
            'Repite el cierre del bloque 13.');
    });

    t.test('también cuando cita varios', () => {
        t.eq(traducir('repite el cierre de los bloques 8 y 9', MAPA),
            'repite el cierre de los bloques 9 y 10');
        t.eq(traducir('los bloques 8, 9 y 12 dicen lo mismo', MAPA),
            'los bloques 9, 10 y 13 dicen lo mismo');
    });

    t.test('un número que no es un bloque no se toca', () => {
        // Los conteos de toma y las duraciones están llenos de números sueltos.
        t.eq(traducir('dice "3, 2, 1" y son 12 segundos', MAPA),
            'dice "3, 2, 1" y son 12 segundos');
    });

    t.test('sin bloques apagados no se traduce nada', () => {
        // El caso normal: nueve de trece clases. Sin mapa, el texto sale igual.
        t.eq(traducir('Repite el cierre del bloque 12.', new Map()),
            'Repite el cierre del bloque 12.');
    });

    t.group('guion · a qué altura va cada tarjeta del margen');

    t.test('cada una a la altura de lo que comenta', () => {
        t.deep(guion.acomodarMargen([60, 60], [0, 400]), [0, 400]);
    });

    t.test('las que chocan se empujan hacia abajo', () => {
        // Dos comentarios sobre frases vecinas piden casi el mismo alto; sin
        // empujar, el de arriba queda tapado y no se puede leer.
        t.deep(guion.acomodarMargen([60, 60, 60], [0, 20, 40]), [0, 68, 136]);
    });

    t.test('empuja para abajo y nunca para arriba', () => {
        // Subir una tarjeta la pondría ANTES que su cita, y entonces el orden de
        // las tarjetas dejaría de ser el orden en que se lee la clase.
        const puestas = guion.acomodarMargen([40, 40], [200, 210]);
        t.eq(puestas[0], 200, 'la primera se queda donde pidió');
        t.eq(puestas[1] >= puestas[0] + 40, true, 'y la segunda entra abajo, sin pisarla');
    });

    t.test('una tarjeta alta corre a la que sigue lo que haga falta', () => {
        t.deep(guion.acomodarMargen([200, 30], [0, 50]), [0, 208]);
    });

    t.test('sin comentarios no se cae', () => {
        t.deep(guion.acomodarMargen([], []), []);
    });
};
