'use strict';
/**
 * El transporte del tramo, en la pestaña de cortes.
 *
 * De todo lo que hace `escucha.js`, esto es lo comprobable sin abrir la app: las
 * cuentas que traducen entre un momento de la clase y un punto de la ventana que
 * se está viendo. Son las que deciden si la aguja se dibuja donde suena y si
 * darle a la barra espaciadora suena o no hace nada, y son justo las que un ojo
 * mirando la pantalla no distingue: una aguja dos píxeles corrida se ve bien.
 *
 * El resto —que el `<audio>` abra el Live-Mix por `clase://`, que la aguja
 * acompañe, que la barra no active de paso el botón que tenga el foco— es DOM y
 * audio de verdad y se verificó con el arnés (`--js` contra el curso real), no
 * acá: una prueba de eso serían tres capas de dobles comprobando que el doble
 * hace lo que le dijimos.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'escucha.js')).href);
}

/** Una ventana como la que arma el zoom: bloque de 10 s con 4 s de margen. */
const VENTANA = { from: 96, to: 120, span: 24 };

module.exports = async t => {
    const escucha = await cargar();

    t.group('escuchar el tramo · dónde va la aguja');

    t.test('los bordes de la ventana son 0 y 1', () => {
        t.eq(escucha.fraccionEn(96, VENTANA), 0);
        t.eq(escucha.fraccionEn(120, VENTANA), 1);
        t.eq(escucha.fraccionEn(108, VENTANA), 0.5, 'el medio, al medio');
    });

    t.test('lo que cae afuera se queda en el borde y no se sale del canvas', () => {
        // Pasa de verdad: mover la entrada con los botones corre la ventana
        // entera, así que la aguja puede quedar antes del principio sin que
        // nadie haya tocado el audio. Sin recortar, el `left: -37%` deja la
        // aguja fuera de la pantalla y parece que dejó de andar.
        t.eq(escucha.fraccionEn(10, VENTANA), 0);
        t.eq(escucha.fraccionEn(999, VENTANA), 1);
    });

    t.test('sin ventana no se cae ni devuelve NaN', () => {
        // Se dibuja también sin bloque elegido (una clase con todo afuera).
        t.eq(escucha.fraccionEn(50, null), 0);
        t.eq(escucha.fraccionEn(50, { from: 0, to: 0, span: 0 }), 0);
        t.eq(escucha.segundoEn(0.5, null), 0);
    });

    t.test('un punto de la tira es un momento de la clase', () => {
        t.eq(escucha.segundoEn(0, VENTANA), 96);
        t.eq(escucha.segundoEn(1, VENTANA), 120);
        t.eq(escucha.segundoEn(0.25, VENTANA), 102);
    });

    t.test('arrastrar más allá de la tira no saca la aguja del tramo', () => {
        t.eq(escucha.segundoEn(-3, VENTANA), 96);
        t.eq(escucha.segundoEn(4, VENTANA), 120);
    });

    t.test('ida y vuelta: el momento que dibuja la aguja es el que suena', () => {
        for (const segundo of [96, 100.4, 108, 119.9]) {
            t.near(escucha.segundoEn(escucha.fraccionEn(segundo, VENTANA), VENTANA), segundo, 0.001);
        }
    });

    t.group('escuchar el tramo · desde dónde arranca');

    t.test('estando adentro, sigue desde donde quedó', () => {
        t.eq(escucha.arranqueDe(104, VENTANA), 104);
    });

    t.test('en el final rebobina, así darle play siempre suena', () => {
        // Sin esto, apretar la barra al terminar de escuchar no hace nada: el
        // audio arranca pegado al final y se corta en el mismo cuadro.
        t.eq(escucha.arranqueDe(120, VENTANA), 96);
        t.eq(escucha.arranqueDe(119.98, VENTANA), 96, 'las últimas centésimas también');
    });

    t.test('viniendo de otro bloque, arranca al principio del tramo', () => {
        // La ventana de antes puede estar en otro minuto de la clase.
        t.eq(escucha.arranqueDe(12, VENTANA), 96);
        t.eq(escucha.arranqueDe(2000, VENTANA), 96);
        t.eq(escucha.arranqueDe(null, VENTANA), 96, 'y sin posición previa, igual');
    });

    t.group('escuchar el tramo · el reloj de la aguja');

    t.test('con décima, que es lo que se está ajustando', () => {
        // Un cuadro son 33 ms: en segundos redondos, mover un borde no cambia
        // el número y el editor no sabe si el botón hizo algo.
        t.eq(escucha.reloj(96), '01:36,0');
        t.eq(escucha.reloj(96.47), '01:36,4');
        t.eq(escucha.reloj(3661.25), '1:01:01,2', 'y las clases largas pasan la hora');
    });

    t.test('sin número no inventa un cero', () => {
        t.eq(escucha.reloj(null), '—');
        t.eq(escucha.reloj(NaN), '—', 'el `currentTime` de un audio sin abrir');
    });

    t.group('escuchar el tramo · qué palabra se alumbra');

    const bordes = await import(
        pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', 'bordes.js')).href);

    // Dos frases con un silencio de seis segundos en el medio, que es la forma
    // que tiene un bloque donde el profesor para y retoma.
    const DICHAS = [
        { desdeSec: 10.0, hastaSec: 12.5 },
        { desdeSec: 10.6, hastaSec: 12.5 },
        { desdeSec: 11.4, hastaSec: 12.5 },
        { desdeSec: 18.0, hastaSec: 19.8 },
        { desdeSec: 18.7, hastaSec: 19.8 }
    ];

    t.test('la que arrancó y todavía no arrancó la siguiente', () => {
        t.eq(bordes.dichaEn(DICHAS, 10.0), 0, 'justo al arrancar, ya cuenta');
        t.eq(bordes.dichaEn(DICHAS, 10.5), 0);
        t.eq(bordes.dichaEn(DICHAS, 10.6), 1);
        t.eq(bordes.dichaEn(DICHAS, 11.9), 2);
    });

    t.test('antes de la primera no se alumbra nada', () => {
        // El margen de la ventana arranca antes del bloque: ahí todavía no se
        // dijo nada de esto y alumbrar la primera sería mentir.
        t.eq(bordes.dichaEn(DICHAS, 9.2), -1);
    });

    t.test('en la pausa entre frases se apaga', () => {
        // Esto es lo que hace que el panel se lea como sincronizado. El `end` de
        // cada palabra no sirve para saberlo —en el reloj del DTW es el arranque
        // de la que sigue, así que la última antes de la pausa "dura" toda la
        // pausa— y por eso el corte lo pone el final de la FRASE.
        t.eq(bordes.dichaEn(DICHAS, 12.7), 2, 'con un poco de cola, que la frase no corta seco');
        t.eq(bordes.dichaEn(DICHAS, 14), -1, 'seis segundos de silencio, nada alumbrado');
        t.eq(bordes.dichaEn(DICHAS, 18.1), 3, 'y vuelve cuando vuelve a hablar');
    });

    t.test('después de la última frase tampoco queda prendida', () => {
        // El caso del bloque que termina en silencio: sin esto, la última palabra
        // se queda alumbrada hasta que el tramo se acaba.
        t.eq(bordes.dichaEn(DICHAS, 25), -1);
    });

    t.test('sin palabras dibujadas no se cae', () => {
        // Un transcript viejo, sin tiempos por palabra: el panel cae en la frase
        // entera y no hay nada que seguir.
        t.eq(bordes.dichaEn([], 10), -1);
    });
};
