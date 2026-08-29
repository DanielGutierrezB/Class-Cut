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

    t.group('la toma que se corta y no vuelve');

    /** Palabras separadas por un silencio de verdad: apartes, no una frase. */
    function sueltas(textos, desde, cada) {
        return textos.map((text, i) => ({
            text,
            start: desde + i * (cada || 2),
            end: desde + i * (cada || 2) + 0.3
        }));
    }

    /**
     * La forma del bloque 1 de la clase 11: la toma cierra, el profesor dice
     * «Pausa.» y detrás quedan sesenta segundos de sala hablando suelto. La toma
     * buena arranca DESPUÉS del OUT, así que no hay con qué comparar.
     */
    function bloqueConTomaMuerta() {
        const words = [
            ...decir('Podemos auditar el código versus nuestras especificaciones.', 0),
            ...decir('Pausa.', 8),
            ...sueltas(['Bueno.', 'Ok.', 'Listo.'], 10)
        ];
        return { words, blocks: [bloque(0, 0, 16)] };
    }

    t.test('la ve por la orden al editor, sin que nadie cuente', () => {
        const { words, blocks } = bloqueConTomaMuerta();
        t.eq(speech.conteosEn(words).length, 0, 'no hay cuenta en ninguna parte');
        const hallado = retoma.buscarEnBloque(words, blocks[0], { fps: 30 });
        t.ok(hallado, 'y la encuentra igual');
        t.eq(hallado.senal, 'orden');
        t.eq(hallado.accion, 'recortar', 'la toma buena es la de antes');
        t.near(hallado.timeSec, 8, 0.1, 'el OUT retrocede hasta la orden');
        t.eq(hallado.orden, 'Pausa.');
    });

    t.test('recortar deja la toma que cerró y se lleva la charla', () => {
        const { words, blocks } = bloqueConTomaMuerta();
        const res = retoma.quitarRetomas({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.encontradas, 1);
        t.near(blocks[0].endSec, 8, 0.15, 'el OUT quedó en la orden');
        t.eq(blocks[0].startSec, 0, 'y el IN no se movió');
        t.eq(retoma.buscarEnBloque(words, blocks[0], { fps: 30 }), null, 'ya no queda nada');
    });

    t.test('una pausa de verdad no es una toma muerta', () => {
        // El bloque 6 de la clase 1: «…nos permite corregir eso. Pausa.
        // Entonces, aquí mostramos pantalla.» El profesor para y sigue con la
        // clase. Cortar acá tiraría 6,5 s de material único, y lo único que lo
        // distingue del caso de arriba es que detrás no hay charla de rodaje.
        const words = [
            ...decir('La especificación nos permite corregir eso.', 0),
            ...decir('Pausa.', 6),
            ...decir('Entonces, aquí mostramos la pantalla del editor y seguimos.', 8)
        ];
        t.eq(retoma.buscarEnBloque(words, bloque(0, 0, 16), { fps: 30 }), null);
    });

    t.test('una orden dicha DENTRO de una frase es la clase hablando', () => {
        // El bloque 14 de la clase 2: «Pausa el video, termina de leer el PROM».
        // Se lo dice al alumno, no al editor.
        const words = [
            ...decir('Ahora quiero que hagas esto.', 0),
            ...decir('Pausa el video, termina de leer el PROM y volvé.', 2),
            ...sueltas(['Bueno.', 'Ok.'], 8)
        ];
        t.eq(retoma.buscarEnBloque(words, bloque(0, 0, 12), { fps: 30 }), null,
            'la orden no cierra su frase, así que no es un aparte');
    });

    t.test('si lo que queda no cierra su frase, no se recorta', () => {
        // Recortar cambiaría un defecto por otro: el bloque terminaría colgando.
        // Es la misma comprobación que la rama de la cuenta le hace a la toma
        // nueva.
        const words = [
            ...decir('Podemos auditar el código versus nuestras', 0),
            ...decir('Pausa.', 8),
            ...sueltas(['Bueno.', 'Ok.', 'Listo.'], 10)
        ];
        t.eq(retoma.buscarEnBloque(words, bloque(0, 0, 16), { fps: 30 }), null);
    });

    t.test('y no se recorta si no queda bloque', () => {
        const words = [
            ...decir('Ya está.', 0),
            ...decir('Pausa.', 1.5),
            ...sueltas(['Bueno.', 'Ok.', 'Listo.'], 3)
        ];
        t.eq(retoma.buscarEnBloque(words, bloque(0, 0, 10), { fps: 30 }), null,
            '1,5 s no es una toma');
    });

    t.test('la cuenta gana a la orden cuando están las dos', () => {
        // La cuenta dice dónde ARRANCA la toma que el profesor quiere; la orden,
        // dónde se murió la anterior. Con las dos, lo que hay que conservar es lo
        // de después de la cuenta, y la orden es justo el aparte que la precede.
        const { words, blocks } = bloqueConDosTomas();
        const hallado = retoma.buscarEnBloque(words, blocks[0], { fps: 30 });
        t.eq(hallado.senal, 'cuenta');
        t.eq(hallado.accion, 'abrir');
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
