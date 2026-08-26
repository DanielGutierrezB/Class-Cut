'use strict';
/**
 * Los bordes con criterio: que no entre lo que el profesor le dice al editor,
 * que el bloque cierre una idea, y que una respuesta inventada del modelo no
 * mueva nada.
 */

const speech = require('../engine/speech-edges');
const refine = require('../engine/cut-refine');
const coherence = require('../engine/coherence');
const ai = require('../engine/ai-local');
const orden = require('../engine/orden-del-cd');
const fcp = require('../engine/fcp-xml');
const precision = require('../engine/vendor/marker-precision');

/** Palabras con tiempos a partir de un texto. */
function say(text, startSec, wordSec) {
    const step = wordSec || 0.3;
    return text.split(/\s+/).map((word, i) => ({
        text: word,
        start: Math.round((startSec + i * step) * 1000) / 1000,
        end: Math.round((startSec + i * step + step * 0.85) * 1000) / 1000
    }));
}

module.exports = function (t) {
    t.group('speech-edges · habla del director');

    t.test('"pausa" y "corte" son siempre del director', () => {
        t.eq(speech.isChatter({ text: 'Pausa.' }, 0), true);
        t.eq(speech.isChatter({ text: 'corte' }, 0), true);
    });

    t.test('el número en cifra es conteo; en letra, solo si viene acompañado', () => {
        // Whisper escribe en cifra el conteo de la toma y en letra el número
        // hablado. "Tres." suelto es "Tres cosas antes de empezar", que es clase.
        t.eq(speech.isChatter({ text: '3,' }, 0), true);
        t.eq(speech.isChatter({ text: 'Tres.' }, 0), false, 'suelto es una palabra normal');
        t.eq(speech.isChatter({ text: 'Tres.' }, 0, null, { text: 'dos' }), true, 'en fila es conteo');
    });

    t.test('"listo" solo cuenta si viene después de un silencio', () => {
        t.eq(speech.isChatter({ text: 'listo' }, 0.05), false, 'dentro de la frase es una palabra normal');
        t.eq(speech.isChatter({ text: 'listo' }, 1.2), true, 'suelto es un aparte al editor');
    });

    t.test('una palabra cualquiera nunca es del director', () => {
        t.eq(speech.isChatter({ text: 'constitución' }, 3), false);
    });

    t.group('speech-edges · el conector que el CD pidió');

    t.test('el conector que abre la orden del CD no es un defecto', () => {
        // Los 12 del curso son este caso: el director marcó el bloque en el
        // conector, así que el bloque abre ahí porque él lo quiso.
        t.eq(speech.conectorSinPedir({ text: 'Y' }, 'Y en 4º tenemos los no objetivos'), false);
        t.eq(speech.conectorSinPedir({ text: 'Pero' }, 'Pero antes de abrir la terminal, quiero'), false);
        t.eq(speech.conectorSinPedir({ text: 'También' }, 'También nos está dando una información m'), false);
    });

    t.test('el que el CD no pidió sí lo es', () => {
        // Acá el corte se fue solo hasta un conector: eso es lo que esta cuenta
        // existe para ver.
        t.eq(speech.conectorSinPedir({ text: 'Entonces' }, 'lo que vamos a hacer es'), true);
    });

    t.test('la puntuación y las mayúsculas no cambian la respuesta', () => {
        // El CD escribe "Y," y Whisper transcribe "y": es la misma palabra, y
        // comparándolas crudas el bloque 9 de la clase 4 contaba como defecto.
        t.eq(speech.conectorSinPedir({ text: 'y' }, 'Y, finalmente, el 6º componente'), false);
        t.eq(speech.conectorSinPedir({ text: 'Entonces,' }, 'Entonces, lo que vamos a hacer'), false);
    });

    t.test('una palabra que no es conector nunca es un defecto', () => {
        // Aunque el CD haya marcado el bloque en otra parte: lo que se cuenta es
        // el arranque que se apoya en algo de antes, no el desacuerdo con la nota.
        t.eq(speech.conectorSinPedir({ text: 'Ahora' }, 'la fuente de la verdad'), false);
        t.eq(speech.conectorSinPedir({ text: 'Luego' }, 'la fuente de la verdad'), false,
            '"luego" apunta hacia adelante y abre bien');
    });

    t.test('sin orden del CD, el conector se cuenta', () => {
        // Una clase sin notas no puede justificar ningún arranque.
        t.eq(speech.conectorSinPedir({ text: 'Pero' }, ''), true);
        t.eq(speech.conectorSinPedir({ text: 'Pero' }, null), true);
    });

    t.test('los conectores de dos palabras existen', () => {
        // La lista los traía escritos desde el principio y la expresión se
        // probaba contra UNA palabra, así que esa mitad no podía coincidir
        // nunca. Ninguna de sus palabras sueltas es un conector, que es
        // justamente por lo que no se notaba.
        t.eq(speech.esConector([{ text: 'Sin' }]), false, '"sin" solo no es nada');
        t.eq(speech.esConector([{ text: 'Sin' }, { text: 'embargo,' }]), true);
        t.eq(speech.largoDeConector([{ text: 'Así' }, { text: 'que' }]), 2);
        t.eq(speech.largoDeConector([{ text: 'O' }, { text: 'sea,' }]), 2);
        t.eq(speech.largoDeConector([{ text: 'Y' }, { text: 'entonces' }]), 1,
            'la de una palabra sigue midiendo una');
        t.eq(speech.largoDeConector([{ text: 'Ahora' }, { text: 'sí' }]), 0);
    });

    t.test('el conector de dos que el CD pidió tampoco es un defecto', () => {
        // Los 3 que aparecieron al arreglarlo son este caso, igual que los 12
        // de una palabra: clase 1 bloques 9 y 11, y clase 12 bloque 17.
        const sinEmbargo = [{ text: 'Sin' }, { text: 'embargo,' }];
        t.eq(speech.conectorSinPedir(sinEmbargo, 'Sin embargo, acá tenemos una situación'), false);
        t.eq(speech.conectorSinPedir([{ text: 'Así' }, { text: 'que' }],
            'Así, que vamos directamente le damos spe'), false, 'la coma del CD no cuenta');
        // Y se comparan las DOS: con la primera sola, cualquier cue que
        // empezara con "Sin" daría el conector por pedido.
        t.eq(speech.conectorSinPedir(sinEmbargo, 'Sin duda es la parte más difícil'), true);
    });

    t.group('speech-edges · abrir partiendo una frase');

    /** Un mapa de voz de juguete: los tramos donde suena alguien. */
    const suena = tramos => ({ tramos });
    // Habla de corrido: cualquier corte cae encima de alguien hablando.
    const deCorrido = suena([[0, 60]]);

    t.test('abrir a mitad de frase se ve', () => {
        const words = say('Ahora vamos a hacer el ejercicio completo.', 0);
        // El corte cae pasado "Ahora": lo que abre es "vamos a hacer…".
        t.eq(speech.abreAMitad(words, 0.28, 3, deCorrido), true);
    });

    t.test('abrir donde la frase arranca no es un defecto', () => {
        const words = say('Cerramos la idea anterior.', 0).concat(say('Ahora vamos a hacer el ejercicio.', 3));
        t.eq(speech.abreAMitad(words, 2.9, 6, deCorrido), false);
    });

    t.test('el conteo de la toma no cuenta como frase partida', () => {
        // El motor tira la cuenta a propósito, así que del otro lado del corte
        // queda un "uno," sin punto. Eso no es una frase partida: es un corte
        // bueno. Sin descontarlo, el curso informaba 16 de estos y tiene 7.
        const words = [
            { text: 'Tres,', start: 0, end: 0.3 },
            { text: 'dos,', start: 0.4, end: 0.7 },
            { text: 'uno,', start: 0.8, end: 1.1 }
        ].concat(say('que si lo piensas bien es lo mismo.', 2));
        t.eq(speech.abreAMitad(words, 1.9, 5, deCorrido), false);
    });

    t.test('el primer bloque de la clase no abre partiendo nada', () => {
        const words = say('vamos a empezar por el principio.', 0);
        t.eq(speech.abreAMitad(words, 0, 3, deCorrido), false, 'no hay nada delante');
    });

    t.test('la palabra que en la onda no está no se perdió', () => {
        // Los 4 casos del curso que esta cuenta informaba de más: el bloque abre
        // en el ATAQUE de la primera palabra de la toma, y el transcript pone
        // esa palabra unos milisegundos antes con duración casi cero, así que
        // `wordsInside` la deja afuera por su margen. En la onda, entre donde el
        // reloj la pone y el corte no hay nada.
        const words = say('Ahora vamos a hacer el ejercicio completo.', 0);
        // "Ahora" figura en 0–0.255 y el corte cae en 0.28.
        t.eq(speech.abreAMitad(words, 0.28, 3, suena([[0.3, 3]])), false,
            'el sonido arranca después del corte: no se fue nada');
        t.eq(speech.abreAMitad(words, 0.28, 3, suena([[0.26, 3]])), false,
            'rozar el ataque no es llevárselo: el corte se escribe en frames');
        t.eq(speech.abreAMitad(words, 0.28, 3, deCorrido), true,
            'con la palabra sonando del otro lado, sí se la llevó');
    });

    t.test('sin mapa de voz no se afirma que abre partiendo una frase', () => {
        // Y quien mide tiene que contarlos aparte (`defectos.contarClase`
        // devuelve `sinVoz`): un cero de "no miré" se lee igual que un cero de
        // "no hay", y son cosas opuestas.
        const words = say('Ahora vamos a hacer el ejercicio completo.', 0);
        t.eq(speech.abreAMitad(words, 0.28, 3, null), false);
        t.eq(speech.suenaEntre(null, 0, 0.28), null, 'y se puede preguntar si se pudo medir');
    });

    t.group('speech-edges · límites de palabra');

    t.test('el OUT no puede llegar a la palabra siguiente', () => {
        const words = say('la idea termina acá', 10).concat(say('Pausa', 12.5));
        const limits = speech.wordLimits(words, 12.2, 'OUT');
        t.eq(limits.maxTime, 12.5, 'el tope es donde empieza "Pausa"');
    });

    t.test('el IN no puede llevarse la palabra anterior', () => {
        const words = say('algo anterior', 5).concat(say('arranca el bloque', 9));
        const limits = speech.wordLimits(words, 8.9, 'IN');
        t.ok(limits.minTime <= 8.9 && limits.minTime > 5, `minTime raro: ${limits.minTime}`);
    });

    t.test('el más ajustado de dos límites es el que manda', () => {
        const merged = speech.tightest({ minTime: 5, maxTime: 20 }, { minTime: 8, maxTime: 15 });
        t.deep(merged, { minTime: 8, maxTime: 15 });
        t.deep(speech.tightest({ minTime: null, maxTime: 9 }, { minTime: 3, maxTime: null }),
            { minTime: 3, maxTime: 9 });
    });

    t.group('speech-edges · recorte del chatter');

    t.test('el "Pausa" del final se va y el bloque queda entero', () => {
        const words = say('esto es lo que queremos decir.', 10).concat(say('Pausa.', 12));
        const cut = speech.trimChatter(words, 9.9, 12.6);
        t.ok(cut.endSec <= 12, `el corte tenía que retroceder, quedó en ${cut.endSec}`);
        t.deep(cut.removed, ['Pausa.']);
    });

    t.test('el conteo del principio no entra', () => {
        const words = say('tres dos uno', 5).concat(say('ahora sí empieza la clase.', 7));
        const cut = speech.trimChatter(words, 4.9, 9.5);
        t.ok(cut.startSec >= 5.3, `debería arrancar después del conteo, arrancó en ${cut.startSec}`);
    });

    t.test('con palabras solapadas el conteo se va igual', () => {
        // Whisper devuelve palabras que se pisan: en la clase 10 el "3," iba de
        // 76.92 a 77.31 y "para" arrancaba en 77.24, antes de que el "3,"
        // terminara. Abrir donde empieza la siguiente dejaba el conteo medio
        // adentro, y el bucle lo sacaba doce veces sin moverse del lugar.
        const words = [
            { text: '3,', start: 76.92, end: 77.31 },
            { text: 'para', start: 77.24, end: 77.34 },
            { text: 'eso', start: 77.34, end: 78.20 },
            { text: 'vamos', start: 78.20, end: 78.80 },
            { text: 'a', start: 78.80, end: 78.90 },
            { text: 'empezar.', start: 78.90, end: 79.60 }
        ];
        const cut = speech.trimChatter(words, 76.57, 79.9);
        t.deep(cut.removed, ['3,'], 'tenía que sacarlo una sola vez');
        t.ok(cut.startSec >= 77.31, `el conteo quedó adentro: abre en ${cut.startSec}`);

        const dentro = speech.wordsInside(words, cut.startSec, cut.endSec);
        t.ok(!speech.isChatter(dentro[0], 999), `abre en «${speech.textOf(dentro[0])}»`);
    });

    t.test('un "Ok." pegado no le tapa el conteo que viene detrás', () => {
        // Clase 13: el bloque abría con «Ok. 3, 2, 1. En este curso,» entero. El
        // bucle miraba el "Ok.", no le encontraba silencio propio delante y
        // paraba ahí, sin llegar nunca al conteo.
        const words = [
            { text: 'proyecto.', start: 700.0, end: 700.6 },
            { text: 'Ok.', start: 700.7, end: 700.9 },
            { text: '3,', start: 701.0, end: 701.3 },
            { text: '2,', start: 701.4, end: 701.7 },
            { text: '1.', start: 701.8, end: 702.1 },
            { text: 'En', start: 702.4, end: 702.6 },
            { text: 'este', start: 702.6, end: 702.9 },
            { text: 'curso,', start: 702.9, end: 703.4 },
            { text: 'vamos', start: 703.4, end: 703.9 },
            { text: 'a', start: 703.9, end: 704.0 },
            { text: 'ver.', start: 704.0, end: 704.5 }
        ];
        const cut = speech.trimChatter(words, 700.7, 704.6);
        t.ok(cut.startSec >= 702.1, `abre en ${cut.startSec}, con el conteo adentro`);
        const dentro = speech.wordsInside(words, cut.startSec, cut.endSec);
        t.eq(speech.textOf(dentro[0]), 'En');
    });

    t.test('un "Uno" suelto no es un conteo y no se toca', () => {
        // "Uno de los problemas más comunes" abre una clase de verdad. Pedir dos
        // seguidas es lo único que separa el conteo de la palabra.
        const words = say('Uno de los problemas más comunes es este.', 20);
        const cut = speech.trimChatter(words, 19.9, 24);
        t.eq(cut.startSec, 19.9, 'no tenía que moverse');
        const dentro = speech.wordsInside(words, cut.startSec, cut.endSec);
        t.eq(speech.textOf(dentro[0]), 'Uno');
    });

    t.test('recortar no puede dejar el bloque en nada', () => {
        const words = say('Pausa.', 10);
        const cut = speech.trimChatter(words, 9.9, 10.4);
        t.eq(cut.startSec, 9.9, 'si no queda nada, se deja como estaba');
        t.deep(cut.removed, []);
    });

    t.group('speech-edges · cerrar la frase');

    t.test('un fragmento colgando se retrae a la frase anterior', () => {
        // "…que debes aprender. Igual," — el caso real medido 103 veces.
        const words = say('esa es la metodología que debes aprender.', 10)
            .concat(say('Igual, esto sigue después', 12.5));
        const snap = speech.snapToSentence(words, 13.1, 'OUT');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec < 12.5, `tenía que retroceder, quedó en ${snap.timeSec}`);
        t.ok(/retrajo/.test(snap.how), snap.how);
    });

    t.test('una frase cortada por la mitad se extiende hasta cerrar', () => {
        const words = say('la documentación se vuelve un artefacto vivo que le va a dar órdenes al modelo.', 10);
        const snap = speech.snapToSentence(words, 12.3, 'OUT');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec > 12.3, `tenía que extenderse, quedó en ${snap.timeSec}`);
        t.ok(/extendió/.test(snap.how), snap.how);
    });

    t.test('no se extiende más allá de una orden al editor', () => {
        const words = say('esto queda a medias', 10).concat(say('Pausa. y sigue otra cosa.', 11.4));
        const snap = speech.snapToSentence(words, 11.2, 'OUT');
        t.ok(!snap.moved || snap.timeSec <= 11.4, `se pasó del "Pausa": ${snap.timeSec}`);
    });

    t.test('un borde que ya cierra una frase no se toca', () => {
        const words = say('esto cierra bien.', 10).concat(say('otra cosa después', 13));
        const snap = speech.snapToSentence(words, 11.1, 'OUT');
        t.eq(snap.moved, false);
        t.ok(/ya cerraba/.test(snap.how), snap.how);
    });

    t.test('el IN se abre al principio de la frase, no a la mitad', () => {
        const words = say('lo primero que hay que entender es esto.', 10)
            .concat(say('Y ahora viene lo importante de verdad.', 14));
        const snap = speech.snapToSentence(words, 15.2, 'IN');
        t.eq(snap.moved, true);
        t.ok(snap.timeSec <= 14.1, `tenía que abrir en "Y", quedó en ${snap.timeSec}`);
    });

    t.group('cut-refine · desde dónde se puntuó');

    t.test('el borde guarda el sitio que ocupaba antes de afinarlo', async () => {
        // Sin esto, `tools/mirar-colgados.js` no puede repetir la elección: la
        // repetía desde donde el borde terminó, o sea desde el sitio al que lo
        // movió la elección que estaba juzgando, y desde ahí siempre gana otro.
        const words = say('esta es la primera idea y ya cierra.', 10)
            .concat(say('Y acá arranca la segunda, que sigue un rato largo.', 14));
        const block = {
            index: 0, startSec: 10, endSec: 15.4,
            in: { kind: 'IN' }, out: { kind: 'OUT' }
        };
        const alignResult = { blocks: [block] };
        await refine.refineClass({ alignResult, words, wav: null, options: { fps: 30 }, ai: null });

        for (const kind of ['in', 'out']) {
            if (!block[kind].refine) continue;
            t.eq(typeof block[kind].refine.anchorSec, 'number', `el ${kind} no guardó desde dónde puntuó`);
        }
        // Y es el sitio de ANTES, no el de después: si el afinado movió el
        // borde, guardar el final haría que el número no sirviera para nada.
        if (block.out.refine) t.eq(block.out.refine.anchorSec, 15.4);
    });

    t.group('speech-edges · ¿este transcript sirve para cortar?');

    t.test('cuenta las palabras que cierran frase y el pozo entre una y otra', () => {
        const words = say('esto cierra.', 10).concat(say('y esto tarda mucho en cerrar.', 40));
        const d = speech.densidadDeCierres(words);
        t.eq(d.palabras, 8);
        t.eq(d.cierres, 2);
        t.eq(d.ratio, 0.25);
        t.ok(d.pozoSec > 30 && d.pozoSec < 32, `el pozo tenía que ser de ~31s, dio ${d.pozoSec}`);
    });

    t.test('el pozo cuenta también el tramo anterior al primer punto', () => {
        // Un transcript con un solo punto al final es el peor caso posible.
        // Midiendo solo "entre cierres" daba cero, o sea el mejor.
        const words = say('todo esto va sin puntuación durante un rato largo', 0, 5)
            .concat(say('cierra.', 60));
        t.ok(speech.densidadDeCierres(words).pozoSec > 55,
            `el pozo tenía que abarcar la clase entera, dio ${speech.densidadDeCierres(words).pozoSec}`);
    });

    t.test('una clase sana pasa y una trabada no', () => {
        // Los dos extremos medidos en el curso: las trece clases sanas van de
        // 9,3 % a 15,4 %, y la 6 con whisper trabado estaba en 2,5 %.
        const sana = [];
        for (let i = 0; i < 10; i++) sana.push(...say('una frase de nueve palabras que al final cierra.', i * 5));
        t.eq(speech.densidadDeCierres(sana).sirve, true);

        const trabada = say('a '.repeat(60).trim(), 0).concat(say('cierra.', 30));
        const medida = speech.densidadDeCierres(trabada);
        t.ok(medida.ratio < 0.05, `tenía que dar por debajo del 5%, dio ${medida.ratio}`);
        t.eq(medida.sirve, false);
    });

    t.test('sin palabras no se acusa al transcript: es una clase sin audio', () => {
        // De eso ya avisa el alineado, y contarlo dos veces manda al editor a
        // volver a transcribir algo que no tiene qué transcribir.
        t.eq(speech.densidadDeCierres([]).sirve, true);
        t.eq(speech.densidadDeCierres([]).ratio, 0);
    });

    t.test('las palabras sin tiempo no cuentan para el porcentaje', () => {
        const words = say('esto cierra.', 10).concat([{ text: 'fantasma.' }]);
        t.eq(speech.densidadDeCierres(words).palabras, 2);
    });

    t.group('cut-refine · candidatos');

    t.test('los finales de frase entran como candidatos aunque no haya pausa', () => {
        // El caso del bloque 4: todo hablado de corrido, el cierre bueno está en
        // el punto y no en ninguna pausa.
        const words = say('la documentación se vuelve un artefacto vivo que le va a dar órdenes al modelo.', 100);
        const merged = refine.withSentenceCandidates({ candidates: [], current: 0 }, words, 103, 'OUT', {});
        t.ok(merged.candidates.length >= 1, 'tiene que ofrecer el final de la frase');
        t.ok(merged.candidates.some(c => c.fromSentence), 'y marcarlo como tal');
    });

    t.test('un candidato que deja "Pausa" adentro se descarta', () => {
        const words = say('esto termina acá.', 10).concat(say('Pausa.', 11.5));
        const bad = { frontier: 12.2, gapSec: 0.1 };
        t.eq(refine.dropsChatter(bad, words, 'OUT'), true);
    });

    t.test('no se le ofrece un corte que deja la claqueta hablada adentro', () => {
        // Clase 6, bloque 1: abría con «Claqueta 6, clase 6. 3, 2, 1. Ya Clauco…»
        // y el candidato pasaba el filtro porque mira solo la palabra que sigue al
        // corte, y "Claqueta" no está en ninguna lista de charla.
        const words = say('Claqueta 6, clase 6. 3, 2, 1. Ya Clauco nos entregó los planos.', 8);
        t.eq(refine.dropsChatter({ frontier: 7.9, gapSec: 1 }, words, 'IN'), true);
        const despues = words.find(w => w.text === 'Clauco');
        t.eq(refine.dropsChatter({ frontier: despues.start, gapSec: 1 }, words, 'IN'), false,
            'el que abre después del conteo sí sirve');
    });

    t.test('un borde no puede pasarse del otro extremo del bloque', () => {
        const block = { startSec: 578, endSec: 587 };
        // El IN no puede irse tan adelante que se coma el bloque entero.
        t.eq(refine.fitsInBlock({ time: 582.5 }, block, 'IN', {}), true);
        t.eq(refine.fitsInBlock({ time: 586.5 }, block, 'IN', {}), false);
        // Ni el OUT retroceder por detrás del IN.
        t.eq(refine.fitsInBlock({ time: 582.5 }, block, 'OUT', {}), true);
        t.eq(refine.fitsInBlock({ time: 578.4 }, block, 'OUT', {}), false);
    });

    t.test('afinar los dos bordes no deja el bloque en duración negativa', async () => {
        // La clase 13: el IN se fue a 582.567 y el OUT a 582.533, cruzados por 34
        // milésimas, y el bloque desapareció del corte sin que nadie lo decidiera.
        const words = say('esto es una toma que se repite y se repite sin parar acá.', 578, 0.25)
            .concat(say('y esto ya es lo que de verdad importa de la clase.', 583, 0.25));
        const block = { note: '', cueIn: '', cueOut: '', startSec: 578, endSec: 587 };

        // Un modelo que empuja cada borde hacia el otro: el IN lo más adelante
        // que le dejen, el OUT lo más atrás. Es lo que pasó en la clase 13, donde
        // el modelo movió el IN para saltarse una toma repetida.
        const aiQueCruza = kind => ({
            ask: async ({ prompt }) => {
                const nums = [...prompt.matchAll(/\[(\d+)\] t=/g)].map(m => Number(m[1]));
                return { choice: kind === 'IN' ? nums[nums.length - 1] : nums[0], reason: 'al medio' };
            }
        });

        for (const kind of ['IN', 'OUT']) {
            const edge = { timeSec: kind === 'IN' ? block.startSec : block.endSec, decidedBy: 'nota' };
            const res = await refine.refineEdge({
                words, edge, block, blocks: [block], index: 0, kind,
                options: { fps: 30, clearMargin: 999 }, ai: aiQueCruza(kind)
            });
            if (res.changed) {
                if (kind === 'IN') block.startSec = res.timeSec;
                else block.endSec = res.timeSec;
            }
        }

        t.ok(block.endSec - block.startSec >= 1,
            `el bloque quedó durando ${(block.endSec - block.startSec).toFixed(3)}s`);
    });

    t.test('la lista que ve el modelo va numerada corrida', () => {
        // Al filtrar quedan huecos en los índices, y `resolveChoice` resuelve la
        // elección por posición: sin renumerar, "[5]" cae en otro corte.
        const filtrados = [
            { index: 1, time: 10, isCurrent: false },
            { index: 4, time: 12, isCurrent: true },
            { index: 7, time: 14, isCurrent: false }
        ];
        const shown = refine.renumbered(filtrados);
        t.deep(shown.candidates.map(c => c.index), [1, 2, 3]);
        t.eq(shown.current, 2, 'el punto actual tiene que seguir siendo el de t=12');
        t.eq(shown.candidates[shown.current - 1].time, 12);
    });

    t.test('al modelo no se le ofrece un corte que deja "Pausa" adentro', async () => {
        // El bloque 7 de la clase 01: las reglas descartaban el corte que dejaba
        // "Pausa." dentro, pero al modelo se le pasaba la lista sin filtrar y lo
        // elegía igual, así que el bloque cerraba en "Pausa." de todos modos.
        const words = say('y esto es justo lo que nos ocurre con el asunto.', 900)
            .concat(say('Pausa.', 910))
            .concat(say('Tres. Dos. Uno.', 914));
        const block = { note: '', cueIn: '', cueOut: '', startSec: 890, endSec: 911.5 };

        // Un modelo que siempre elige el último punto de la lista: si le ofrecen
        // uno que deja chatter adentro, lo va a tomar.
        let preguntado = false;
        const ai = {
            ask: async ({ prompt }) => {
                preguntado = true;
                const nums = [...prompt.matchAll(/\[(\d+)\] t=/g)].map(m => Number(m[1]));
                t.deep(nums, nums.map((_, i) => i + 1), 'los puntos van corridos desde [1]');
                return { choice: nums[nums.length - 1], reason: 'el último' };
            }
        };

        const res = await refine.refineEdge({
            words,
            edge: { timeSec: 911.5, decidedBy: 'nota' },
            block,
            blocks: [block],
            index: 0,
            kind: 'OUT',
            // Sin margen que alcance, no gana ninguno por regla y hay que preguntar.
            options: { fps: 30, clearMargin: 999 },
            ai
        });

        t.eq(preguntado, true, 'el escenario tiene que llegar a preguntarle al modelo');

        const dentro = speech.wordsInside(words, block.startSec, res.timeSec);
        const ultima = dentro[dentro.length - 1];
        t.ok(!speech.isChatter(ultima, 999),
            `el bloque cerró en «${speech.textOf(ultima)}»`);
    });

    t.test('cerrar una frase puntúa más que cortar en cualquier frontera', () => {
        const words = say('esto cierra la idea completa.', 10).concat(say('y esto es otra cosa', 12.5));
        const enFrase = refine.scoreCandidate({ frontier: 11.5, gapSec: 0.05 }, words, 'OUT', 11.5);
        const cierre = refine.scoreCandidate({ frontier: 11.65, gapSec: 0.85 }, words, 'OUT', 11.5);
        t.ok(cierre > enFrase, `cerrar (${cierre}) tiene que ganarle a cortar al voleo (${enFrase})`);
    });

    const bienAnclado = { confidence: 'alta', in: { anchored: true, snap: { how: 'ya cerraba' } }, out: { anchored: true, snap: { how: 'ya cerraba' } } };
    const dudoso = { confidence: 'media', in: { anchored: true }, out: { anchored: true } };
    const sinAnclar = { confidence: 'alta', in: { anchored: false }, out: { anchored: true } };

    t.test('por defecto se saltea el bloque que enganchó bien', () => {
        t.eq(refine.needsCriterion(bienAnclado), false);
        t.eq(refine.needsCriterion(dudoso), true);
        t.eq(refine.needsCriterion(sinAnclar), true);
    });

    t.test('un bloque que no existe no se mira nunca', () => {
        t.eq(refine.needsCriterion(null), false);
    });

    t.test('bien enganchado pero terminando a mitad de frase, se mira igual', () => {
        // La confianza mide el anclaje de la nota, no el corte que salió: cuatro
        // bloques del curso colgaban y no se miraban nunca (tools/mirar-colgados).
        const colgando = say('esta idea se queda sin cerrar porque', 10);
        t.eq(refine.needsCriterion({ ...bienAnclado, startSec: 10, endSec: 30 }, colgando), true);

        const cerrado = say('esta idea cierra completa.', 10);
        t.eq(refine.needsCriterion({ ...bienAnclado, startSec: 10, endSec: 30 }, cerrado), false,
            'con la frase cerrada sigue sin mirarse');
    });

    t.group('IA local · nada de lo que diga se aplica sin validar');

    t.test('una respuesta que no es JSON se descarta', () => {
        t.eq(ai.parseJson('el corte va en el segundo 42'), null);
    });

    t.test('un JSON envuelto en texto se rescata', () => {
        t.deep(ai.parseJson('```json\n{"choice": 4}\n```'), { choice: 4 });
        t.deep(ai.parseJson('Claro: {"choice": 2, "reason": "x"}'), { choice: 2, reason: 'x' });
    });

    t.test('un punto que no existe en la lista se rechaza', () => {
        const unit = { candidates: [{ index: 1, time: 10 }, { index: 2, time: 12 }], current: 0 };
        for (const inventado of [7, 0, -1]) {
            const res = precision.resolveChoice({ choice: inventado }, unit);
            t.eq(res.ok, false, `[${inventado}] no está en la lista y se aceptó`);
            t.eq(res.move, false);
        }
    });

    t.test('un tiempo en vez de un número de punto se rechaza', () => {
        const unit = { candidates: [{ index: 1, time: 10 }, { index: 2, time: 12 }], current: 0 };
        // El modelo contesta el segundo del corte, que es justo lo que no se le pide.
        for (const tiempo of ['920.5s', 't=920.5', 920.5]) {
            const res = precision.resolveChoice({ choice: tiempo }, unit);
            t.eq(res.ok, false, `«${tiempo}» pasó como si fuera un punto`);
        }
    });

    t.test('una respuesta inventada deja el corte donde estaba', async () => {
        const words = say('esto cierra una idea completa acá.', 100)
            .concat(say('y esto ya es del bloque siguiente.', 104));
        const block = { note: '', cueIn: '', cueOut: '', startSec: 95, endSec: 103 };
        const antes = 103;

        const res = await refine.refineEdge({
            words,
            edge: { timeSec: antes, decidedBy: 'nota' },
            block,
            blocks: [block],
            index: 0,
            kind: 'OUT',
            options: { fps: 30, clearMargin: 999 },
            ai: { ask: async () => ({ choice: 99, reason: 'me lo inventé' }) }
        });

        t.eq(res.changed, false, 'no se tenía que mover nada');
        t.eq(res.timeSec, antes);
        t.ok(/no ayudó/.test(res.reason), res.reason);
    });

    t.test('un hallazgo que apunta a un bloque que no existe se tira', () => {
        const script = { blocks: [{ n: 1 }, { n: 2 }] };
        const valid = coherence.validateFindings({
            hallazgos: [
                { bloque: 1, tipo: 'repetido', gravedad: 'alta', detalle: 'esto sí' },
                { bloque: 99, tipo: 'repetido', gravedad: 'alta', detalle: 'bloque inventado' },
                { bloque: 2, tipo: 'repetido', gravedad: 'alta', detalle: '' }
            ]
        }, script);
        t.eq(valid.length, 1);
        t.eq(valid[0].bloque, 1);
    });

    t.test('un tipo o una gravedad inventados se normalizan', () => {
        const valid = coherence.validateFindings({
            hallazgos: [{ bloque: 1, tipo: 'catastrófico', gravedad: 'urgentísima', detalle: 'algo' }]
        }, { blocks: [{ n: 1 }] });
        t.eq(valid[0].tipo, 'otro');
        t.eq(valid[0].gravedad, 'media');
    });

    t.group('IA local · cuánta ventana se le pide a Ollama');

    t.test('un prompt corto no pide una ventana enorme', () => {
        t.eq(ai.ventanaPara('sistema', 'hola', 400), 4096);
    });

    t.test('un prompt largo pide más de lo que ocupa', () => {
        // Ollama, si no entra, tira el principio sin avisar: la ventana pedida
        // tiene que sobrarle al prompt, nunca quedarle justa.
        const largo = 'palabra '.repeat(6000); // ~48 000 caracteres
        const pedida = ai.ventanaPara('', largo, 400);
        t.ok(pedida > largo.length / ai.VENTANA.charsPorToken, `pidió ${pedida} para ${largo.length} chars`);
    });

    t.test('la ventana crece con el prompt', () => {
        const chico = ai.ventanaPara('', 'x'.repeat(2000), 400);
        const grande = ai.ventanaPara('', 'x'.repeat(40000), 400);
        t.ok(grande > chico, `${chico} vs ${grande}`);
    });

    t.test('va en múltiplos de 2048, para no recargar el modelo entre consultas', () => {
        for (const chars of [5000, 5001, 12345, 30000]) {
            const pedida = ai.ventanaPara('', 'x'.repeat(chars), 400);
            t.eq(pedida % 2048, 0, `${chars} chars dio ${pedida}`);
        }
    });

    t.test('nunca se pasa del techo, por más largo que venga', () => {
        t.eq(ai.ventanaPara('', 'x'.repeat(5000000), 400), ai.VENTANA.maxima);
    });

    t.group('las órdenes que el CD escribió en la nota');

    t.test('se lee la orden y se le asigna al borde del que habla', () => {
        // La nota viaja en el marcador de ENTRADA pero habla de la SALIDA.
        const block = { note: 'OUT ANTES DE: "En Spec-Driven Development, la"' };
        t.eq(orden.para(block, 'IN'), null, 'el IN no tiene nada que ver con esta orden');
        const salida = orden.para(block, 'OUT');
        t.eq(salida.relacion, 'antes');
        t.eq(salida.frase, 'En Spec-Driven Development, la');
    });

    t.test('también las que hablan de la entrada', () => {
        const block = { note: 'IN DESPUÉS DE: "3, 2, 1. Vamos a ver qué hallazgos generó"' };
        t.eq(orden.para(block, 'OUT'), null);
        t.eq(orden.para(block, 'IN').relacion, 'después');
    });

    t.test('una nota de post no es una orden de corte', () => {
        for (const nota of [
            'POST: Highlight en Archivo Task.md',
            'PV EN: "Te preguntarás cómo fue que Claude Code pudo hacer esto". Luego pasamos a SR.',
            'POST: Logo Git',
            // Cortada a la mitad no pide nada: no hay qué buscar.
            'OUT ANTES DE:',
            'OUT ANTES DE: ""',
            ''
        ]) {
            t.eq(orden.para({ note: nota }, 'OUT'), null, `«${nota.slice(0, 30)}» pasó como orden`);
            t.eq(orden.para({ note: nota }, 'IN'), null, `«${nota.slice(0, 30)}» pasó como orden`);
        }
    });

    t.test('las comillas raras y la falta de dos puntos no la rompen', () => {
        t.eq(orden.para({ note: 'OUT ANTES DE:“Finalmente, vemos la estructura”' }, 'OUT').frase,
            'Finalmente, vemos la estructura');
        t.eq(orden.para({ note: 'OUT ANTES DE «Esto puede»' }, 'OUT').frase, 'Esto puede');
    });

    t.test('la frase se ubica aunque el CD la escriba distinto de como salió', () => {
        // El CD escribe de memoria, Whisper transcribe a su manera: comparar
        // letra a letra no encuentra nada.
        const words = say('bueno hasta acá la primera parte.', 0)
            .concat(say('en spectriven development la documentación manda.', 10));
        const block = { startSec: 0, endSec: 14, note: 'OUT ANTES DE: "En Spec-Driven Development, la"' };
        const ubicada = orden.ubicar(words, orden.para(block, 'OUT'), [block], 0, { fps: 30 });
        t.ok(ubicada, 'no ubicó la frase');
        t.ok(Math.abs(ubicada.timeSec - 10) < 0.5, `la ubicó en ${ubicada && ubicada.timeSec}, se esperaba ~10`);
    });

    t.test('no se sale del territorio del bloque', () => {
        // La misma frase repetida en toda la clase: sin territorio se ubica en
        // cualquier lado. La del bloque de al lado no cuenta.
        const words = say('arrancamos con la introducción del tema.', 0)
            .concat(say('vamos a ver qué pasa acá.', 10))
            .concat(say('relleno del medio para separar.', 30))
            .concat(say('vamos a ver qué pasa acá.', 100));
        const blocks = [
            { startSec: 0, endSec: 16, note: 'OUT ANTES DE: "vamos a ver qué pasa"' },
            { startSec: 98, endSec: 106 }
        ];
        const ubicada = orden.ubicar(words, orden.para(blocks[0], 'OUT'), blocks, 0, { fps: 30 });
        t.ok(ubicada && ubicada.timeSec < 20, `se fue al bloque siguiente: ${ubicada && ubicada.timeSec}`);
    });

    t.test('entre retomas de la misma frase gana la que mira el marcador', () => {
        // El profesor se traba y repite: la misma frase, tres veces, con puntaje
        // perfecto las tres. La buena es la que el CD tenía delante.
        const words = say('bueno arranquemos con esto de una vez.', 0)
            .concat(say('en spectriven development la documentación manda.', 10))
            .concat(say('en spectriven development la documentación manda.', 48))
            .concat(say('en spectriven development la documentación manda.', 70));
        const block = { startSec: 0, endSec: 22, note: 'OUT ANTES DE: "En Spec-Driven Development, la"' };
        const blocks = [block, { startSec: 68, endSec: 80 }];

        const ubicada = orden.ubicar(words, orden.para(block, 'OUT'), blocks, 0,
            { fps: 30, referencia: 22 });
        t.ok(Math.abs(ubicada.timeSec - 10) < 0.5, `eligió la toma de ${ubicada.timeSec}, se esperaba ~10`);
        t.eq(ubicada.seguro, true, 'con el marcador cerca de una sola toma no hay empate');
    });

    t.test('dos tomas equidistantes no se deciden solas', () => {
        const words = say('bueno arranquemos con esto de una vez.', 0)
            .concat(say('en spectriven development la documentación manda.', 10))
            .concat(say('en spectriven development la documentación manda.', 30));
        const block = { startSec: 0, endSec: 42, note: 'OUT ANTES DE: "En Spec-Driven Development, la"' };
        // El marcador cae justo en el medio de las dos: es una moneda al aire.
        const ubicada = orden.ubicar(words, orden.para(block, 'OUT'), [block], 0,
            { fps: 30, referencia: 21 });
        t.eq(ubicada.seguro, false, 'se impuso una toma sin poder distinguirla de la otra');
    });

    t.test('"después de" corta al final de la frase, no al principio', () => {
        // Si se corta al arranque, la clase abre con el conteo del director: lo
        // que la nota justamente pedía sacar.
        const words = say('listo dale. tres, dos, uno. vamos a ver qué hallazgos generó.', 0)
            .concat(say('acá tenemos los resultados del análisis completo.', 20));
        const block = {
            startSec: 0.2, endSec: 30,
            note: 'IN DESPUÉS DE: "tres, dos, uno. Vamos a ver qué hallazgos generó"'
        };
        const ubicada = orden.ubicar(words, orden.para(block, 'IN'), [block], 0, { fps: 30 });
        t.ok(ubicada, 'no ubicó la frase');
        const dicho = speech.textInside(words, ubicada.timeSec, 30);
        t.ok(!/hallazgos/.test(dicho), `el corte dejó la frase adentro: «${dicho.slice(0, 60)}»`);
        t.ok(/resultados/.test(dicho), `se comió lo que venía después: «${dicho.slice(0, 60)}»`);
    });

    t.test('una frase que no está en el tramo no se inventa', () => {
        const words = say('acá no se dice nada parecido a eso.', 0);
        const block = { startSec: 0, endSec: 5, note: 'OUT ANTES DE: "la promesa de valor del producto"' };
        t.eq(orden.ubicar(words, orden.para(block, 'OUT'), [block], 0, { fps: 30 }), null);
    });

    t.test('el borde se mueve a donde el CD pidió, sin preguntarle a nadie', async () => {
        const words = say('bueno hasta acá la primera parte.', 0)
            .concat(say('en spectriven development la documentación manda.', 10));
        const block = { startSec: 0, endSec: 14, note: 'OUT ANTES DE: "En Spec-Driven Development, la"', cueOut: '' };

        let preguntaron = false;
        const res = await refine.refineEdge({
            words,
            edge: { timeSec: 14, decidedBy: 'nota' },
            block, blocks: [block], index: 0, kind: 'OUT',
            options: { fps: 30 },
            ai: { ask: async () => { preguntaron = true; return { choice: 1 }; } }
        });

        t.eq(res.decidedBy, 'orden');
        t.eq(preguntaron, false, 'la orden del CD no se somete a votación');
        t.ok(Math.abs(res.timeSec - 10) < 0.5, `quedó en ${res.timeSec}, se esperaba ~10`);
    });

    t.test('un bloque con orden se mira aunque haya enganchado perfecto', () => {
        const perfecto = {
            confidence: 'alta',
            in: { anchored: true, snap: { how: 'ya cerraba' } },
            out: { anchored: true, snap: { how: 'ya cerraba' } }
        };
        t.eq(refine.needsCriterion(perfecto), false);
        t.eq(refine.needsCriterion({ ...perfecto, note: 'OUT ANTES DE: "algo"' }), true);
        t.eq(refine.needsCriterion({ ...perfecto, note: 'POST: highlight' }), false,
            'una nota de post no es motivo para revisar');
    });

    t.group('coherencia · el guion final');

    t.test('el guion es solo lo que sobrevive, en orden', () => {
        const words = say('primero esto.', 10).concat(say('esto se elimina', 20)).concat(say('después aquello.', 30));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 11, view: 'PV' },
            { index: 1, startSec: 29.9, endSec: 31, view: 'R' }
        ], words);
        t.eq(script.blocks.length, 2);
        t.eq(script.blocks[0].n, 1);
        t.ok(/primero esto/.test(script.blocks[0].text), script.blocks[0].text);
        t.ok(!/se elimina/.test(script.text), 'lo eliminado no puede estar en el guion');
    });

    t.test('un bloque desmarcado no entra al guion', () => {
        const words = say('esto queda.', 10);
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 11 },
            { index: 1, startSec: 9.9, endSec: 11, enabled: false }
        ], words);
        t.eq(script.blocks.length, 1);
    });

    t.test('un conector que la nota no pedía se avisa', () => {
        const words = say('la fuente de la verdad es la especificación.', 10)
            .concat(say('Y entonces eso cambia todo el desarrollo.', 20));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 14, cueIn: 'la fuente de la verdad' },
            { index: 1, startSec: 19.9, endSec: 23, cueIn: 'cambia todo el desarrollo' }
        ], words);
        t.ok(coherence.localFindings(script).some(f => f.tipo === 'conector'));
    });

    t.test('un conector que el CD escribió en la nota no molesta', () => {
        // En el curso real, 24 de 25 bloques que abren con "Y" o "Luego" los
        // escribió así el CD: es su forma de hablar, no un corte mal puesto.
        const words = say('la fuente de la verdad es la especificación.', 10)
            .concat(say('Y entonces eso cambia todo el desarrollo.', 20));
        const script = coherence.buildScript([
            { index: 0, startSec: 9.9, endSec: 14, cueIn: 'la fuente de la verdad' },
            { index: 1, startSec: 19.9, endSec: 23, cueIn: 'Y entonces eso cambia' }
        ], words);
        t.eq(coherence.localFindings(script).filter(f => f.tipo === 'conector').length, 0);
    });

    t.group('colores · el XML conserva lo que puso el CD');

    t.test('el entero de Premiere se decodifica a su color real', () => {
        // PV en el curso real: 4281740498 = RGB(54, 44, 210)
        const color = fcp.colorComponents(4281740498);
        t.eq(color.red, 54 * 257);
        t.eq(color.green, 44 * 257);
        t.eq(color.blue, 210 * 257);
    });

    t.test('la claqueta blanca sigue siendo blanca', () => {
        const color = fcp.colorComponents(4294967295);
        t.eq(color.red, 65535);
        t.eq(color.green, 65535);
        t.eq(color.blue, 65535);
    });

    t.test('un nombre de color sigue funcionando', () => {
        t.deep(fcp.colorComponents('green'), fcp.MARKER_COLORS.green);
        t.deep(fcp.colorComponents(null), fcp.MARKER_COLORS.white);
    });

    t.test('el marcador devuelve a Premiere su entero original', () => {
        // Sin pproColor, Premiere ajusta el RGB al color más parecido de su
        // paleta y el marcador cambia de color al reimportarlo.
        const xml = fcp.markerXml(
            { name: 'PV', comment: 'x', startSec: 0, color: 4281740498 }, 30
        );
        t.ok(xml.includes('<pproColor>4281740498</pproColor>'), 'falta el entero de Premiere');
        t.ok(xml.includes('<red>13878</red>'), 'falta el RGB para Resolve');
    });

    t.test('sin color original no se inventa un pproColor', () => {
        const xml = fcp.markerXml({ name: 'K', startSec: 0, color: null }, 30);
        t.ok(!xml.includes('pproColor'), 'no debería inventar un entero');
    });

    t.test('cada fuente lleva su etiqueta y la primera es Cerulean', () => {
        t.eq(fcp.CLIP_LABELS[0], 'Cerulean');
        t.eq(fcp.CLIP_LABELS[1], 'Rose');
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10,
            videoTracks: [[{
                source: { path: '/a.mp4', name: 'a.mp4', durationSec: 10, label: 'Cerulean' },
                startSec: 0, endSec: 10, sourceInSec: 0, enabled: true
            }]],
            audioTracks: [], markers: []
        });
        t.ok(xml.includes('<labels><label2>Cerulean</label2></labels>'), 'falta la etiqueta en el clip');
    });

    t.test('el audio no lleva etiqueta de color', () => {
        const xml = fcp.sequenceXml({
            name: 'x', fps: 30, durationSec: 10,
            videoTracks: [],
            audioTracks: [[{
                source: { path: '/a.wav', name: 'a.wav', durationSec: 10, audioOnly: true },
                startSec: 0, endSec: 10, sourceInSec: 0, enabled: true
            }]],
            markers: []
        });
        t.ok(!xml.includes('<label2>'), 'el audio queda con su color por defecto');
    });
};
