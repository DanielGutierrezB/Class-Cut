'use strict';
/**
 * Que lo que se dice dos veces se quite una, y que no se quite nada más.
 *
 * Es la prueba de una función que BORRA material: el riesgo no está en dejar
 * pasar una repetición —eso lo ve el editor—, sino en recortar un bloque que era
 * bueno, que el editor no ve porque el recorte ya se hizo. Por eso la mitad de
 * estos casos son de lo que NO debe tocar.
 */

const repeticiones = require('../engine/repeticiones');

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
        in: { originalSec: startSec, alignedSec: startSec, timeSec: startSec },
        out: { originalSec: endSec, alignedSec: endSec, timeSec: endSec }
    };
}

module.exports = t => {
    t.group('lo que se dice dos veces');

    // Una clase de juguete con la forma del caso real: el bloque se pasa de largo
    // y sigue hablando hasta que el profesor rehace la frase en el siguiente.
    function claseConRetoma() {
        const words = [
            ...decir('La especificación es la fuente de verdad de la aplicación.', 0),
            ...decir('Y es justamente ese el problema por el que esto no escala nunca.', 4),
            ...decir('Y justo ese es el problema por el que esto no escala.', 12)
        ];
        return { words, blocks: [bloque(0, 0, 10), bloque(1, 12, 17)] };
    }

    t.test('no cambia una repetición por un final colgando', () => {
        // La retoma arranca en un sitio donde no hay ninguna frase cerrada cerca:
        // recortar ahí quita la repetición pero deja el bloque a mitad de idea, y
        // eso es cambiar un defecto por otro.
        const words = [
            ...decir('la fuente de verdad de toda la aplicación y por eso mismo conviene', 0),
            ...decir('y por eso mismo conviene tenerla escrita.', 12)
        ];
        const blocks = [bloque(0, 0, 11), bloque(1, 12, 15)];
        const res = repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.recortadas, 0, 'no lo recortó');
        t.eq(blocks[0].endSec, 11, 'y lo dejó donde estaba');
    });

    t.test('encuentra la cola que el bloque siguiente vuelve a decir', () => {
        const { words, blocks } = claseConRetoma();
        const hallados = repeticiones.buscar(words, blocks, { fps: 30 });
        t.eq(hallados.length, 1);
        t.eq(hallados[0].bloque, 0);
        t.eq(hallados[0].contra, 1);
        t.eq(hallados[0].accion, 'recortar');
        t.near(hallados[0].timeSec, 4, 0.5, 'corta donde arranca la retoma');
    });

    t.test('recortar deja el bloque sin lo repetido', () => {
        const { words, blocks } = claseConRetoma();
        const res = repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.recortadas, 1);
        t.eq(res.stats.deshechas, 0);
        t.ok(blocks[0].endSec < 10, 'el bloque se acortó');
        t.eq(repeticiones.buscar(words, blocks, { fps: 30 }).length, 0, 'ya no queda repetición');
    });

    t.test('el borde recortado queda marcado y medido como cualquier otro', () => {
        const { words, blocks } = claseConRetoma();
        repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(blocks[0].out.decidedBy, 'repetido');
        t.eq(blocks[0].out.alignedSec, blocks[0].endSec);
        t.ok(blocks[0].out.shiftSec < 0, 'el desplazamiento apunta hacia atrás');
    });

    t.test('dos frases con el mismo esqueleto no son la misma toma', () => {
        // El caso que hizo falsa la primera versión: los bloques 7 y 8 de la
        // clase 4 comparten "el N componente es el de X y Y" y no comparten nada
        // de lo que dicen. Alinean igual de bien que una retoma de verdad.
        const words = [
            ...decir('El cuarto componente es el de estructura y estilo de código.', 0),
            ...decir('El quinto componente es el de manejo de errores y validaciones.', 8)
        ];
        const blocks = [bloque(0, 0, 5), bloque(1, 8, 13)];
        t.eq(repeticiones.buscar(words, blocks, { fps: 30 }).length, 0);
    });

    t.test('mide el parecido por lo que se dice, no por el andamiaje', () => {
        t.ok(repeticiones.seParecen(
            'el problema por el que esto no escala',
            'ese el problema por el que esto no escala nunca') >= 0.9);
        t.ok(repeticiones.seParecen(
            'el quinto componente es el de manejo de errores',
            'el cuarto componente es el de estructura y estilo') < 0.5);
    });

    t.test('un final que no se repite se queda como está', () => {
        const words = [
            ...decir('La especificación es la fuente de verdad de la aplicación.', 0),
            ...decir('Ahora vamos a ver cómo se instala la herramienta en tu equipo.', 8)
        ];
        const blocks = [bloque(0, 0, 5), bloque(1, 8, 13)];
        const antes = blocks[0].endSec;
        repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(blocks[0].endSec, antes);
    });

    t.group('arrancadas en falso');

    function claseConArranqueEnFalso() {
        const words = [
            ...decir('Ahora vamos a ejecutar el comando plan abrimos nuestra terminal y', 0),
            ...decir('Ahora vamos a ejecutar el comando plan abrimos nuestra terminal ' +
                'y nos posicionamos en la raíz del proyecto para crear la rama nueva.', 6)
        ];
        return { words, blocks: [bloque(0, 0, 4.4), bloque(1, 6, 14)] };
    }

    t.test('descarta el intento corto y deja el bueno', () => {
        const { words, blocks } = claseConArranqueEnFalso();
        const res = repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.stats.descartadas, 1);
        t.eq(blocks[0].enabled, false);
        t.eq(blocks[0].disabledBy, 'repetido');
        t.ok(blocks[1].enabled !== false, 'la toma buena sigue viva');
    });

    t.test('no descarta cuando el que se iría es el más largo', () => {
        // Si el bloque que calca dura más que el que lo repite, no es una
        // arrancada en falso: es material propio, y apagarlo pierde lo que solo
        // estaba ahí.
        const { words } = claseConArranqueEnFalso();
        const blocks = [bloque(0, 0, 5.6), bloque(1, 6, 8)];
        repeticiones.quitarRepeticiones({
            alignResult: { blocks }, words, wav: null, options: { fps: 30 }
        });
        t.ok(blocks[0].enabled !== false, 'no se apagó el bloque largo');
    });

    t.group('cuando el modelo ve una repetición que las reglas no');

    t.test('la ubica con menos exigencia y la recorta', () => {
        const words = [
            ...decir('Vamos a ver el arranque del curso paso por paso desde cero.', 0),
            ...decir('Bueno la herramienta se instala en el equipo.', 4.8),
            ...decir('La herramienta se instala en cada equipo.', 9)
        ];
        const blocks = [bloque(0, 0, 8), bloque(1, 9, 12)];
        const alignResult = { blocks, repeticiones: { stats: { recortadas: 0 } } };
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 8 },
                { n: 2, index: 1, startSec: 9, endSec: 12 }
            ],
            findings: [{ bloque: 2, tipo: 'repetido', detalle: 'repite el bloque 1' }]
        };

        const res = repeticiones.segunElModelo({
            alignResult, review, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.corregidos, 1);
        t.ok(blocks[0].endSec < 8, 'recortó el bloque anterior');
        t.ok(review.findings[0].corregido, 'el hallazgo queda como corregido');
        t.eq(review.blocks[0].endSec, blocks[0].endSec, 'el informe habla de la clase que quedó');
    });

    t.test('si no la encuentra, no toca nada', () => {
        const words = [
            ...decir('Vamos a instalar la herramienta en el equipo de cada uno.', 0),
            ...decir('Ahora abrimos el archivo de configuración del proyecto.', 9)
        ];
        const blocks = [bloque(0, 0, 5), bloque(1, 9, 13)];
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 5 },
                { n: 2, index: 1, startSec: 9, endSec: 13 }
            ],
            findings: [{ bloque: 2, tipo: 'repetido', detalle: 'repite el bloque 1' }]
        };
        const res = repeticiones.segunElModelo({
            alignResult: { blocks }, review, words, wav: null, options: { fps: 30 }
        });
        t.eq(res.corregidos, 0);
        t.eq(blocks[0].endSec, 5);
        t.ok(!review.findings[0].corregido, 'sigue siendo un aviso');
    });
};
