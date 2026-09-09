'use strict';
/**
 * El aviso de empalme, del lado de la pantalla (`src/js/grabar/empalme.js`).
 *
 * Lo que el motor decide —si dos tomas repiten, dónde cortar y si ese corte se
 * puede hacer— está probado en `tests/empalme.test.js` y no se vuelve a mirar
 * acá. Lo de este archivo es lo otro, que es lo que se puede equivocar solo:
 *
 * 1. Que de los seis estados que puede traer el motor se dibuje lo que se puede
 *    accionar y nada más. Un cartel de error en medio de una clase, sobre algo
 *    que nadie puede apretar, es cómo un aviso se vuelve ruido y se apaga.
 * 2. Que el subrayado caiga en las DOS tomas del par. El empalme cuelga de la
 *    que cerró y habla también del final de la anterior: si eso se repartiera
 *    mal, el aviso señalaría una frase que no es.
 * 3. Que los botones manden el objeto del motor tal cual, sin traducir. Es toda
 *    la garantía de que «Ajustar corte» sea el mismo gesto que arrastrar la
 *    línea roja.
 *
 * Lo que sí es DOM —que la onda se vea, que el bloque quede debajo del porqué—
 * se verificó con la maqueta y el arnés, no acá.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Una toma con su empalme puesto, con lo único que la vista le mira. */
function toma(id, empalme) {
    return { id, empalme: empalme || null };
}

/** Un empalme como el que arma `paraLaPantalla`, con la sugerencia servida. */
function conSugerencia(contra, extra) {
    return {
        contra,
        parecido: 0.62,
        estado: 'listo',
        porque: '',
        sugerencia: {
            origen: 'modelo',
            porque: 'Las dos tomas explican lo mismo del pool de conexiones.',
            enLaAnterior: { toma: contra, desdeMs: 5000, hastaMs: 8000, texto: 'la conexión no se abre' },
            enEsta: { toma: contra + 1, desdeMs: 20000, hastaMs: 23000, texto: 'la conexión no se abre' },
            ajuste: { tipo: 'borde', toma: contra, borde: 'out', paredMs: 5000, quitaSec: 6.3, palabras: 18 },
            descartar: { tipo: 'descartar-ajuste', toma: contra + 1, contra },
            ...(extra || {})
        }
    };
}

/* ─── Un DOM de mentira, con lo justo ────────────────────────────────────
 *
 * Solo lo que `marcarRepetidos` y `unirVecinas` tocan: las palabras con su hora,
 * sus clases y su globito, y los nodos de texto de en medio, que son el hueco
 * que hay que absorber. Enlazados como hermanos, que es de donde salen los
 * `nextSibling` sobre los que se decide.
 */
const TEXT_NODE = 3;

function palabra(t, texto, clases) {
    const suyas = new Set(clases || []);
    return {
        nodeType: 1,
        dataset: { t: String(t) },
        title: '',
        textContent: texto,
        classList: {
            add: c => suyas.add(c),
            contains: c => suyas.has(c)
        },
        clases: suyas,
        // `append` en el DOM MUEVE el nodo: se lo saca de donde estaba. Acá
        // alcanza con anotar que se lo llevó y saltearlo en la cadena.
        append: nodo => { nodo.absorbidoPor = texto; }
    };
}

/** Las palabras con un hueco entre cada dos, como las dibuja `textoDe`. */
function textoCon(palabras) {
    const hijos = [];
    for (const p of palabras) {
        hijos.push(p);
        hijos.push({ nodeType: TEXT_NODE, absorbidoPor: null });
    }
    hijos.forEach((n, i) => {
        Object.defineProperty(n, 'nextSibling', {
            get: () => {
                // Un hueco que ya se absorbió no está más en la cadena.
                let j = i + 1;
                while (hijos[j] && hijos[j].absorbidoPor) j++;
                return hijos[j] || null;
            },
            configurable: true
        });
    });
    return {
        hijos,
        huecos: hijos.filter(n => n.nodeType === TEXT_NODE),
        querySelectorAll: sel => palabras.filter(p =>
            sel.split('.').filter(c => c && c !== 'toma-palabra').every(c => p.clases.has(c)))
    };
}

/** Corre el cuerpo con el `Node` global puesto, y lo saca al terminar. */
function conNode(cuerpo) {
    const habia = globalThis.Node;
    globalThis.Node = { TEXT_NODE };
    try {
        cuerpo();
    } finally {
        if (habia === undefined) delete globalThis.Node;
        else globalThis.Node = habia;
    }
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const vista = await import(src('grabar/empalme.js'));
    const palabras = await import(src('grabar/palabras.js'));
    const plegado = await import(src('grabar/plegado.js'));

    t.group('aviso de empalme · qué se dibuja para cada estado');

    t.test('con sugerencia se dibuja el bloque, que es para lo que existe esto', () => {
        const visto = vista.queDecir(conSugerencia(1));
        t.eq(visto.que, 'sugerencia');
        t.eq(visto.contra, 1);
        t.eq(visto.sugerencia.porque, 'Las dos tomas explican lo mismo del pool de conexiones.');
    });

    t.test('«listo» sin sugerencia no dibuja nada: se miró y no repiten', () => {
        // Un "todo bien" por cada toma que cierra son veinte carteles por clase
        // para no decir nada. El silencio es la respuesta.
        t.eq(vista.queDecir({ contra: 1, estado: 'listo', porque: '', sugerencia: null }), null);
    });

    t.test('descartado deja el recibo, sin botones', () => {
        // Sin esta línea, apretar «Descartar ajuste» se ve igual que no haber
        // apretado nada: la sugerencia desaparece y no queda dicho por qué.
        const visto = vista.queDecir({
            contra: 1, estado: 'descartado',
            porque: 'Descartaste el ajuste de este empalme.', sugerencia: null
        });
        t.eq(visto.que, 'nota');
        t.eq(visto.texto, 'Descartaste el ajuste de este empalme.');
    });

    t.test('midiendo lo dice, porque la consulta puede tardar minutos', () => {
        const visto = vista.queDecir({ contra: 2, estado: 'midiendo', porque: '', sugerencia: null });
        t.eq(visto.que, 'nota');
        t.ok(visto.texto.includes('la 2'), `nombra con quién empalma: ${visto.texto}`);
    });

    t.test('sin modelo, caído o abstenido no dibujan nada', () => {
        // Los tres son la misma situación para quien está grabando: no hay nada
        // que apretar. Inventar un cartel de error para eso, en medio de una
        // clase, es ruido — y lo que la regla ve gratis se sigue viendo igual.
        for (const estado of ['sin-modelo', 'falla', 'abstenido', 'sin-medir']) {
            t.eq(vista.queDecir({ contra: 1, estado, porque: 'se cayó la red', sugerencia: null }), null,
                `${estado} no dibuja nada`);
        }
    });

    t.test('una toma sin empalme —la primera, una descartada— tampoco', () => {
        t.eq(vista.queDecir(null), null);
        t.eq(vista.queDecir(undefined), null);
    });

    t.test('una sugerencia se muestra aunque el estado de la consulta sea otro', () => {
        // La regla resuelve gratis el caso más frecuente, y una respuesta ya
        // pagada sigue valiendo si la consulta siguiente se cayó. Lo que manda es
        // si hay algo que apretar, no en qué anda el modelo.
        const e = conSugerencia(1);
        e.estado = 'falla';
        t.eq(vista.queDecir(e).que, 'sugerencia');
    });

    t.group('aviso de empalme · el subrayado cae en las dos tomas del par');

    t.test('el tramo de la anterior va a la anterior y el de esta, a esta', () => {
        // El empalme cuelga de la toma que cerró y habla de dos: si esto se
        // repartiera mal, el aviso subrayaría una frase que no es.
        const mapa = vista.tramosPorToma([toma(1), toma(2, conSugerencia(1))]);
        t.eq(mapa.get(1).length, 1);
        t.eq(mapa.get(1)[0].desdeMs, 5000);
        t.eq(mapa.get(2).length, 1);
        t.eq(mapa.get(2)[0].desdeMs, 20000);
    });

    t.test('cada tramo nombra la toma de enfrente, no hacia dónde mirar', () => {
        // Las dos tarjetas se ven iguales y solo una tiene los botones. Y la
        // clase en curso va de la más vieja a la más nueva mientras que la lista
        // de lo ya grabado va al revés, así que "ahí abajo" sería mentira en una
        // de las dos.
        const mapa = vista.tramosPorToma([toma(1), toma(2, conSugerencia(1))]);
        t.ok(mapa.get(1)[0].titulo.includes('toma 2'), mapa.get(1)[0].titulo);
        t.ok(mapa.get(1)[0].titulo.includes('Ajustar corte'), 'y dice qué botón lo saca');
        t.ok(mapa.get(2)[0].titulo.includes('toma 1'), mapa.get(2)[0].titulo);
    });

    t.test('una toma del medio puede llevar los dos subrayados a la vez', () => {
        // Es el final de un par y el arranque del siguiente. Son tramos
        // distintos —el final y el principio de la misma toma— y los dos se ven.
        const mapa = vista.tramosPorToma([
            toma(1), toma(2, conSugerencia(1)), toma(3, conSugerencia(2))
        ]);
        t.eq(mapa.get(2).length, 2, 'el arranque por su empalme y el final por el de la 3');
    });

    t.test('sin sugerencia no se subraya nada, venga el estado que venga', () => {
        const mapa = vista.tramosPorToma([
            toma(1),
            toma(2, { contra: 1, estado: 'descartado', porque: 'x', sugerencia: null }),
            toma(3, { contra: 2, estado: 'falla', porque: 'se cayó', sugerencia: null })
        ]);
        t.eq(mapa.size, 0);
    });

    t.test('una lista vacía o sin tomas no explota: es una grabación en curso', () => {
        t.eq(vista.tramosPorToma([]).size, 0);
        t.eq(vista.tramosPorToma(null).size, 0);
    });

    t.group('aviso de empalme · lo que mandan los dos botones');

    t.test('«Ajustar corte» manda el mismo cambio que arrastrar la línea roja', () => {
        // La garantía entera: no hay un segundo camino de escritura. El objeto se
        // manda tal cual, así que si esto se tradujera dejaría de andar sin que
        // nadie se entere hasta apretarlo en medio de una clase.
        const { sugerencia } = vista.queDecir(conSugerencia(1));
        t.eq(sugerencia.ajuste.tipo, 'borde');
        t.eq(sugerencia.ajuste.borde, 'out');
        t.eq(sugerencia.ajuste.toma, 1, 'se mueve el OUT de la ANTERIOR');
        t.eq(sugerencia.descartar.tipo, 'descartar-ajuste');
        t.eq(sugerencia.descartar.contra, 1);
    });

    t.group('aviso de empalme · el subrayado, palabra por palabra');

    t.test('se marcan las palabras que caen en el tramo y ninguna más', () => conNode(() => {
        const spans = [
            palabra(1000, 'Bueno'), palabra(1400, 'la'), palabra(1800, 'conexión'),
            palabra(2200, 'no'), palabra(2600, 'se'), palabra(3000, 'abre')
        ];
        vista.marcarRepetidos(textoCon(spans), [{ desdeMs: 1400, hastaMs: 2600, titulo: 'Esto se repite.' }]);
        t.deep(spans.map(s => s.clases.has('es-repetida')),
            [false, true, true, true, true, false]);
    }));

    t.test('el globito se suma al que ya estaba, no lo pisa', () => conNode(() => {
        // El de una palabra comentada dice que se puede apretar para verlo, y
        // esconder eso detrás del aviso sería tapar el trabajo de alguien con el
        // de un modelo.
        const con = palabra(1000, 'la', ['es-comentada']);
        con.title = 'Hay un comentario acá. Clic para verlo.';
        const sin = palabra(1400, 'conexión');
        sin.title = '15:07:03';
        vista.marcarRepetidos(textoCon([con, sin]), [{ desdeMs: 1000, hastaMs: 1400, titulo: 'Se repite.' }]);
        t.ok(con.title.startsWith('Hay un comentario'), con.title);
        t.ok(con.title.endsWith('Se repite.'), con.title);
        t.ok(sin.title.startsWith('15:07:03'), 'y la hora tampoco se pierde');
    }));

    t.test('sin tramos no se toca ninguna palabra', () => conNode(() => {
        const spans = [palabra(1000, 'Bueno'), palabra(1400, 'la')];
        vista.marcarRepetidos(textoCon(spans), []);
        vista.marcarRepetidos(textoCon(spans), null);
        t.eq(spans.filter(s => s.clases.size).length, 0);
    }));

    t.group('aviso de empalme · el hueco entre dos palabras marcadas');

    t.test('el espacio se mete adentro cuando la marca sigue', () => conNode(() => {
        // Sin esto la frase subrayada se lee como un código de barras: la línea
        // corre debajo de cada palabra y se corta en cada espacio.
        const spans = [palabra(1000, 'la'), palabra(1400, 'conexión'), palabra(1800, 'no')];
        const texto = textoCon(spans);
        vista.marcarRepetidos(texto, [{ desdeMs: 1000, hastaMs: 1400, titulo: 'x' }]);
        t.eq(texto.huecos[0].absorbidoPor, 'la', 'el de entre las dos marcadas, sí');
        t.eq(texto.huecos[1].absorbidoPor, null, 'el de la última marcada con la que no lo está, no');
    }));

    t.test('el de los comentarios sigue mirando que sea el MISMO comentario', () => conNode(() => {
        // Donde el conjunto cambia —ahí arranca o termina uno de dos pisados— el
        // hueco se queda, y está bien que se vea: es donde el tramo cambia de
        // dueño. Es la única diferencia con el de arriba, y por eso el remedio
        // está compartido y la condición no.
        const uno = palabra(1000, 'la', ['es-comentada']);
        const dos = palabra(1400, 'conexión', ['es-comentada']);
        const tres = palabra(1800, 'no', ['es-comentada']);
        uno.dataset.com = '0';
        dos.dataset.com = '0';
        tres.dataset.com = '0 1';
        const texto = textoCon([uno, dos, tres]);
        palabras.unirMarcadas(texto);
        t.eq(texto.huecos[0].absorbidoPor, 'la');
        t.eq(texto.huecos[1].absorbidoPor, null, 'ahí empieza el segundo comentario');
    }));

    t.group('aviso de empalme · una toma plegada no lo esconde');

    t.test('plegada dice que tiene un ajuste sin mirar', () => {
        // La tarjeta plegada no dibuja ni el texto subrayado ni los dos botones,
        // así que sin la marca plegar sería la forma de perder la sugerencia. Es
        // lo mismo que ya se hace con los comentarios y la nota.
        t.ok(plegado.marcasDe({ empalme: conSugerencia(1) }).includes('empalme por ajustar'));
    });

    t.test('y un empalme sin nada que decidir no agrega ruido al resumen', () => {
        t.deep(plegado.marcasDe({ empalme: { contra: 1, estado: 'listo', sugerencia: null } }), []);
        t.deep(plegado.marcasDe({ empalme: null }), []);
    });
};
