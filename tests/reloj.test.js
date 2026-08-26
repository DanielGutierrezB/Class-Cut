'use strict';
/**
 * El reloj con el que el panel alumbra, armado sobre la alineación por DTW.
 *
 * Lo que se prueba es el injerto, que es la única decisión de todo esto: la
 * primera palabra de cada tirada se queda con el arranque que midió la onda —si lo
 * midió— y todo lo demás va por DTW. Está medido en las dos direcciones —el DTW
 * puro empeora los bordes de tirada (60 ms contra 20) y la onda sola no mide nada
 * adentro de la frase— así que si alguien "simplifica" el injerto a uno de los dos
 * alineadores, estas pruebas son las que tienen que fallar.
 *
 * Y la mitad de las pruebas están para el "si lo midió", que es lo que la primera
 * versión daba por sentado: sin la marca de `alignWords`, el injerto le devolvía el
 * arranque a la onda también en las tiradas donde la onda no había medido nada —30
 * de 244 en la clase 1, con el DTW a más de un segundo en 25 de ellas.
 *
 * Lógica pura: entran palabras con tiempos y sale el reloj, sin tocar un WAV.
 */

const reloj = require('../engine/reloj');

const DESFASE = reloj.DESFASE_DTW_SEC;

module.exports = function (t) {
    t.group('el reloj del panel · el injerto');

    /**
     * Una tirada de cuatro palabras seguidas, con la onda y el DTW discrepando.
     *
     * La primera trae `onset`, que es la marca que `alignWords` deja cuando midió
     * el ataque contra el WAV. Sin ella esta tirada sería otro caso —el de la
     * palabra dicha de lejos— y por eso va en el molde y no como detalle.
     */
    function tirada() {
        return [
            { start: 10.0, end: 10.4, text: 'Y', dtw: 10.30, onset: true },
            { start: 10.4, end: 10.5, text: 'el', dtw: 10.62 },
            { start: 10.5, end: 10.7, text: 'código', dtw: 10.90 },
            { start: 10.7, end: 11.6, text: 'es', dtw: 11.20 }
        ];
    }

    t.test('la primera palabra se queda con el arranque de la onda', () => {
        // `alignWords` mide el ataque de la tirada contra el WAV y ahí es mejor
        // que el DTW. Si esta se fuera a 10,30 − 0,14 = 10,16, el panel se
        // adelantaría justo donde hoy acierta.
        const r = reloj.deDtw(tirada());
        t.eq(r.palabras[0].start, 10.0);
    });

    t.test('las de adentro van por DTW menos el desfase', () => {
        const r = reloj.deDtw(tirada());
        t.near(r.palabras[1].start, 10.62 - DESFASE, 0.001);
        t.near(r.palabras[2].start, 10.90 - DESFASE, 0.001);
        t.near(r.palabras[3].start, 11.20 - DESFASE, 0.001);
    });

    t.test('el final es el del transcript, no el arranque de la siguiente', () => {
        // El DTW no tiene finales. Cerrar cada palabra donde arranca la que sigue
        // convertía un final en el arranque de otra cosa, y de eso vivían seis
        // cortes encima de la voz: `speech-edges.wordLimits` saca el piso del IN
        // del final de la palabra anterior, y con ese piso pegado al sonido el
        // colchón de aire no tiene dónde caber.
        const r = reloj.deDtw(tirada());
        t.eq(r.palabras[0].end, 10.4, 'el que midió la onda al alinear el transcript');
        t.eq(r.palabras[1].end, 10.5);
        for (let i = 0; i < r.palabras.length - 1; i++) {
            t.ok(r.palabras[i].end <= r.palabras[i + 1].start,
                `la ${i} termina en ${r.palabras[i].end}, después de que abra la ${i + 1}`);
            t.ok(r.palabras[i].end > r.palabras[i].start, `la ${i} no dura nada`);
        }
    });

    t.test('un final que el DTW dejó atrás no invierte la palabra', () => {
        // El DTW puede correr el arranque más allá del final que la palabra traía.
        // Una palabra invertida rompe todo lo que la lea: `wordsInside` la deja
        // afuera, `wordLimits` corta la búsqueda del piso antes de tiempo.
        const r = reloj.deDtw([
            { start: 10.0, end: 10.1, text: 'uno', dtw: 10.05, onset: true },
            { start: 10.1, end: 10.2, text: 'dos', dtw: 10.9 },
            { start: 10.2, end: 11.5, text: 'tres', dtw: 11.0 }
        ]);
        t.ok(r.palabras[1].end > r.palabras[1].start,
            `la segunda va de ${r.palabras[1].start} a ${r.palabras[1].end}`);
        t.ok(r.palabras[1].end <= r.palabras[2].start, 'y no se pasa de la tercera');
    });

    t.test('la última se queda con el final que midió la onda', () => {
        // El otro borde de la tirada también es de `alignWords`, por lo mismo que
        // el arranque: ahí hay silencio al lado y el ataque se puede medir.
        const r = reloj.deDtw(tirada());
        t.eq(r.palabras[3].end, 11.6);
    });

    t.test('cuenta lo que injertó y lo que quedó de la onda', () => {
        const r = reloj.deDtw(tirada());
        t.eq(r.stats.tiradas, 1);
        t.eq(r.stats.injertadas, 3, 'las tres de adentro');
        t.eq(r.stats.deLaOnda, 1);
        t.eq(r.stats.sinOnda, 0);
        t.eq(r.stats.sinDtw, 0);
    });

    t.group('el reloj del panel · donde la onda no midió');

    t.test('sin la marca de la onda, la primera palabra también va por DTW', () => {
        // El caso del director hablando lejos del micrófono: `alignWords` no
        // encuentra ataque y deja el tiempo crudo de Whisper, que en el arranque de
        // la clase 1 son 0,65 s para una frase que se dice en 8,56. Preferir ese
        // arranque por sobre el DTW es preferir el que nadie midió.
        const palabras = tirada();
        delete palabras[0].onset;
        const r = reloj.deDtw(palabras);
        t.near(r.palabras[0].start, 10.30 - DESFASE, 0.001);
        t.eq(r.stats.deLaOnda, 0);
        t.eq(r.stats.sinOnda, 1);
        t.eq(r.stats.injertadas, 4, 'las cuatro, incluida la que abre');
    });

    t.test('una marca en `false` cuenta como que no midió', () => {
        // La marca se pone solo cuando hay medición, así que `false` no lo escribe
        // nadie; si algún día alguien lo escribe, quiere decir lo mismo que su
        // ausencia y no lo contrario.
        const palabras = tirada();
        palabras[0].onset = false;
        t.near(reloj.deDtw(palabras).palabras[0].start, 10.30 - DESFASE, 0.001);
    });

    t.test('sin la marca y sin DTW no queda más que el tiempo crudo', () => {
        const r = reloj.deDtw([{ start: 5, end: 5.4, text: 'Va.' }]);
        t.eq(r.palabras[0].start, 5);
        t.eq(r.stats.sinDtw, 1);
        t.eq(r.stats.sinOnda, 1);
    });

    t.test('el DTW de una tirada sin marca no puede meterse en la anterior', () => {
        // El arranque de la onda se mide con la tirada de al lado en la ventana, así
        // que no puede cruzarla; el del DTW sí. Y una palabra que arranca antes de
        // que termine la tirada anterior deja muda a la última de esa tirada,
        // porque el panel alumbra la última que arrancó.
        const r = reloj.deDtw([
            { start: 10.0, end: 11.0, text: 'uno', dtw: 10.1, onset: true },
            { start: 30.0, end: 30.5, text: 'dos', dtw: 10.4 },
            { start: 30.5, end: 31.0, text: 'tres', dtw: 30.8 }
        ]);
        t.eq(r.stats.tiradas, 2);
        t.ok(r.palabras[1].start > r.palabras[0].end,
            `la segunda tirada abre en ${r.palabras[1].start} y la primera cerraba en ${r.palabras[0].end}`);
    });

    t.group('el reloj del panel · las tiradas');

    t.test('un hueco declarado abre otra tirada, con su propio arranque de onda', () => {
        // El hueco es el mismo con el que `alignWords` separa tramos: por debajo
        // de eso Whisper no dice que hubo silencio, está pegando dos segmentos.
        const r = reloj.deDtw([
            { start: 10.0, end: 10.2, text: 'uno', dtw: 10.5, onset: true },
            { start: 10.2, end: 10.4, text: 'dos', dtw: 10.7 },
            { start: 30.0, end: 30.3, text: 'tres', dtw: 30.3, onset: true },
            { start: 30.3, end: 30.9, text: 'cuatro', dtw: 30.6 }
        ]);
        t.eq(r.stats.tiradas, 2);
        t.eq(r.palabras[0].start, 10.0, 'la primera de la primera tirada');
        t.eq(r.palabras[2].start, 30.0, 'y la primera de la segunda también');
        t.near(r.palabras[3].start, 30.6 - DESFASE, 0.001);
    });

    t.test('una palabra sola es una tirada, y sale entera de la onda', () => {
        const una = { start: 5, end: 5.4, text: 'Va.', dtw: 5.9, onset: true };
        t.deep(reloj.deDtw([una]).palabras, [una]);
    });

    t.group('el reloj del panel · lo que no puede pasar');

    t.test('ninguna arranca antes que la anterior', () => {
        // Son dos medidas distintas del mismo sonido y en el empalme se cruzan: si
        // la onda pone la primera en 10,9 y el DTW pone la segunda en 10,5, dejar
        // 10,36 haría que el panel no alumbre nunca la segunda, porque busca la
        // última que ya arrancó.
        const r = reloj.deDtw([
            { start: 10.9, end: 11.0, text: 'uno', dtw: 10.4, onset: true },
            { start: 11.0, end: 11.4, text: 'dos', dtw: 10.5 }
        ]);
        t.eq(r.palabras[0].start, 10.9);
        t.ok(r.palabras[1].start >= r.palabras[0].start,
            `la segunda arrancó en ${r.palabras[1].start}, antes de ${r.palabras[0].start}`);
        t.eq(r.stats.aplastadas, 1);
    });

    t.test('ninguna se pasa del final de la tirada', () => {
        // Un DTW que se va más allá del silencio dejaría una palabra alumbrando
        // sobre el aire del bloque siguiente.
        const r = reloj.deDtw([
            { start: 10.0, end: 10.2, text: 'uno', dtw: 10.1, onset: true },
            { start: 10.2, end: 10.5, text: 'dos', dtw: 99.0 }
        ]);
        t.eq(r.palabras[1].start, 10.5);
        t.ok(r.palabras[1].end >= r.palabras[1].start, 'y su final no queda antes de su arranque');
    });

    t.test('dos palabras no comparten arranque, o una no se alumbra nunca', () => {
        // El DTW habla en centésimas, así que dos palabras con el mismo número no
        // son simultáneas: son dos que su grilla no separó. Y `letra.palabraEn`
        // alumbra la ÚLTIMA que arrancó, así que de un empate la primera queda
        // muda para siempre. En la clase 1 eran 53 de 4.296.
        const r = reloj.deDtw([
            { start: 10.0, end: 10.1, text: 'Y', dtw: 10.3, onset: true },
            { start: 10.1, end: 10.2, text: 'el', dtw: 10.5 },
            { start: 10.2, end: 10.3, text: 'código', dtw: 10.5 },
            { start: 10.3, end: 11.0, text: 'es', dtw: 10.5 }
        ]);
        const arranques = r.palabras.map(p => p.start);
        t.eq(new Set(arranques).size, 4, `hay empates: ${arranques.join(', ')}`);
        for (let i = 1; i < arranques.length; i++) {
            t.ok(arranques[i] > arranques[i - 1], `la ${i} no avanzó respecto de la ${i - 1}`);
        }
    });

    t.test('una palabra sin DTW conserva el arranque que traía', () => {
        // El `-1` de whisper.cpp: 3 de cada 189. No hay nada mejor que el tiempo
        // que ya tenía.
        const r = reloj.deDtw([
            { start: 10.0, end: 10.2, text: 'uno', dtw: 10.3, onset: true },
            { start: 10.2, end: 10.4, text: 'dos' },
            { start: 10.4, end: 10.9, text: 'tres', dtw: 10.9 }
        ]);
        t.eq(r.palabras[1].start, 10.2);
        t.eq(r.stats.sinDtw, 1);
        t.eq(r.stats.injertadas, 1);
    });

    t.test('las palabras que entran no se tocan', () => {
        // Las mismas las lee después el anclaje de los comentarios: mutarlas acá
        // le cambiaría el reloj al Backup sin que nadie lo pida.
        const entrada = tirada();
        reloj.deDtw(entrada);
        t.deep(entrada, tirada());
    });

    t.test('sin palabras no explota', () => {
        t.deep(reloj.deDtw([]).palabras, []);
        t.deep(reloj.deDtw(null).palabras, []);
    });
};
