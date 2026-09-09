'use strict';
/**
 * El aplauso de la claqueta.
 *
 * Los números de esta prueba no son inventados: salen de medir las trece clases
 * del curso con `tools/simular-grabacion.js`. Por eso la prueba usa los valores
 * reales del aplauso y del transitorio más parecido que NO es un aplauso — si
 * alguien afloja la regla, lo que se rompe es lo que ya se sabe que pasa.
 */

const golpe = require('../engine/golpe');

module.exports = t => {
    t.group('golpe · qué es un aplauso y qué no');

    // Los tres aplausos de verdad, medidos: pico y razón entre promedio y pico.
    const APLAUSOS = [
        { clase: 1, pico: 0.2427, razon: 0.048 },
        { clase: 2, pico: 0.2588, razon: 0.044 },
        { clase: 3, pico: 0.3398, razon: 0.041 }
    ];

    // Y los transitorios más fuertes del mismo minuto que no son la claqueta.
    const NO_APLAUSOS = [
        { que: 'un golpe más flojo y menos limpio', pico: 0.1044, razon: 0.113 },
        { que: 'una vocal fuerte', pico: 0.1018, razon: 0.242 }
    ];

    const FONDO = 0.0002; // el fondo medido de la sala del curso

    t.test('los aplausos de las clases del curso se reconocen', () => {
        for (const a of APLAUSOS) {
            t.eq(golpe.esGolpe(a.pico, a.pico * a.razon, FONDO), true,
                `la claqueta de la clase ${a.clase} (pico ${a.pico})`);
        }
    });

    t.test('los otros transitorios del mismo minuto, no', () => {
        for (const n of NO_APLAUSOS) {
            t.eq(golpe.esGolpe(n.pico, n.pico * n.razon, FONDO), false, n.que);
        }
    });

    t.test('el impostor más parecido SÍ pasa, y está bien que pase', () => {
        // El transitorio más limpio del curso que no es la claqueta —un golpe en
        // la mesa de la clase 2, a los 18,86 s— pasa la regla acústica, y apretar
        // la regla hasta que no pase deja fuera aplausos de verdad.
        //
        // Lo que lo descarta es otra cosa: llega DESPUÉS del aplauso de esa clase
        // (11,61 s) y el primer candidato es el que se queda, y encima el texto de
        // alrededor no dice "claqueta" ni "clase 2" (ver `engine/grabacion.js`).
        // Esta prueba está para que quede escrito que se sabe.
        t.eq(golpe.esGolpe(0.1257, 0.1257 * 0.091, FONDO), true);
    });

    t.test('el piso no se baja de lo que el material del curso pide', () => {
        // El Live-Mix está unos 18 dB por debajo de lo normal, y con un piso
        // pensado para audio de nivel normal se perdía la claqueta de dos clases.
        t.eq(golpe.PICO_MINIMO <= 0.12, true, `piso en ${golpe.PICO_MINIMO}`);
        t.eq(golpe.PARTE_PAREJA <= 0.10, true, `razón en ${golpe.PARTE_PAREJA}`);
    });

    t.test('un sonido parejo no es un golpe, por fuerte que sea', () => {
        // Es lo que separa la claqueta de alguien gritando al micrófono.
        t.eq(golpe.esGolpe(0.9, 0.5, FONDO), false);
    });

    t.test('en una sala que suena fuerte hace falta más para destacar', () => {
        // El umbral es relativo al fondo: si la sala ya hace ruido, un golpe que
        // en silencio destacaría no destaca.
        t.eq(golpe.esGolpe(0.25, 0.01, 0.002), true, 'sala tranquila');
        t.eq(golpe.esGolpe(0.25, 0.01, 0.05), false, 'sala que ya suena a 0,05');
    });

    t.group('golpe · medir un pedazo de PCM');

    /** Un pedazo de 16 bits con un pico de un par de muestras. */
    function pedazo(muestras, indices, valor) {
        const a = new Int16Array(muestras);
        for (const i of indices) a[i] = valor;
        return Buffer.from(a.buffer);
    }

    t.test('el pico y el promedio salen de todas las muestras', () => {
        const buf = pedazo(4096, [100, 101, 102], 16384);
        const { pico, medio } = golpe.medir(buf);
        t.near(pico, 0.5, 0.001);
        t.near(medio, 3 * 0.5 / 4096, 0.0001);
    });

    t.test('un silencio no mide nada', () => {
        const { pico, medio } = golpe.medir(pedazo(4096, [], 0));
        t.eq(pico, 0);
        t.eq(medio, 0);
    });

    t.group('golpe · el buscador, que es el que tiene memoria');

    /** La hora la trae cada pedazo, así que la prueba no depende de cuánto tarde. */
    function buscador() {
        return golpe.nuevo();
    }

    t.test('encuentra el golpe y aprende el fondo', () => {
        const b = buscador();
        const silencio = pedazo(4096, [], 0);
        // Unos pedazos tranquilos primero, como el arranque de una clase.
        for (let i = 0; i < 20; i++) golpe.mirar(b, silencio, i * 85);
        const r = golpe.mirar(b, pedazo(4096, [200, 201], 12000), 2000);
        t.eq(r.golpe, true);
        t.eq(r.ms, 2000, 'con la hora del pedazo, no la del reloj');
    });

    t.test('un aplauso en los primeros segundos también cuenta', () => {
        // Lo encontró esta prueba: el descanso entre golpes arrancaba en 0, así que
        // cualquier aplauso antes del segundo tres quedaba dentro del descanso de
        // un golpe que nunca existió. En vivo no se veía porque el reloj es la hora
        // del día; contando desde el arranque del audio, sí.
        const b = buscador();
        t.eq(golpe.mirar(b, pedazo(4096, [10, 11], 12000), 500).golpe, true);
    });

    t.test('no cuenta dos veces el mismo aplauso', () => {
        // Un aplauso dura unos milisegundos pero el eco de la sala puede dejar dos
        // pedazos seguidos por encima del umbral.
        const b = buscador();
        const fuerte = pedazo(4096, [200, 201], 12000);
        t.eq(golpe.mirar(b, fuerte, 5000).golpe, true);
        t.eq(golpe.mirar(b, fuerte, 5085).golpe, false, 'el de al lado es el mismo');
        t.eq(golpe.mirar(b, fuerte, 5000 + golpe.DESCANSO_MS).golpe, true,
            'pasado el descanso, sí');
    });

    t.test('el fondo no lo mueven los golpes', () => {
        // Si un aplauso subiera el fondo, el segundo aplauso ya no destacaría
        // contra él y una clase con dos claquetas quedaría con una sola.
        const b = buscador();
        const antes = b.fondo;
        golpe.mirar(b, pedazo(4096, [200, 201], 12000), 1000);
        t.eq(b.fondo, antes, 'el golpe no lo tocó');
    });
};
