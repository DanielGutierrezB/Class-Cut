'use strict';
/**
 * Comparar el corte que salió contra el guion que se esperaba.
 *
 * Toda la lógica que se prueba acá existe por una razón concreta: el transcript
 * del render y el del original NUNCA coinciden palabra por palabra. Es otro
 * audio, y en cada empalme Whisper oye un contexto que en el original no
 * existía. Una comparación literal reportaba cientos de diferencias que no eran
 * defectos —"Clauco" contra "Cloud Code", "spec-driven" contra "Spec Driven"— y
 * entre ese ruido se perdía la única que importaba: cinco segundos de charla del
 * director y un "3, 2, 1" que habían quedado dentro del bloque 7 de la clase 6.
 *
 * Así que lo que se prueba es la tolerancia: que las mismas palabras oídas de
 * otra manera no cuenten, y que el material de más sí.
 */

const verificar = require('../tools/verificar-corte');

/** Tokens como los arma la herramienta, con tiempos regulares. */
function decir(texto, desde, porPalabra) {
    const paso = porPalabra || 0.5;
    return verificar.tokenizar(texto.split(' ').map((palabra, i) => ({
        text: palabra,
        start: desde + i * paso,
        end: desde + (i + 1) * paso
    })));
}

/** Un bloque del corte, con su tramo en la línea de tiempo del render. */
function bloque(n, desdeSec, texto) {
    const esperado = decir(texto, desdeSec);
    return {
        n,
        blockIndex: n - 1,
        desdeSec,
        hastaSec: desdeSec + esperado.length * 0.5,
        esperado
    };
}

const tokens = lista => lista.map(w => w.t);

module.exports = function (t) {
    t.group('verificar el corte · comparar palabras');

    t.test('normalizar deja solo lo comparable', () => {
        t.eq(verificar.normalizar('¿Ambigüedades?'), 'ambiguedades');
        t.eq(verificar.normalizar('spec-driven'), 'specdriven');
        t.eq(verificar.normalizar('...'), '');
        // Los números se quedan: el "3, 2, 1" del conteo es lo que hay que ver.
        t.eq(verificar.normalizar('3,'), '3');
    });

    t.test('una palabra corta tiene que ser exacta', () => {
        // Con margen, "de" y "que" pasarían por la misma palabra y el diff se
        // volvería inútil justo en las palabras más frecuentes del español.
        t.ok(!verificar.iguales('de', 'que'), '"de" no es "que"');
        t.ok(!verificar.iguales('spec', 'spot'), 'cuatro letras, una distinta');
        t.ok(verificar.iguales('spec', 'spec'));
    });

    t.test('una palabra larga aguanta que Whisper la escriba distinto', () => {
        t.ok(verificar.iguales('ambiguedades', 'ambiguedad'), 'plural o no');
        t.ok(verificar.iguales('assumptions', 'asumptions'), 'una letra de menos');
        t.ok(!verificar.iguales('requerimientos', 'funcionalidades'), 'y no cualquier cosa');
    });

    t.test('la distancia se rinde pasado el techo', () => {
        // No hace falta el número exacto: solo si se pasó. Cortar ahí es lo que
        // hace que comparar dos clases enteras cueste milisegundos.
        t.eq(verificar.distancia('abc', 'abc', 2), 0);
        t.ok(verificar.distancia('abc', 'xyzw', 1) > 1);
    });

    t.group('verificar el corte · los huecos');

    t.test('dos listas iguales no dejan hueco', () => {
        const r = verificar.huecos(['uno', 'dos', 'tres'], ['uno', 'dos', 'tres']);
        t.eq(r.huecos.length, 0);
        t.eq(r.comunes, 3);
    });

    t.test('material de más deja un hueco de un solo lado', () => {
        const r = verificar.huecos(['aqui', 'esta'], ['pausa', 'aqui', 'esta']);
        t.eq(r.huecos.length, 1);
        t.eq(r.huecos[0].eDesde, r.huecos[0].eHasta, 'nada esperado en el hueco');
        t.eq(r.huecos[0].sHasta - r.huecos[0].sDesde, 1, 'una palabra de más');
    });

    t.test('material que no llegó deja el hueco del otro lado', () => {
        const r = verificar.huecos(['aqui', 'esta', 'el'], ['aqui', 'el']);
        t.eq(r.huecos.length, 1);
        t.eq(r.huecos[0].eHasta - r.huecos[0].eDesde, 1);
        t.eq(r.huecos[0].sDesde, r.huecos[0].sHasta, 'no salió nada en su lugar');
    });

    t.test('lo mismo oído distinto deja UN hueco con los dos lados', () => {
        // Y esto es todo el punto de devolver huecos en vez de dos listas: con
        // dos listas sueltas, "clauco" contra "cloud code" se leía como dos
        // palabras de material de más que nunca estuvo en el audio.
        const r = verificar.huecos(['ya', 'clauco', 'nos'], ['ya', 'cloud', 'code', 'nos']);
        t.eq(r.huecos.length, 1);
        t.ok(r.huecos[0].eHasta > r.huecos[0].eDesde, 'hay lado esperado');
        t.ok(r.huecos[0].sHasta > r.huecos[0].sDesde, 'y lado salido');
    });

    t.group('verificar el corte · qué se informa');

    t.test('un nombre propio oído de otra manera no es un defecto', () => {
        const b = bloque(1, 0, 'ya Clauco nos entregó los planos de nuestra casa');
        const salido = decir('ya Cloud Code nos entregó los planos de nuestra casa', 0);
        const informe = verificar.comparar({ bloques: [b], salido });
        t.deep(informe.bloques[0].diferencias, [], 'una palabra por dos no alcanza');
    });

    t.test('la charla del director que quedó dentro sí se informa', () => {
        // El caso real: el bloque 7 de la clase 6 empezaba con cinco segundos de
        // "Bueno, vamos a grabar una completa y si no, solamente… 3, 2, 1."
        const b = bloque(1, 0, 'aquí está el poder del spec driven development');
        const salido = decir('bueno vamos a grabar una completa 3 2 1 aquí está el poder del spec driven development', 0);
        const informe = verificar.comparar({ bloques: [b], salido });
        const d = informe.bloques[0].diferencias;
        t.eq(d.length, 1);
        t.eq(d[0].tipo, 'sobra');
        t.ok(d[0].delatora, 'el conteo la marca como delatora');
        t.ok(d[0].sobra.includes('bueno'), `«${d[0].sobra}»`);
    });

    t.test('una sola palabra delatora cuenta, sin esperar una corrida', () => {
        // "Pausa." al final de un bloque es UNA palabra, y es exactamente lo que
        // el editor tiene que sacar a mano. El listón de dos palabras existe para
        // el ruido del modelo, no para las órdenes al editor.
        const b = bloque(1, 0, 'sin importar a qué se dedica');
        const salido = decir('sin importar a qué se dedica pausa', 0);
        const informe = verificar.comparar({ bloques: [b], salido });
        t.eq(informe.bloques[0].diferencias.length, 1);
        t.ok(informe.bloques[0].diferencias[0].delatora);
    });

    t.test('una palabra suelta de más que no delata nada es ruido', () => {
        const b = bloque(1, 0, 'los requerimientos funcionales del sistema completo');
        const salido = decir('los requerimientos funcionales y del sistema completo', 0);
        const informe = verificar.comparar({ bloques: [b], salido });
        t.deep(informe.bloques[0].diferencias, []);
    });

    t.group('verificar el corte · las costuras');

    t.test('una palabra que cayó del otro lado del empalme no cuenta', () => {
        // En el empalme el reloj de Whisper no es exacto: la última palabra de un
        // bloque puede aparecer con un arranque que ya cae en el siguiente. Está
        // donde tiene que estar, y contarla taparía las diferencias de verdad.
        const uno = bloque(1, 0, 'la primera idea cierra bien acá mismo');
        const dos = bloque(2, 3, 'la segunda idea arranca limpia');
        const salido = [
            ...decir('la primera idea cierra bien', 0),
            ...decir('acá mismo la segunda idea arranca limpia', 3)
        ];
        const informe = verificar.comparar({ bloques: [uno, dos], salido });
        t.deep(informe.bloques[1].diferencias, [], 'el bloque 2 no acusa lo que era del 1');
    });

    t.test('pero una repetición en el medio del bloque sí', () => {
        // La regla de la costura pide las dos cosas: que el tramo esté pegado a
        // un borde y que el vecino lo tuviera. Sin lo primero, una frase que el
        // profesor repite en dos bloques excusaría cualquier repetición.
        const uno = bloque(1, 0, 'esto es una diferencia fundamental');
        const dos = bloque(2, 3, 'la segunda idea es una diferencia fundamental y sigue hasta el final');
        const salido = [
            ...decir('esto es una diferencia fundamental', 0),
            ...decir('la segunda idea es una diferencia fundamental es una diferencia fundamental y sigue hasta el final', 3)
        ];
        const informe = verificar.comparar({ bloques: [uno, dos], salido });
        t.ok(informe.bloques[1].diferencias.length >= 1, 'la repetición del medio se informa');
    });

    t.group('verificar el corte · repartir y sospechar');

    t.test('cada palabra va al bloque que la contiene', () => {
        const uno = { n: 1, desdeSec: 0, hastaSec: 10, esperado: [] };
        const dos = { n: 2, desdeSec: 10, hastaSec: 20, esperado: [] };
        const cajas = verificar.repartir([uno, dos], decir('a b c d e f', 8, 2));
        t.eq(cajas[0].length, 1, 'a (8→10, medio 9)');
        t.eq(cajas[1].length, 5);
    });

    t.test('una palabra fuera de todos los tramos va a la más cercana', () => {
        // Pasa en el último borde: Whisper puede cerrar la última palabra unos
        // milisegundos después del final del render.
        const uno = { n: 1, desdeSec: 0, hastaSec: 4, esperado: [] };
        const cajas = verificar.repartir([uno], decir('final', 4.5, 0.5));
        t.eq(cajas[0].length, 1);
    });

    t.test('la claqueta y el conteo se buscan en el render, no en el plan', () => {
        // Va aparte de la comparación porque no depende de que el plan estuviera
        // bien: si el plan también los incluía, el diff no los ve.
        const encontradas = verificar.sospechas(
            decir('claqueta 6 clase 6 3 2 1 ya Clauco nos entregó', 0));
        t.eq(encontradas.filter(s => s.tipo === 'claqueta').length, 1);
        t.eq(encontradas.filter(s => s.tipo === 'conteo').length, 1);
    });

    t.test('un número dicho dentro de la clase no es un conteo', () => {
        // "Uno de los problemas más comunes" abre clases de verdad: hacen falta
        // DOS palabras de cuenta seguidas, que es la definición del motor.
        const encontradas = verificar.sospechas(
            decir('uno de los problemas más comunes es la ambigüedad', 0));
        t.deep(encontradas, []);
    });

    t.test('contieneSecuencia busca en orden y con tolerancia', () => {
        t.ok(verificar.contieneSecuencia(['a', 'ambiguedades', 'c'], ['ambiguedad']));
        t.ok(!verificar.contieneSecuencia(['a', 'b', 'c'], ['c', 'b']), 'el orden importa');
        t.ok(!verificar.contieneSecuencia(['a'], []), 'nada no está contenido en nada');
    });
};
