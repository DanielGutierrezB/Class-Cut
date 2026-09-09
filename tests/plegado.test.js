'use strict';
/**
 * Una toma plegada, y qué queda dicho de ella.
 *
 * La prueba que importa es la del medio: **plegar no puede esconder trabajo.** Si
 * una toma con dos comentarios y una nota se pliega y el resumen no los menciona,
 * nadie va a volver a abrirla y lo que alguien escribió ahí se perdió sin que
 * nada avise. Eso no se ve mirando la pantalla —la toma se ve prolija— así que
 * tiene que estar acá.
 *
 * Lo otro que se fija es lo que el resumen NO dice: la cabecera ya trae el
 * número, las dos horas, el largo y la vista, y repetirlos gasta los dos
 * renglones que hay sin contestar la única pregunta que se hace al mirar una toma
 * plegada, que es si vale la pena abrirla.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Una toma con lo que se le pida encima. */
function toma(campos) {
    return { id: 3, vista: 'PV', inMs: 1000, outMs: 9000, palabras: [], comentarios: [], ...campos };
}

/** Palabras con hora, escritas cómodo. */
function dichas(texto) {
    return texto.split(' ').map((w, i) => ({ t: 1000 + i * 400, texto: w }));
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const plegado = await import(src('grabar/plegado.js'));

    t.group('plegar una toma · con qué empieza');

    t.test('el asomo son las primeras palabras, que es lo que la nombra', () => {
        // Del arranque y no del medio: una toma empieza donde el profesor anuncia
        // de qué va, y eso es lo que contesta "¿era esta la del ejercicio?".
        const r = plegado.asomoDe(toma({ palabras: dichas('Hoy vamos a armar un flujo de trabajo') }));
        t.eq(r, 'Hoy vamos a armar un flujo de trabajo');
    });

    t.test('se corta a las doce palabras y se dice que sigue', () => {
        const largo = dichas('uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce');
        t.eq(plegado.asomoDe(toma({ palabras: largo })),
            'uno dos tres cuatro cinco seis siete ocho nueve diez once doce…');
    });

    t.test('sin palabras no se inventa un asomo', () => {
        t.eq(plegado.asomoDe(toma({})), '');
    });

    t.group('plegar una toma · lo que no se puede esconder');

    t.test('los comentarios se siguen diciendo plegada', () => {
        const marcas = plegado.marcasDe(toma({
            comentarios: [{ texto: 'a', comentario: 'x' }, { texto: 'b', comentario: 'y' }]
        }));
        t.deep(marcas, ['2 comentarios']);
    });

    t.test('uno solo se dice en singular', () => {
        t.deep(plegado.marcasDe(toma({ comentarios: [{ texto: 'a', comentario: 'x' }] })),
            ['1 comentario']);
    });

    t.test('la nota de la toma también', () => {
        t.deep(plegado.marcasDe(toma({ comentario: 'Cortar antes de esto' })), ['con nota']);
    });

    t.test('y los avisos del motor, que son los que obligan a mirar', () => {
        // Que repita a otra toma o que tenga un "Pausa" adentro son las dos cosas
        // que hacen que valga la pena abrirla, así que plegada no pueden irse.
        const marcas = plegado.marcasDe(toma({ repiteA: 2, pausaAdentro: 5000, cerradaSola: true }));
        t.deep(marcas, ['repite la 2', '«Pausa» adentro', 'se cerró sola']);
    });

    t.test('todo junto, en el orden en que se lee', () => {
        const marcas = plegado.marcasDe(toma({
            comentarios: [{ texto: 'a', comentario: 'x' }],
            comentario: 'mirar el audio',
            repiteA: 1
        }));
        t.deep(marcas, ['1 comentario', 'con nota', 'repite la 1']);
    });

    t.test('una toma limpia no dice nada, que es la que se pliega tranquila', () => {
        t.deep(plegado.marcasDe(toma({ palabras: dichas('hola qué tal') })), []);
    });

    t.group('plegar una toma · cuánto se dijo');

    t.test('en palabras y no en segundos: los segundos ya están en la cabecera', () => {
        // Y no son lo mismo: una toma de un minuto con veinte palabras es una toma
        // en la que casi no se habló, y eso solo se ve contando palabras.
        t.eq(plegado.cuantoSeDijo(toma({ palabras: dichas('una dos tres') })), '3 palabras');
        t.eq(plegado.cuantoSeDijo(toma({ palabras: dichas('sola') })), '1 palabra');
    });

    t.test('sin texto se dice sin texto, no "0 palabras"', () => {
        t.eq(plegado.cuantoSeDijo(toma({})), 'sin texto');
    });

    t.test('el resumen es el asomo, la cuenta y las marcas', () => {
        const r = plegado.resumenDe(toma({
            palabras: dichas('Retomamos con el ejercicio de las reglas'),
            comentarios: [{ texto: 'a', comentario: 'x' }]
        }));
        t.eq(r.asomo, 'Retomamos con el ejercicio de las reglas');
        t.eq(r.cuanto, '7 palabras');
        t.deep(r.marcas, ['1 comentario']);
    });

    t.group('plegar una toma · cuáles se pueden plegar');

    t.test('una toma cerrada, sí', () => {
        t.ok(plegado.sePuedePlegar(toma({})));
    });

    t.test('la que está grabando, no: es lo que la persona está mirando', () => {
        t.eq(plegado.sePuedePlegar(toma({ outMs: null })), false);
    });

    t.test('una descartada tampoco, y ahí está la frontera con el otro botón', () => {
        // Una descartada YA se dibuja plegada sobre su cabecera, así que un botón
        // de plegar ahí sería un segundo gesto para el mismo resultado. Las
        // descartadas se sacan con el interruptor de la barra, de una vez.
        t.eq(plegado.sePuedePlegar(toma({ descartada: true })), false);
    });

    t.group('plegar una toma · esconder las descartadas');

    const CUATRO = [
        toma({ id: 1 }),
        toma({ id: 2, descartada: true }),
        toma({ id: 3 }),
        toma({ id: 4, outMs: null })
    ];

    t.test('por defecto se ven todas, en el orden en que pasaron', () => {
        t.deep(plegado.alaVista(CUATRO, { sinDescartadas: false }).map(x => x.id), [1, 2, 3, 4]);
    });

    t.test('escondidas, la descartada se va y el orden no se toca', () => {
        t.deep(plegado.alaVista(CUATRO, { sinDescartadas: true }).map(x => x.id), [1, 3, 4]);
    });

    t.test('sin mirada se ven todas: la lista de una clase leída no tiene botones', () => {
        t.deep(plegado.alaVista(CUATRO, null).map(x => x.id), [1, 2, 3, 4]);
    });

    t.test('escondidas se dice cuántas son, que si no parece que se perdieron', () => {
        t.eq(plegado.cuantasDescartadas(CUATRO), 1);
        t.eq(plegado.cuantasDescartadas([]), 0);
    });
};
