'use strict';
/**
 * Lo que se oye en el arranque de un bloque y el transcript no dice.
 *
 * El defecto de origen: el corte de la clase 13 abría con «Tres, dos, uno.» y
 * ninguna de las tres reglas que sacan la cuenta la podía ver, porque la cuenta
 * **no estaba en el transcript**. Whisper la escribe perfecto cuando se le da el
 * pedazo suelto y la saltea leyendo la clase entera.
 *
 * Acá se prueba todo lo que se puede probar sin audio: la firma que dice dónde
 * mirar, el filtro que decide qué palabra de la relectura entra, y la mezcla —que
 * es la parte delicada, porque el `start` guardado y el instante del DTW no dicen
 * lo mismo en un tramo mal leído—. Los números del curso que sostienen cada
 * decisión están en la cabecera de `engine/rescate.js`.
 *
 * Los tramos y las palabras de casi todos los casos son los de verdad, copiados
 * del Backup del curso.
 */

const rescate = require('../engine/rescate');
const speech = require('../engine/speech-edges');
const relojes = require('../engine/reloj');

/** Los tramos del mapa de voz de la clase 13 alrededor del bloque 1. */
const VOZ_CLASE_13 = {
    tramos: [
        [118.50, 118.64], [123.12, 123.18], [123.24, 123.30], [124.60, 124.66],
        [125.18, 125.24], [125.30, 125.40],
        [127.12, 127.40], [127.84, 128.02], [128.38, 128.58],
        [129.20, 129.88], [129.92, 130.32],
        [130.46, 131.90], [132.34, 134.04]
    ]
};

/** Y sus palabras, con el reloj del DTW ya puesto: el ensayo y después la clase. */
const PALABRAS_CLASE_13 = [
    { start: 118.34, end: 118.57, text: 'Como' },
    { start: 118.88, end: 119.10, text: 'hoy,' },
    { start: 119.78, end: 119.79, text: 'saber' },
    { start: 120.24, end: 120.64, text: 'codiar' },
    { start: 121.64, end: 121.65, text: 'es' },
    { start: 130.54, end: 130.55, text: 'una' },
    { start: 130.72, end: 130.73, text: 'gran' },
    { start: 130.96, end: 130.97, text: 'ventaja' },
    { start: 131.42, end: 131.88, text: 'competitiva,' }
];

const BLOQUE_13 = { index: 0, view: 'PV', startSec: 126.767, endSec: 140.7 };

function palabra(text, start, dtw) {
    return { text, start, end: start + 0.3, ...(dtw != null ? { dtw } : {}) };
}

module.exports = function (t) {
    t.group('rescate · la firma que dice dónde mirar');

    t.test('el arranque del bloque 1 de la clase 13 dispara', () => {
        const h = rescate.buscarEnBloque(PALABRAS_CLASE_13, BLOQUE_13, VOZ_CLASE_13, null);
        t.ok(h, 'lo vio');
        t.eq(h.tramos, 3, 'los tres golpes de la cuenta');
        t.near(h.desdeSec, 127.12, 0.01, 'desde el primer sonido sin palabra encima');
        t.near(h.hastaSec, 130.54, 0.01, 'hasta la primera palabra apoyada en el sonido');
        t.eq(h.hastaPalabra, 'una');
    });

    t.test('el ensayo de delante no entra en lo que se relee', () => {
        // Son nueve segundos que el transcript SÍ escribió («Como hoy, saber
        // codiar es»), a un nivel que el mapa de voz deja afuera por lejano al
        // micrófono. Releerlos duplicaría esas palabras.
        const h = rescate.buscarEnBloque(PALABRAS_CLASE_13, BLOQUE_13, VOZ_CLASE_13, null);
        t.ok(h.leeDesdeSec > 126, `el pedazo arranca en ${h.leeDesdeSec}, no en el IN`);
        t.ok(h.leeDesdeSec < h.desdeSec, 'con algo de contexto por delante');
    });

    t.test('un solo tramo huérfano no alcanza', () => {
        // El bloque 2 de la clase 11: un único tramo de 1,68 s, que es el profesor
        // hablando ENCIMA del corte. El texto está, del otro lado del borde.
        const voz = { tramos: [[132.06, 133.74], [134.02, 136.00]] };
        const words = [{ start: 134.02, end: 134.36, text: 'Cypress.' }];
        const bloque = { index: 1, view: 'R', startSec: 133.70, endSec: 190 };
        t.eq(rescate.buscarEnBloque(words, bloque, voz, null), null);
        t.ok(rescate.buscarEnBloque(words, bloque, voz, { tramosMinimos: 1 }),
            'y con el listón en uno aparecería, que es por lo que está en dos');
    });

    t.test('un bloque que abre hablando no dispara', () => {
        const voz = { tramos: [[10, 20]] };
        const words = [{ start: 10.1, end: 10.4, text: 'Hola' }];
        t.eq(rescate.buscarEnBloque(words, { index: 0, startSec: 10, endSec: 30 }, voz, null), null);
    });

    t.test('las migas del mapa no cuentan como voz', () => {
        // Sin el filtro de `speech-edges.VOZ_MINIMA_SEC`, los crujidos de sala de
        // 60-100 ms de los nueve segundos mudos de la clase 13 disparan solos: son
        // seis tramos huérfanos que no son nadie hablando.
        const soloMigas = { tramos: VOZ_CLASE_13.tramos.slice(0, 6).concat([[130.46, 131.90]]) };
        t.eq(rescate.buscarEnBloque(PALABRAS_CLASE_13, BLOQUE_13, soloMigas, null), null);
    });

    t.test('sin mapa de voz no se afirma nada', () => {
        t.eq(rescate.buscarEnBloque(PALABRAS_CLASE_13, BLOQUE_13, null, null), null);
        t.eq(rescate.buscarEnBloque(PALABRAS_CLASE_13, BLOQUE_13, { tramos: [] }, null), null);
    });

    t.test('la palabra que Whisper puso sobre el silencio no cierra la ventana', () => {
        // El bloque 19 de la clase 12: «Aquí» figura de 3600,86 a 3604,06 y adentro
        // de esos 3,2 s el micrófono registró 0,10. Preguntando por la primera
        // palabra a secas, esa tapaba la cuenta que hay detrás y el bloque no
        // aparecía; la palabra de verdad del arranque es «el», en 3610,18.
        const voz = { tramos: [
            [3599.22, 3599.74], [3600.86, 3600.96],
            [3605.40, 3605.68], [3605.90, 3606.42], [3607.58, 3607.88], [3608.44, 3608.72],
            [3610.06, 3611.36]
        ] };
        const words = [
            { start: 3599.52, end: 3599.68, text: 'ok.' },
            { start: 3600.86, end: 3604.06, text: 'Aquí' },
            { start: 3610.18, end: 3610.19, text: 'el' },
            { start: 3610.44, end: 3610.57, text: 'cambio' }
        ];
        const h = rescate.buscarEnBloque(words, { index: 18, view: 'R', startSec: 3600.533, endSec: 3665.1 }, voz, null);
        t.ok(h, 'lo vio');
        t.eq(h.hastaPalabra, 'el');
        t.eq(h.tramos, 4);
    });

    t.test('solo los bloques que salen en la clase', () => {
        const blocks = [
            { ...BLOQUE_13, index: 0, enabled: false },
            { ...BLOQUE_13, index: 1 }
        ];
        t.eq(rescate.buscar(PALABRAS_CLASE_13, blocks, VOZ_CLASE_13, null).length, 1);
        t.eq(rescate.buscar(PALABRAS_CLASE_13, blocks, VOZ_CLASE_13, null)[0].bloque, 1);
    });

    t.group('rescate · qué palabra de la relectura entra');

    const HALLAZGO_13 = { desdeSec: 127.12, hastaSec: 130.54, leeDesdeSec: 126.62, leeHastaSec: 131.04 };

    t.test('lo que cae en el agujero entra y lo de después no', () => {
        // La relectura de verdad del pedazo de la clase 13. «una» está del otro
        // lado del borde: el transcript ya la tiene.
        const leidas = [
            palabra('tres,', 126.85, 127.22),
            palabra('dos,', 127.80, 127.94),
            palabra('uno.', 128.38, 128.52),
            palabra('Hoy', 129.10, 129.38),
            palabra('bytecodear', 129.60, 129.86),
            palabra('una', 130.60, 130.68)
        ];
        const f = rescate.filtrar(PALABRAS_CLASE_13, leidas, HALLAZGO_13, null);
        t.deep(f.nuevas.map(w => w.text), ['tres,', 'dos,', 'uno.', 'Hoy', 'bytecodear']);
        t.eq(f.fuera, 1, 'la de más allá del borde se descarta');
    });

    t.test('una palabra igual y en el mismo instante no se agrega dos veces', () => {
        // El bloque 13 de la clase 3: la relectura trae un «punto» a 30 ms del
        // «punto» que el transcript ya tenía. Meter los dos deja el guion
        // tartamudeando.
        const palabras = [{ start: 128.40, end: 128.60, text: 'uno.' }];
        const f = rescate.filtrar(palabras, [palabra('Uno.', 128.30, 128.52)], HALLAZGO_13, null);
        t.eq(f.nuevas.length, 0);
        t.eq(f.repetidas, 1);
    });

    t.test('la misma palabra dicha en otro momento sí', () => {
        // Las dos tomas de una frase dicen las mismas palabras y las dos suenan de
        // verdad: comparar solo el texto se comería la toma buena.
        const palabras = [{ start: 118.88, end: 119.10, text: 'hoy,' }];
        const f = rescate.filtrar(palabras, [palabra('Hoy', 129.10, 129.38)], HALLAZGO_13, null);
        t.eq(f.nuevas.length, 1);
        t.eq(f.repetidas, 0);
    });

    t.test('el instante que manda es el del DTW', () => {
        // Es el que `engine/reloj.js` va a usar para ubicarla. Esta palabra tiene
        // el `start` del pedazo —pegado al borde, como Whisper los entrega— y el
        // DTW dentro del agujero.
        const conDtw = { text: 'tres,', start: 126.62, end: 127.90, dtw: 127.22 };
        t.near(rescate.instante(conDtw), 127.22 - relojes.DESFASE_DTW_SEC, 0.001);
        t.eq(rescate.filtrar([], [conDtw], HALLAZGO_13, null).nuevas.length, 1);
    });

    t.test('sin DTW se usa el crudo, que es lo único que hay', () => {
        t.eq(rescate.instante({ text: 'x', start: 5, end: 6 }), 5);
    });

    t.group('rescate · la mezcla no desordena ni pisa');

    t.test('la cuenta entra donde se oye y no donde dice el `start`', () => {
        // **El caso que decidió mezclar por el instante del DTW.** En la clase 13,
        // «una gran ventaja competitiva» figura con `start` de 121,41 a 131,88 —o
        // sea repartida encima de la cuenta— mientras su DTW la pone entre 130,68 y
        // 131,56. Mezclando por `start`, la cuenta caía en medio de esas cuatro
        // palabras y el guion salía diciendo «una gran ventaja 3, competitiva, 2, 1.».
        const crudas = [
            { start: 120.64, end: 121.41, text: 'es', dtw: 121.78 },
            { start: 121.41, end: 122.57, text: 'una', dtw: 130.68 },
            { start: 122.57, end: 124.12, text: 'gran', dtw: 130.86 },
            { start: 124.12, end: 127.78, text: 'ventaja', dtw: 131.10 },
            { start: 127.78, end: 131.88, text: 'competitiva,', dtw: 131.56 }
        ];
        const nuevas = [
            { start: 126.62, end: 127.80, text: 'tres,', dtw: 127.22 },
            { start: 127.80, end: 128.38, text: 'dos,', dtw: 127.94 },
            { start: 128.38, end: 129.10, text: 'uno.', dtw: 128.52 }
        ];
        const mezclado = rescate.mezclar(crudas, nuevas);
        t.deep(mezclado.palabras.map(w => w.text),
            ['es', 'tres,', 'dos,', 'uno.', 'una', 'gran', 'ventaja', 'competitiva,']);
        t.eq(mezclado.agregadas, 3);
    });

    t.test('la palabra injertada entra sin duración, con su instante intacto', () => {
        // Del pedazo solo se midió el DTW: con `-ml 1 -sow` cada palabra es un
        // segmento y los segmentos van pegados, así que su `end` no es dónde deja de
        // sonar, es dónde arranca la siguiente. Guardarlo pegaba el piso del IN al
        // corte y dejaba el bloque 8 de la clase 7 cortado encima de la voz.
        const crudas = [{ start: 120.64, end: 121.41, text: 'es', dtw: 121.78 }];
        const nuevas = [
            { start: 126.62, end: 127.80, text: 'tres,', dtw: 127.22 },
            { start: 127.80, end: 128.38, text: 'dos,', dtw: 127.94 }
        ];
        const { palabras } = rescate.mezclar(crudas, nuevas);
        t.eq(palabras[1].start, 121.41, 'pegada al final de la anterior');
        t.near(palabras[1].end, 127.22 - relojes.DESFASE_DTW_SEC + relojes.RESOLUCION_DTW_SEC, 0.001,
            'y cerrando en su propio instante: de su duración no se sabe nada');
        t.eq(palabras[1].dtw, 127.22, 'lo único que se midió queda intacto');
        for (let i = 1; i < palabras.length; i++) {
            t.ok(palabras[i].start >= palabras[i - 1].start, 'y el array queda en orden');
        }
    });

    t.test('el techo de la tirada alcanza para las palabras injertadas', () => {
        // `reloj.deDtw` no deja que ninguna palabra arranque después del final más
        // tardío de su tirada. Cerrando el injerto en el `start` heredado —que en un
        // tramo mal leído está ANTES del agujero— ese techo caía antes que la cuenta
        // y las tres palabras se aplastaban en el mismo instante.
        const crudas = [
            { start: 120.64, end: 121.41, text: 'es', dtw: 121.78 },
            { start: 121.41, end: 122.57, text: 'una', dtw: 130.68 }
        ];
        const nuevas = [
            { start: 126.62, end: 127.80, text: 'tres,', dtw: 127.22 },
            { start: 127.80, end: 128.38, text: 'dos,', dtw: 127.94 },
            { start: 128.38, end: 129.10, text: 'uno.', dtw: 128.52 }
        ];
        const { palabras } = relojes.paraDecidir(rescate.mezclar(crudas, nuevas).palabras, 'auto');
        const cuenta = palabras.filter(w => ['tres,', 'dos,', 'uno.'].includes(w.text));
        t.eq(new Set(cuenta.map(w => w.start)).size, 3,
            `tres arranques distintos, salieron ${cuenta.map(w => w.start).join(' ')}`);
        t.near(cuenta[2].start, 128.52 - relojes.DESFASE_DTW_SEC, 0.001);
    });

    t.test('el piso del IN deja entrar el colchón de aire', () => {
        // La prueba de vuelta del defecto: `wordLimits` saca el piso del IN del
        // final de la palabra anterior, y con la cuenta cerrando donde abre la toma
        // ese piso quedaba ENCIMA del corte. Diez cuadros son 0,33 s: el piso tiene
        // que dejar por lo menos eso.
        const crudas = [
            { start: 2073.91, end: 2075.16, text: 'te', dtw: 2072.52 },
            { start: 2075.16, end: 2084.26, text: 'preguntó', dtw: 2084.06 }
        ];
        const nuevas = [
            { start: 2076.46, end: 2077.91, text: '3,', dtw: 2077.10 },
            { start: 2077.91, end: 2078.69, text: '2,', dtw: 2078.02 },
            { start: 2078.69, end: 2079.42, text: '1.', dtw: 2078.84 },
            { start: 2079.42, end: 2079.91, text: 'Ahora', dtw: 2079.54 }
        ];
        const { palabras } = relojes.paraDecidir(rescate.mezclar(crudas, nuevas).palabras, 'auto');
        const abre = palabras.find(w => w.text === 'Ahora').start;
        const piso = speech.wordLimits(palabras, abre, 'IN').minTime;
        t.ok(abre - piso >= 10 / 30,
            `el piso quedó en ${piso} con el corte en ${abre}: ${((abre - piso) * 30).toFixed(1)} cuadros`);
    });

    t.test('sin DTW el pedazo entra con los tiempos que trae', () => {
        // No hay de dónde sacar la posición: pasa con un modelo sin grilla de
        // cabezas de atención conocida, que es el mismo caso en el que el reloj del
        // panel va por `engine/retimeo.js`.
        const crudas = [{ start: 120.64, end: 121.41, text: 'es' }];
        const { palabras } = rescate.mezclar(crudas, [{ start: 127.10, end: 127.80, text: 'tres,' }]);
        t.eq(palabras[1].start, 127.10);
        t.eq(palabras[1].end, 127.80);
    });

    t.test('y con eso la cuenta queda al principio del bloque, donde el motor la ve', () => {
        // La prueba de que esto sirve para algo: el recorte del habla del director
        // ya sabe quitar un conteo del arranque, y hasta ahora no tenía qué quitar.
        const crudas = [
            { start: 120.64, end: 121.41, text: 'es', dtw: 121.78 },
            { start: 121.41, end: 122.57, text: 'una', dtw: 130.68 },
            { start: 122.57, end: 124.12, text: 'gran', dtw: 130.86 },
            { start: 124.12, end: 127.78, text: 'ventaja', dtw: 131.10 },
            { start: 127.78, end: 131.88, text: 'competitiva,', dtw: 131.56 }
        ];
        const nuevas = [
            { start: 126.62, end: 127.80, text: 'tres,', dtw: 127.22 },
            { start: 127.80, end: 128.38, text: 'dos,', dtw: 127.94 },
            { start: 128.38, end: 129.10, text: 'uno.', dtw: 128.52 }
        ];
        const { palabras } = relojes.paraDecidir(rescate.mezclar(crudas, nuevas).palabras, 'auto');
        const dentro = speech.wordsInside(palabras, 126.767, 140.7);
        t.eq(speech.finDeConteo(dentro), 2, `el conteo cierra en la tercera: «${dentro.map(speech.textOf).join(' ')}»`);
        const recorte = speech.trimChatter(palabras, 126.767, 140.7, { minKeepSec: 1 });
        t.near(recorte.startSec, 130.68 - relojes.DESFASE_DTW_SEC, 0.01,
            `el bloque abre en «una», pasada la cuenta, y no en ${recorte.startSec}`);
    });

    t.test('la palabra que el DTW pone después de la cuenta se acomoda sola', () => {
        // El bloque 19 de la clase 12: el «Aquí» de la toma buena tiene `start`
        // 3600,86 —nueve segundos antes de la cuenta— y DTW 3610,14, o sea DESPUÉS.
        // Con el orden del DTW el bloque abre en «Aquí el cambio fundamental», que
        // es lo que dice la nota del CD.
        const crudas = [
            { start: 3599.22, end: 3599.68, text: 'ok.', dtw: 3599.66 },
            { start: 3600.86, end: 3604.06, text: 'Aquí', dtw: 3610.14 },
            { start: 3604.06, end: 3605.69, text: 'el', dtw: 3610.32 }
        ];
        const nuevas = [
            { start: 3604.90, end: 3605.96, text: '3,', dtw: 3605.58 },
            { start: 3605.96, end: 3608.34, text: '2,', dtw: 3608.48 },
            { start: 3608.34, end: 3610.00, text: '1.', dtw: 3609.26 }
        ];
        t.deep(rescate.mezclar(crudas, nuevas).palabras.map(w => w.text),
            ['ok.', '3,', '2,', '1.', 'Aquí', 'el']);
    });

    t.test('mezclar no toca lo que entra', () => {
        const crudas = [{ start: 1, end: 2, text: 'a', dtw: 1 }];
        const copia = JSON.parse(JSON.stringify(crudas));
        rescate.mezclar(crudas, [{ start: 3, end: 4, text: 'b', dtw: 3 }]);
        t.deep(crudas, copia);
    });

    t.test('sin nada que agregar la lista queda igual', () => {
        const crudas = [{ start: 1, end: 2, text: 'a' }];
        t.deep(rescate.mezclar(crudas, []).palabras, crudas);
        t.eq(rescate.mezclar(crudas, null).agregadas, 0);
    });

    t.test('el orden de lo que llega no importa', () => {
        const nuevas = [
            { start: 5, end: 6, text: 'c', dtw: 5 },
            { start: 3, end: 4, text: 'a', dtw: 3 },
            { start: 4, end: 5, text: 'b', dtw: 4 }
        ];
        t.deep(rescate.mezclar([], nuevas).palabras.map(w => w.text), ['a', 'b', 'c']);
    });

    t.group('rescate · sin Live-Mix no hay nada que releer');

    t.test('sin audio ni mapa devuelve las palabras que entraron', async () => {
        const r = await rescate.rescatar({
            crudas: PALABRAS_CLASE_13, words: PALABRAS_CLASE_13,
            blocks: [BLOQUE_13], wav: null, voz: VOZ_CLASE_13
        });
        t.deep(r.palabras, PALABRAS_CLASE_13);
        t.eq(r.stats.encontrados, 0, 'ni se busca: la firma necesita las dos cosas');
    });
};
