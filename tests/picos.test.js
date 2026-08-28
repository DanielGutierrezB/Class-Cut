'use strict';
/**
 * Recortar la onda de la clase entera al pedazo de cada bloque.
 *
 * Es la cuenta que decide si la silueta que se ve abajo de un clip es la de ese
 * clip o la de otro momento de la grabación. Y ese error no se ve: una onda
 * corrida sigue pareciendo una onda, así que el editor aprobaría un corte
 * mirando el audio de un bloque distinto. Lógica pura, se prueba sin ventana.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'picos.js')).href);
}

module.exports = async t => {
    const picos = await cargar();

    t.group('la onda de un bloque · recortar lo ya medido');

    // Diez cubos para cien segundos: cada uno cubre diez segundos justos, así
    // que los índices se pueden leer a ojo en cada aserción.
    const diez = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

    t.test('un tramo alineado con los cubos trae exactamente los suyos', () => {
        t.deep(picos.recortarPicos(diez, 100, 20, 50), [0.2, 0.3, 0.4]);
    });

    t.test('la entrada se redondea para abajo y la salida para arriba', () => {
        // De 25 a 45 toca los cubos 2, 3 y 4. Recortando por dentro se perdería
        // el arranque del sonido, que es justo lo que se mira en un borde.
        t.deep(picos.recortarPicos(diez, 100, 25, 45), [0.2, 0.3, 0.4]);
    });

    t.test('un tramo más corto que un cubo igual da algo dibujable', () => {
        // Pasa con los bloques de un segundo y medio: sin esto la onda del
        // bloque desaparece, que se lee como que faltan datos.
        t.deep(picos.recortarPicos(diez, 100, 31, 32), [0.3]);
    });

    t.test('no se sale de la grabación por los dos lados', () => {
        t.deep(picos.recortarPicos(diez, 100, -50, 10), [0]);
        t.deep(picos.recortarPicos(diez, 100, 95, 400), [0.9]);
    });

    t.test('un tramo invertido no rompe: da un cubo, no una lista vacía', () => {
        // El plan puede tenerlo mientras el editor arrastra un borde.
        const r = picos.rangoDePicos(10, 100, 60, 40);
        t.ok(r.hasta > r.desde, `${r.desde}–${r.hasta}`);
        t.eq(picos.recortarPicos(diez, 100, 60, 40).length, 1);
    });

    t.test('sin picos o sin duración no se inventa nada', () => {
        t.deep(picos.recortarPicos([], 100, 0, 10), []);
        t.deep(picos.recortarPicos(null, 100, 0, 10), []);
        t.deep(picos.recortarPicos(diez, 0, 0, 10), []);
    });

    t.test('la cuenta de la clase 1 del curso real', () => {
        // 2516 s en 1200 cubos: 2,1 s por cubo. Medido sobre la pista de verdad,
        // los quince bloques traen entre 5 y 22 cubos —el más corto dura 8,7 s y
        // el más largo 45,4—. Es la medición con la que se decidió que en la tira
        // alcanza el recorte y en el panel grande no (ver `onda-clase.js`).
        const mil = new Array(1200).fill(0.5);
        t.eq(picos.recortarPicos(mil, 2516, 0, 8.7).length, 5);
        t.eq(picos.recortarPicos(mil, 2516, 0, 45.4).length, 22);
    });

    t.group('la onda de un bloque · contra qué pico se mide el alto');

    t.test('el techo es el pico más alto que haya', () => {
        t.eq(picos.techoDePicos([0.03, 0.179, 0.04]), 0.179);
    });

    t.test('una clase sin nada no se amplifica hasta el techo', () => {
        // Es el código de barras: dividiendo por el piso de ruido, el silencio se
        // dibuja como si alguien hablara todo el tiempo. 0,02 está arriba de la
        // mediana medida en el curso real (0,004).
        t.eq(picos.techoDePicos([0.001, 0.002, 0.0005]), 0.02);
        t.eq(picos.techoDePicos([]), 0.02);
        t.eq(picos.techoDePicos(null), 0.02);
    });

    t.test('la escala del Live-Mix real deja la silueta visible', () => {
        // El pico de la clase es 0,179 y los bloques llegan de 0,039 a 0,091: la
        // silueta ocupa entre el 22% y el 51% del alto del panel. A escala
        // absoluta serían 4% y 9%, o sea una línea con pelusa.
        const techo = picos.techoDePicos([0.179]);
        t.near(0.039 / techo, 0.22, 0.01);
        t.near(0.091 / techo, 0.51, 0.01);
    });

    t.group('la onda de un bloque · repartirla en columnas de píxeles');

    t.test('con más columnas que picos, cada pico se repite', () => {
        // Un bloque de 6 cubos en 12 px de tira: escalonado, que es la
        // resolución que hay. Inventar puntos intermedios sería dibujar un audio
        // que nadie midió.
        t.deep(picos.porColumna([1, 0], 4), [1, 1, 0, 0]);
    });

    t.test('con menos columnas que picos se queda con el máximo, no el promedio', () => {
        // El promedio aplana los ataques y en la silueta desaparecen las
        // fronteras entre tomas, que es lo único que se mira acá.
        t.deep(picos.porColumna([0, 1, 0, 0], 2), [1, 0]);
    });

    t.test('siempre devuelve tantas columnas como se pidieron', () => {
        t.eq(picos.porColumna([0.3, 0.4, 0.5], 7).length, 7);
        t.eq(picos.porColumna([], 5).length, 5, 'sin datos, cinco silencios');
        t.deep(picos.porColumna([0.9], 0), [], 'cero columnas es un canvas sin ancho');
    });
};
