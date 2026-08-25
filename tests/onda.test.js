'use strict';
/**
 * El tamaño del búfer de las ondas del visor.
 *
 * Existe por un desperfecto que dejaba la pantalla de revisión en blanco: el
 * alto se leía del atributo `height` del canvas, que es el que el propio dibujo
 * sobrescribe con el alto en píxeles del búfer. En una pantalla 2×, cada
 * repintado leía el doble del anterior; el zoom se repinta dos veces por clic,
 * así que se cuadruplicaba —132 px al abrir, 16.898 al cuarto clic— y ahí pasa
 * el máximo que aguanta un canvas y el navegador lo deja vacío.
 *
 * El arreglo de verdad es que el alto lo ponga el CSS y nadie lo lea del búfer.
 * Esto prueba la cuenta y el techo, que es el seguro contra volver a caer.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'onda.js')).href);
}

module.exports = async t => {
    const onda = await cargar();

    t.group('las ondas del visor · el búfer de dibujo');

    t.test('el búfer va por la densidad de la pantalla y lo de pantalla no se toca', () => {
        const medida = onda.medidaDelCanvas(860, 104, 2);
        t.eq(medida.width, 860, 'lo que mide en pantalla es lo medido');
        t.eq(medida.height, 104);
        t.eq(medida.bufferWidth, 1720, 'el búfer va al doble en una pantalla 2×');
        t.eq(medida.bufferHeight, 208);
    });

    t.test('en una pantalla normal el búfer es el tamaño en pantalla', () => {
        const medida = onda.medidaDelCanvas(600, 54, 1);
        t.eq(medida.bufferWidth, 600);
        t.eq(medida.bufferHeight, 54);
    });

    t.test('medir cero no da un canvas de cero', () => {
        // Pasa al dibujar con la vista escondida: se pinta en el vacío y al
        // mostrarse se repinta con la medida de verdad. Un búfer de 0 tira una
        // excepción y se lleva puesto el resto del dibujo.
        const medida = onda.medidaDelCanvas(0, 0, 2);
        t.ok(medida.bufferWidth > 0 && medida.bufferHeight > 0, 'hay algo donde dibujar');
        t.ok(medida.width > 0 && medida.height > 0);
    });

    t.test('nada pasa del techo, aunque le entre una medida absurda', () => {
        // El caso del desperfecto: 16.898 px de alto. Recortado se ve mal; sin
        // recortar no se ve NADA, y con él desaparece la pantalla de revisión.
        const medida = onda.medidaDelCanvas(860, 16898, 2);
        t.eq(medida.bufferHeight, onda.MAXIMO_PX);
        t.ok(medida.bufferHeight <= onda.MAXIMO_PX);

        const ancho = onda.medidaDelCanvas(99999, 104, 2);
        t.eq(ancho.bufferWidth, onda.MAXIMO_PX);
    });

    t.test('sin densidad declarada se asume 1 y no NaN', () => {
        const medida = onda.medidaDelCanvas(500, 100, undefined);
        t.eq(medida.bufferWidth, 500);
        t.eq(medida.bufferHeight, 100);
    });
};
