'use strict';
/**
 * Que el panel alumbre la palabra que suena, y no la de al lado.
 *
 * El karaoke sirve para validar un corte de un vistazo, así que una palabra
 * corrida deja aprobar un borde mirando texto que no corresponde. Es lógica
 * pura: se prueba sin abrir ninguna ventana.
 */

const path = require('path');
const { pathToFileURL } = require('url');

async function cargar(modulo) {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'visor', modulo)).href);
}

/** Dos bloques sueltos: del 10 al 20 y del 100 al 130 de la grabación. */
function planDeEjemplo() {
    return [
        { blockIndex: 0, keep: true, sourceStartSec: 10, sourceEndSec: 20, cameraIndex: 0, view: 'PV' },
        { blockIndex: 1, keep: true, sourceStartSec: 100, sourceEndSec: 130, cameraIndex: 1, view: 'R' }
    ];
}

/** Palabras repartidas dentro, fuera y a caballo de los bordes. */
function palabrasDeEjemplo() {
    return [
        { start: 2, end: 3, text: 'antes' },
        { start: 11, end: 12, text: 'hola' },
        { start: 12, end: 13, text: 'qué' },
        { start: 13, end: 14, text: 'tal' },
        { start: 50, end: 51, text: 'afuera' },
        { start: 101, end: 102, text: 'esto' },
        { start: 102, end: 103, text: 'es' },
        { start: 129.5, end: 131, text: 'pantalla' },
        { start: 200, end: 201, text: 'después' }
    ];
}

module.exports = async t => {
    const pista = await cargar('pista.js');
    const letra = await cargar('letra.js');

    const bloques = () => letra.repartir(pista.construir(planDeEjemplo()).tramos, palabrasDeEjemplo());

    t.group('el transcript repartido en los bloques del corte');

    t.test('cada bloque se queda con las palabras que suenan adentro', () => {
        const b = bloques();
        t.eq(b.length, 2);
        t.eq(letra.texto(b[0]), 'hola qué tal');
        t.eq(letra.texto(b[1]), 'esto es pantalla');
    });

    t.test('lo que quedó fuera del corte no aparece', () => {
        const todo = bloques().flatMap(b => b.palabras.map(p => p.texto));
        t.eq(todo.includes('antes'), false, 'lo de antes del primer bloque');
        t.eq(todo.includes('afuera'), false, 'lo que cayó entre dos bloques');
        t.eq(todo.includes('después'), false, 'lo de después del último');
    });

    t.test('las palabras van en tiempo del corte, no de la grabación', () => {
        // "hola" suena en el segundo 11 del archivo, que es el 1 del corte.
        const b = bloques();
        t.eq(b[0].palabras[0].desdeSec, 1);
        // El segundo bloque arranca en el 10 del corte: "esto" cae en el 11.
        t.eq(b[1].palabras[0].desdeSec, 11);
    });

    t.test('cada palabra recuerda su segundo en la grabación', () => {
        // Es lo que anclan las notas, y tiene que sobrevivir a mover un borde.
        t.eq(bloques()[1].palabras[0].origenSec, 101);
    });

    t.test('una palabra partida por el borde se recorta al bloque', () => {
        // "pantalla" termina en el 131 y el bloque cierra en el 130: si no se
        // recorta, la aguja llega al final y la palabra sigue figurando.
        const ultima = bloques()[1].palabras.slice(-1)[0];
        t.eq(ultima.texto, 'pantalla');
        t.eq(ultima.hastaSec, 40, 'el final del corte, no el de la palabra');
    });

    t.group('las pausas intercaladas en el texto');

    // Un silencio del 14 al 18 de la grabación, dentro del primer bloque. Las
    // palabras del bloque terminan en el 14, así que el hueco es limpio.
    const conPausa = () => letra.repartir(
        pista.construir(planDeEjemplo()).tramos,
        palabrasDeEjemplo(),
        [{ desdeSec: 14, hastaSec: 18, duracionSec: 4 }]
    );

    t.test('la pausa cae en el bloque que la contiene', () => {
        const b = conPausa();
        t.eq(b[0].pausas.length, 1);
        t.eq(b[1].pausas.length, 0);
    });

    t.test('la pausa va en tiempo del corte, como las palabras', () => {
        // El bloque arranca en el 10 de la grabación y en el 0 del corte.
        t.eq(conPausa()[0].pausas[0].desdeSec, 4);
    });

    t.test('en un hueco limpio va detrás de la última palabra que sonó', () => {
        // "tal" termina en el 14 y ahí empieza el silencio: el aviso va después.
        t.eq(conPausa()[0].pausas[0].trasPalabra, 2);
    });

    t.test('un silencio metido dentro de una palabra va DESPUÉS de ella', () => {
        // El caso real: Whisper le da a "tal" del 13 al 19 porque le cuelga el
        // silencio que sigue. Anotarlo antes partiría "qué ⏸ tal", que en el
        // audio se dice de corrido.
        const largas = [
            { start: 11, end: 12, text: 'hola' },
            { start: 12, end: 13, text: 'qué' },
            { start: 13, end: 19, text: 'tal' }
        ];
        const b = letra.repartir(
            pista.construir(planDeEjemplo()).tramos,
            largas,
            [{ desdeSec: 13.2, hastaSec: 19, duracionSec: 5.8 }]
        );
        t.eq(b[0].pausas[0].trasPalabra, 2, 'detrás de "tal", no delante');
    });

    t.test('una pausa que cruza el borde cuenta por lo que quedó adentro', () => {
        // Del 18 al 25, pero el bloque cierra en el 20: son dos segundos, no
        // siete. Contar los siete diría que sobra material que ni está.
        const b = letra.repartir(
            pista.construir(planDeEjemplo()).tramos,
            palabrasDeEjemplo(),
            [{ desdeSec: 18, hastaSec: 25, duracionSec: 7 }]
        );
        t.eq(b[0].pausas[0].duracionSec, 2);
    });

    t.test('una pausa entre dos bloques no aparece en ninguno', () => {
        // El material del 50 al 60 se descartó: su silencio no está en la clase.
        const b = letra.repartir(
            pista.construir(planDeEjemplo()).tramos,
            palabrasDeEjemplo(),
            [{ desdeSec: 50, hastaSec: 60, duracionSec: 10 }]
        );
        t.eq(b.every(x => !x.pausas.length), true);
    });

    t.test('sin silencios, los bloques igual traen la lista vacía', () => {
        // El panel recorre `pausas` sin preguntar: si faltara, se rompería al
        // abrir una clase procesada antes de que esto existiera.
        t.deep(bloques()[0].pausas, []);
    });

    t.group('el aire muerto de un tramo');

    t.test('suma solo lo que cae adentro, recortado al tramo', () => {
        const silencios = [
            { desdeSec: 5, hastaSec: 12 },   // entra a medias: 2s adentro
            { desdeSec: 14, hastaSec: 17 },  // entero: 3s
            { desdeSec: 40, hastaSec: 50 }   // afuera
        ];
        t.eq(letra.aireEn(silencios, 10, 20, 2), 5);
    });

    t.test('por debajo del mínimo es respirar, no aire', () => {
        t.eq(letra.aireEn([{ desdeSec: 10, hastaSec: 11 }], 0, 100, 2), 0);
        t.eq(letra.aireEn(null, 0, 100, 2), 0);
    });

    t.group('qué palabra suena ahora');

    t.test('encuentra la palabra del momento', () => {
        const b = bloques();
        t.eq(letra.palabraEn(b, 2.5).palabra, 1, '"qué", que arranca en el 2 del corte');
        t.eq(letra.palabraEn(b, 2.5).bloque, 0);
    });

    t.test('justo en el corte manda el bloque que empieza', () => {
        // El primer bloque termina en el 10 del corte y ahí mismo arranca el
        // segundo. Al pararse en ese instante —abrir el reproductor en un
        // bloque cae exacto— alumbraba "tal", la última del bloque anterior.
        const b = bloques();
        t.eq(letra.palabraEn(b, 10), null, 'el aire de entrada del segundo, no el final del primero');
        t.eq(letra.palabraEn(b, 11).bloque, 1);
    });

    t.test('el final de la clase sigue cayendo en el último bloque', () => {
        // Al último no se le puede aplicar la misma regla: no hay siguiente que
        // se quede con el borde, y quedaría sin alumbrar nada al terminar.
        t.eq(letra.palabraEn(bloques(), 40).bloque, 1);
    });

    t.test('en el aire antes de la primera palabra no alumbra nada', () => {
        // Alumbrar la primera sería decir que ya se está diciendo, y todavía no.
        t.eq(letra.palabraEn(bloques(), 0.2), null);
    });

    t.test('con palabras que se pisan, elige la última que arrancó', () => {
        // Whisper devuelve solapamientos: buscar "la que contiene el segundo"
        // prendería dos a la vez.
        const tramos = pista.construir(planDeEjemplo()).tramos;
        const pisadas = [
            { start: 11, end: 14, text: 'larga' },
            { start: 12, end: 13, text: 'corta' }
        ];
        const b = letra.repartir(tramos, pisadas);
        t.eq(b[0].palabras[letra.palabraEn(b, 2.5).palabra].texto, 'corta');
    });

    t.test('fuera de todo bloque no hay palabra', () => {
        t.eq(letra.palabraEn(bloques(), 999), null);
    });

    t.group('el ancla de un comentario');

    t.test('una selección se ancla al tiempo de la grabación', () => {
        const ancla = letra.anclaDe(bloques()[0], 0, 2);
        t.eq(ancla.texto, 'hola qué tal');
        t.eq(ancla.sourceStartSec, 11, 'el segundo del archivo, no el del corte');
        t.eq(ancla.sourceEndSec, 13);
    });

    t.test('seleccionar al revés da lo mismo', () => {
        // Arrastrar de derecha a izquierda es la misma selección.
        t.eq(letra.anclaDe(bloques()[0], 2, 0).texto, 'hola qué tal');
    });

    t.test('un bloque sin palabras no se puede anclar', () => {
        t.eq(letra.anclaDe({ palabras: [] }, 0, 0), null);
    });
};
