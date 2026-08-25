'use strict';
/**
 * La claqueta no es un bloque, y ningún corte puede abrirse antes de ella.
 *
 * El parser ya la separaba de los bloques, pero eso no alcanzaba: el bloque 1
 * puede ABRIRSE hacia atrás y tragársela. Pasó en la clase 6 del curso, donde el
 * modelo eligió un corte 7,4 s antes del marcador y el corte final empezaba con
 * "Claqueta 6, clase 6. 3, 2, 1. Ya…". Así que la claqueta es un piso.
 */

const clap = require('../engine/clap-detect');
const refine = require('../engine/cut-refine');
const speech = require('../engine/speech-edges');

/** Palabras con tiempos, como las entrega Whisper. */
function decir(texto, desde, porPalabra) {
    const paso = porPalabra || 0.4;
    return texto.split(' ').map((palabra, i) => ({
        text: palabra,
        start: desde + i * paso,
        end: desde + i * paso + paso * 0.9
    }));
}

module.exports = function (t) {
    t.group('la claqueta · dónde empieza la clase');

    t.test('el piso es lo más tardío que se sepa de la claqueta', () => {
        // El golpe es el instante de verdad, pero si el dicho terminó después
        // —o el CD puso el marcador más adelante— manda el que quede último:
        // cualquiera de los tres que se deje afuera se oye en la clase.
        const piso = clap.pisoDeLaClase(
            { found: true, clap: { time: 10 }, spoken: { end: 9.7 } }, 7, 3.32);
        t.ok(piso > 10.3, `el golpe más el margen (${piso})`);
        t.ok(piso < 11, 'y no más que eso');
    });

    t.test('el marcador del CD se corre con el desfase de la clase', () => {
        // El marcador vive en tiempo del XML y los bloques en tiempo del audio.
        const piso = clap.pisoDeLaClase({ found: false }, 7, 3.32);
        t.ok(piso >= 10.32, `7 + 3.32 y el margen (${piso})`);
    });

    t.test('sin nada que decir de la claqueta no hay piso', () => {
        t.eq(clap.pisoDeLaClase({ found: false }, null, 0), null);
        t.eq(clap.pisoDeLaClase(null, null, 0), null);
    });

    t.test('sin golpe alcanza el final del dicho', () => {
        const piso = clap.pisoDeLaClase({ found: true, spoken: { end: 9.7 }, clap: null }, null, 0);
        t.ok(piso > 9.7 && piso < 10.3, String(piso));
    });

    t.group('la claqueta · el piso se respeta en todas las etapas');

    t.test('el afinado no ofrece un corte anterior a la claqueta', () => {
        // Se filtra el CANDIDATO y no se corrige el resultado a propósito: si el
        // modelo llega a ver la opción, la elige. Es lo que pasó en la clase 6.
        const bloque = { startSec: 15, endSec: 25 };
        const antes = { time: 8, frontier: 8 };
        const despues = { time: 16, frontier: 16 };

        t.eq(refine.fitsInBlock(antes, bloque, 'IN', { pisoSec: 10.67 }), false,
            'el de antes de la claqueta se descarta');
        t.eq(refine.fitsInBlock(despues, bloque, 'IN', { pisoSec: 10.67 }), true,
            'el de después entra');
        t.eq(refine.fitsInBlock(antes, bloque, 'IN', {}), true,
            'sin piso declarado no se filtra nada');
    });

    t.test('el piso no se le aplica al OUT, que ya tiene el suyo', () => {
        // Un OUT no puede estar antes de su propio IN, así que ya está cubierto.
        const bloque = { startSec: 15, endSec: 25 };
        t.eq(refine.fitsInBlock({ time: 20 }, bloque, 'OUT', { pisoSec: 30 }), true);
    });

    t.test('abrir la frase no se mete debajo del suelo que le dan', () => {
        // `snapToSentence` es lo único del alineado que mueve un IN hacia atrás.
        const words = decir('Claqueta 6, clase 6.', 8)
            .concat(decir('Ya Clauco nos entregó los planos de nuestra casa.', 15.5));

        const sinSuelo = speech.snapToSentence(words, 16.4, 'IN', { fps: 30 });
        t.ok(sinSuelo.candidates.retract != null, 'sin suelo hay a dónde retraer');

        const conSuelo = speech.snapToSentence(words, 16.4, 'IN', { fps: 30, minTime: 16.2 });
        t.eq(conSuelo.candidates.retract, null, 'con el suelo puesto, no se retrae debajo');
    });

    t.group('la charla del director tiene que venir suelta');

    t.test('«Ya» pegado a su frase es habla, no una orden', () => {
        // Con solo el silencio de delante, "Ya" contaba como orden y eso hacía
        // perder la frase entera que abría: "Ya Clauco nos entregó los planos".
        const ya = { text: 'Ya', start: 15.56, end: 15.56 };
        t.eq(speech.isChatter(ya, 0.35, null, { text: 'Clauco' }), false,
            'con palabra detrás es parte de la frase');
        t.eq(speech.isChatter({ text: 'Ya.', start: 15.5, end: 15.7 }, 0.35, null, { text: 'Clauco' }), true,
            'cerrando su propia frase sí es el aparte del director');
    });

    t.test('lo que siempre fue una orden lo sigue siendo', () => {
        // La lista fuerte no depende de venir suelta: "Pausa" en medio de una
        // frase es igual de orden.
        t.eq(speech.isChatter({ text: 'Pausa.' }, 0, null, { text: 'y' }), true);
        t.eq(speech.isChatter({ text: 'Pausa' }, 0, null, { text: 'y' }), true);
    });
};
