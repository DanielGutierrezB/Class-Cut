'use strict';
/**
 * Que la retoma que vive ADENTRO de un bloque se vea, y que se quede la toma
 * buena.
 *
 * Es la prueba de una función que BORRA material —abrir el IN en la segunda toma
 * tira todo lo anterior, hasta 85 s en el peor caso del curso—, así que la mitad
 * de estos casos son de lo que NO debe tocar. El que más importa es el del
 * bloque 4 de la clase 7: el profesor enumera dos veces "la opción A… también la
 * opción B", el parecido llega al 100 % y no hay retoma ninguna. Lo único que lo
 * distingue de una retoma de verdad es que nadie contó.
 */

const retoma = require('../engine/retoma');
const speech = require('../engine/speech-edges');

/** Palabras con tiempo, una cada 0.4s, a partir de `desde`. */
function decir(texto, desde) {
    return texto.split(/\s+/).map((palabra, i) => ({
        text: palabra,
        start: Math.round((desde + i * 0.4) * 1000) / 1000,
        end: Math.round((desde + i * 0.4 + 0.38) * 1000) / 1000
    }));
}

function bloque(index, startSec, endSec) {
    return {
        index,
        startSec,
        endSec,
        in: { kind: 'IN', originalSec: startSec, alignedSec: startSec, timeSec: startSec },
        out: { kind: 'OUT', originalSec: endSec, alignedSec: endSec, timeSec: endSec }
    };
}

const PARADIGMA = 'En Spec Driven Development hay un cambio de paradigma la fuente de verdad';

module.exports = t => {
    t.group('el conteo de toma, en cualquier parte de la lista');

    t.test('lo encuentra en el medio y no solo en la cabeza', () => {
        const palabras = decir('lo dijimos así antes 3, 2, 1. y ahora lo decimos así', 0);
        t.deep(speech.conteosEn(palabras), [{ desde: 4, hasta: 6 }]);
    });

    t.test('en letra hace falta que vengan en fila', () => {
        t.deep(speech.conteosEn(decir('Uno de los problemas más comunes es este', 0)), [],
            'una sola no es un conteo');
        t.deep(speech.conteosEn(decir('listo Tres, dos, uno. arrancamos', 0)), [{ desde: 1, hasta: 3 }]);
    });

    t.test('un conteo lejos del arranque sigue sin ser el de esta toma', () => {
        // `finDeConteo` mira la cabeza a propósito, y el barrido general no le
        // puede cambiar eso: es lo que impide que el recorte de bordes se lleve
        // por delante media clase por un número dicho al pasar.
        const palabras = decir('esto pasa cuando el editor mira el material 3, 2, 1. sigue', 0);
        t.deep(speech.conteosEn(palabras), [{ desde: 8, hasta: 10 }], 'el barrido lo ve');
        t.eq(speech.finDeConteo(palabras), -1, 'el de la cabeza no');
    });

    t.group('la retoma adentro de un bloque');

    /** La forma del bloque 3 de la clase 1: las dos tomas del mismo lado del borde. */
    function bloqueConDosTomas() {
        const words = [
            ...decir(`${PARADIGMA} reside en nuestro código.`, 0),
            ...decir('Pausa. Quiero repetir esa.', 8),
            ...decir('3, 2, 1.', 10.5),
            ...decir(`${PARADIGMA} vive en la documentación técnica.`, 13)
        ];
        return { words, blocks: [bloque(0, 0, 20)] };
    }

    t.test('la encuentra y elige la segunda toma', () => {
        const { words, blocks } = bloqueConDosTomas();
        const hallado = retoma.buscarEnBloque(words, blocks[0], { fps: 30 });
        t.ok(hallado, 'la vio');
        t.eq(hallado.accion, 'abrir');
        t.near(hallado.timeSec, 13, 0.1, 'abre donde arranca la toma nueva');
        t.near(hallado.cuentaSec, 10.5, 0.1, 'y la cuenta queda afuera');
        t.ok(hallado.parecido >= 0.5, 'confirmó que dicen lo mismo');
    });

    t.test('sin la cuenta no toca nada', () => {
        // El falso positivo que importa: lo mismo dicho dos veces, sin que nadie
        // haya pedido repetirlo. Es el profesor volviendo sobre algo, y en el
        // curso son 7 de los 11 bloques que salen si no se pide la señal.
        const words = [
            ...decir(`${PARADIGMA} reside en nuestro código.`, 0),
            ...decir(`${PARADIGMA} vive en la documentación técnica.`, 13)
        ];
        const blocks = [bloque(0, 0, 20)];
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null);
    });

    t.test('con la cuenta pero sin repetición tampoco', () => {
        // El profesor paró, contó y siguió con otro tema. Ahí lo de antes es
        // material único y abrir el IN lo borraría.
        const words = [
            ...decir('La especificación es la fuente de verdad de toda la aplicación.', 0),
            ...decir('3, 2, 1.', 10.5),
            ...decir('Ahora vamos a ver cómo se instala la herramienta en tu equipo.', 13)
        ];
        const blocks = [bloque(0, 0, 20)];
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null);
    });

    t.test('una cuenta pegada al arranque es otro defecto, no una retoma', () => {
        // Eso es el conteo que quedó dentro del bloque, que `trimChatter` quita y
        // la medición cuenta como `conteo`. Acá no hay dos tomas.
        const words = [
            ...decir('3, 2, 1.', 0),
            ...decir(`${PARADIGMA} reside en nuestro código.`, 2)
        ];
        const blocks = [bloque(0, 0, 10)];
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null);
    });

    t.test('con tres tomas se queda la última', () => {
        // El bloque 9 de la clase 11: dos cuentas adentro. Haciéndole caso a la
        // primera se conservaría la segunda toma, que también se rehizo.
        const words = [
            ...decir(`${PARADIGMA} reside en nuestro código.`, 0),
            ...decir('3, 2, 1.', 8),
            ...decir(`${PARADIGMA} reside en la especificación.`, 10),
            ...decir('3, 2, 1.', 18),
            ...decir(`${PARADIGMA} vive en la documentación técnica.`, 20)
        ];
        const blocks = [bloque(0, 0, 27)];
        const hallado = retoma.buscarEnBloque(words, blocks[0], { fps: 30 });
        t.ok(hallado, 'la vio');
        t.near(hallado.timeSec, 20, 0.1, 'abre en la tercera toma');
    });

    /** La otra forma: el CD puso el OUT en medio de la toma nueva. */
    function bloqueCortadoEnLaTomaNueva() {
        const words = [
            ...decir(`${PARADIGMA} reside en nuestro código.`, 0),
            ...decir('3, 2, 1.', 10.5),
            ...decir(`${PARADIGMA} vive en`, 13)
        ];
        return { words, blocks: [bloque(0, 0, 17.5)] };
    }

    t.test('si la toma nueva no se sostiene sola, se va ella', () => {
        // Lo que hay después de la cuenta no es una toma sino su arranque, y el
        // cuerpo vive en el bloque siguiente. Abrir el IN ahí borraría la única
        // versión completa que existe.
        const { words, blocks } = bloqueCortadoEnLaTomaNueva();
        const hallado = retoma.buscarEnBloque(words, blocks[0], { fps: 30 });
        t.ok(hallado, 'la vio');
        t.eq(hallado.accion, 'recortar');
        t.near(hallado.timeSec, 10.5, 0.1, 'el OUT retrocede hasta la cuenta');
    });

    t.group('aplicarla');

    t.test('abre el bloque en la toma buena y la retoma desaparece', () => {
        const { words, blocks } = bloqueConDosTomas();
        const res = retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.encontradas, 1);
        t.eq(res.stats.abiertas, 1);
        t.eq(res.stats.deshechas, 0);
        t.near(blocks[0].startSec, 13, 0.1, 'el bloque arranca en la segunda toma');
        t.eq(blocks[0].endSec, 20, 'y el otro borde no se movió');
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null, 'ya no queda retoma');
    });

    t.test('el borde movido queda marcado y medido como cualquier otro', () => {
        const { words, blocks } = bloqueConDosTomas();
        retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(blocks[0].in.decidedBy, 'retoma');
        t.eq(blocks[0].in.alignedSec, blocks[0].startSec);
        t.ok(blocks[0].in.shiftSec > 0, 'el desplazamiento apunta hacia adelante');
    });

    t.test('el bloque nuevo no puede abrir con la cuenta', () => {
        const { words, blocks } = bloqueConDosTomas();
        retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.ok(!speech.abreConConteo(words, blocks[0].startSec));
    });

    t.test('el pedazo de la toma nueva se recorta por el otro borde', () => {
        // Esta rama no tiene muestra en el curso —los cuatro casos son de abrir—,
        // así que la prueba es lo único que la sostiene.
        const { words, blocks } = bloqueCortadoEnLaTomaNueva();
        const res = retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.recortadas, 1);
        t.eq(res.stats.abiertas, 0);
        t.eq(blocks[0].startSec, 0, 'el IN no se movió');
        t.ok(blocks[0].endSec <= 10.6, 'el OUT cierra antes de la cuenta');
        t.eq(blocks[0].out.decidedBy, 'retoma');
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null, 'ya no queda retoma');
    });

    t.test('un bloque sin retoma se queda donde está', () => {
        const words = [
            ...decir('La especificación es la fuente de verdad de toda la aplicación.', 0),
            ...decir('Ahora vamos a ver cómo se instala la herramienta en tu equipo.', 13)
        ];
        const blocks = [bloque(0, 0, 20)];
        const res = retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.encontradas, 0);
        t.eq(blocks[0].startSec, 0);
        t.eq(blocks[0].endSec, 20);
    });

    t.test('un bloque apagado no se toca', () => {
        const { words, blocks } = bloqueConDosTomas();
        blocks[0].enabled = false;
        retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(blocks[0].startSec, 0);
    });

    t.group('el suelo del colchón de aire');

    t.test('una palabra de duración cero en el corte no es la palabra anterior', () => {
        // Whisper entrega palabras de duración cero. Una de esas justo en el
        // corte se contaba como palabra ya terminada, el suelo quedaba pegado al
        // corte y el colchón de aire no tenía dónde caber.
        const words = [
            { text: 'uno.', start: 8, end: 9 },
            { text: 'En', start: 10, end: 10 },
            { text: 'Spec', start: 10, end: 10.4 }
        ];
        t.eq(speech.wordLimits(words, 10, 'IN').minTime, 9);
    });
};
