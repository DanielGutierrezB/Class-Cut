'use strict';
/**
 * Cómo viene hablando el profesor (`engine/lengua.js`).
 *
 * Lo que de verdad importa acá son dos cosas. Una es que lo determinista no se
 * mueva: son los tres números que el profesor va a ver mientras graba, y si el
 * conteo de muletillas se vuelve un contador de demostrativos el panel avisa
 * siempre y se deja de mirar. La otra es que lo que devuelve el modelo no entre
 * sin pasar por la aduana: un hallazgo que cita algo que la toma no dijo manda al
 * profesor a corregir una frase que no existe, y en vivo eso es peor que no medir.
 */

const lengua = require('../engine/lengua');
const medirToma = require('../engine/medir-toma');
const notasXml = require('../engine/notas-xml');
const maqueta = require('../tools/maqueta');
const fs = require('fs');

/** Palabras con hora del día, escritas cómodo: "texto@segundo". */
function hablar(base, lista) {
    return lista.map(item => {
        const corte = item.lastIndexOf('@');
        return {
            t: base + Math.round(Number(item.slice(corte + 1)) * 1000),
            texto: item.slice(0, corte)
        };
    });
}

/**
 * Una toma con palabras repartidas a un ritmo pedido.
 *
 * Se arma por ritmo y no a mano porque lo que se prueba son tasas: pedir "180
 * palabras por minuto" y esperar 180 dice qué se está probando, mientras que
 * cuarenta tiempos escritos a mano no dicen nada y hay que rehacer la cuenta
 * para leer la prueba.
 */
function tomaA(base, ppm, palabras, texto) {
    const paso = 60000 / ppm;
    const lista = [];
    for (let i = 0; i < palabras; i++) {
        lista.push({ t: base + Math.round(paso * i), texto: texto ? texto[i] || 'palabra' : 'palabra' });
    }
    return {
        id: 1,
        inMs: base,
        outMs: base + Math.round(paso * palabras),
        palabras: lista,
        descartada: false
    };
}

module.exports = t => {
    const BASE = Date.UTC(2026, 8, 8, 15, 0, 0);

    t.group('lengua · las muletillas');

    t.test('"o sea" se cuenta partido en dos palabras, como llega de Whisper', () => {
        const p = hablar(BASE, ['Esto@0', 'es,@0.4', 'o@0.8', 'sea,@1.1', 'lo@1.5', 'mismo@1.8']);
        const m = lengua.muletillasEn(p);
        t.eq(m.cuantas, 1);
        t.eq(m.cuales[0], 'o sea');
    });

    t.test('"digamos que" cuenta una vez y no dos', () => {
        // Si contara el "digamos" y además la pareja, la tasa saldría al doble en
        // cualquier toma donde el profesor use la forma larga.
        const p = hablar(BASE, ['Y@0', 'digamos@0.4', 'que@0.7', 'acá@1', 'pasa@1.3']);
        const m = lengua.muletillasEn(p);
        t.eq(m.cuantas, 1);
        t.eq(m.cuales[0], 'digamos que');
    });

    t.test('"este" como demostrativo no cuenta, y suelto sí', () => {
        // Los dos casos en la misma prueba a propósito: es EL falso positivo de
        // esta medida —"este" aparece 265 veces en el curso y solo 10 sueltas—, y
        // separarlos en dos pruebas deja pasar el día que la regla se relaje.
        const demostrativo = hablar(BASE, ['En@0', 'este@0.4', 'curso@0.8', 'vamos@1.2']);
        t.eq(lengua.muletillasEn(demostrativo).cuantas, 0);

        const suelto = hablar(BASE, ['Y@0', 'este,@0.4', 'lo@0.9', 'que@1.2', 'pasa@1.5']);
        t.eq(lengua.muletillasEn(suelto).cuantas, 1);
    });

    t.test('"nada" y "tipo" siguen la misma regla de la puntuación', () => {
        const normales = hablar(BASE, ['No@0', 'hay@0.3', 'nada@0.6', 'de@0.9', 'ese@1.1',
            'tipo@1.4', 'de@1.7', 'archivo@2']);
        t.eq(lengua.muletillasEn(normales).cuantas, 0, 'son palabras normales de una clase');

        const sueltas = hablar(BASE, ['Bueno,@0', 'nada.@0.5', 'Es@1', 'tipo…@1.4', 'raro@1.9']);
        t.eq(lengua.muletillasEn(sueltas).cuantas, 2);
    });

    t.test('las coletillas piden el signo de pregunta puesto', () => {
        const pregunta = hablar(BASE, ['Se@0', 'entiende,@0.4', '¿no?@0.9', 'Bien@1.4']);
        t.eq(lengua.muletillasEn(pregunta).cuantas, 1);

        const negacion = hablar(BASE, ['Acá@0', 'no@0.3', 'hay@0.6', 'nada@0.9', 'raro@1.2']);
        t.eq(lengua.muletillasEn(negacion).cuantas, 0, '"no" es una palabra, "¿no?" es una coletilla');
    });

    t.test('lo que se dejó afuera se queda afuera', () => {
        // "Bueno" y "entonces" son cómo se abre una toma y cómo se enlaza una idea.
        // Si entraran, el panel estaría avisando de que el profesor habla como un
        // profesor: "bueno" solo aparece 116 veces en el curso.
        const p = hablar(BASE, ['Bueno,@0', 'entonces@0.5', 'claro,@1', 'es@1.4', 'decir,@1.7',
            'seguimos@2.2']);
        t.eq(lengua.muletillasEn(p).cuantas, 0);
    });

    t.test('los acentos y las mayúsculas no cambian el conteo', () => {
        const p = hablar(BASE, ['Es,@0', 'Básicamente,@0.5', 'lo@1, ', 'mismo@1.3']);
        t.eq(lengua.muletillasEn(p).cuantas, 1);
    });

    t.group('lengua · el ritmo y el aire muerto');

    t.test('el ritmo sale de la aritmética de los tiempos', () => {
        const toma = tomaA(BASE, 180, 60);
        const m = lengua.medir(toma);
        t.eq(m.ppm, 180);
        t.eq(lengua.zona('ppm', m.ppm), 'bien');
    });

    t.test('hablar muy rápido y hablar muy lento caen los dos fuera de zona', () => {
        // Las dos puntas, porque la banda tiene dos: una banda con un solo borde
        // dejaría pasar la clase que se arrastra, que es igual de mala de ver.
        t.eq(lengua.zona('ppm', lengua.medir(tomaA(BASE, 240, 80)).ppm), 'ojo');
        t.eq(lengua.zona('ppm', lengua.medir(tomaA(BASE, 110, 40)).ppm), 'ojo');
    });

    t.test('un hueco largo es aire muerto y no baja el ritmo', () => {
        // Es la resta que hace que las dos medidas sean accionables por separado:
        // medido contra el reloj, este profesor daría un ritmo "sano" de 90 y las
        // dos cosas que pasaron —habla a 180, se calló medio minuto— se taparían.
        const rapido = tomaA(BASE, 180, 90);
        const m = lengua.medir({ ...rapido, outMs: rapido.outMs + 30000 });
        t.near(m.ppm, 180, 3, 'el ritmo se mide contra el tiempo hablando, no contra el reloj');
        t.near(m.aireSec, 30, 0.5);
        t.eq(lengua.zona('airePct', m.airePct), 'ojo');
    });

    t.test('una pausa corta no es aire muerto', () => {
        // Por debajo del listón de `oir` no hay nada que avisar: respirar, pensar
        // y dejar que algo se entienda son pausas de clase, no un problema.
        const p = hablar(BASE, ['Miren@0', 'esto@0.4', 'acá@2.2', 'en@22', 'la@22.3', 'pantalla@22.6']);
        const m = lengua.medir({ id: 1, inMs: BASE, outMs: BASE + 23000, palabras: p });
        t.eq(m.aireSec, 19.8, 'el hueco de 19,8 s cuenta; el de 1,8 s no');

        const seguido = hablar(BASE, ['Miren@0', 'esto@1.5', 'acá@3', 'en@22', 'la@22.3', 'y@22.6']);
        const n = lengua.medir({ id: 1, inMs: BASE, outMs: BASE + 22800, palabras: seguido });
        t.eq(Math.round(n.aireSec), 19, 'los saltos de 1,5 s no suman');
    });

    t.test('una toma corta entra al agregado pero no tiene tasa propia', () => {
        // Sobre quince segundos, una sola muletilla se leería como cuatro por
        // minuto y el profesor vería una alarma por haber dicho "o sea" una vez.
        const corta = tomaA(BASE, 170, 40);
        const m = lengua.medir(corta);
        t.eq(m.ppm, null);
        t.eq(m.palabras, 40, 'las palabras se cuentan igual: lo que falta es la tasa');
        t.ok(m.hablandoSec < lengua.MINIMO_SEC);
    });

    t.test('una toma sin cerrar no se mide', () => {
        // Su texto es el del ciclo de señales, que se descarta y se rehace entero
        // al cerrar: contar sobre él sería medir al transcriptor barato.
        t.eq(lengua.medir({ id: 1, inMs: BASE, outMs: null, palabras: [] }), null);
        t.eq(lengua.medir(null), null);
    });

    t.test('una toma vacía no rompe nada', () => {
        const m = lengua.medir({ id: 1, inMs: BASE, outMs: BASE + 5000, palabras: [] });
        t.eq(m.palabras, 0);
        t.eq(m.ppm, null);
        t.eq(m.muletillas, 0);
    });

    t.group('lengua · el agregado de la clase');

    /** Tres tomas medidas: una limpia, una con muletillas, una descartada horrible. */
    function claseDePrueba() {
        const limpia = tomaA(BASE, 170, 100);
        const sucia = tomaA(BASE + 200000, 170, 100,
            ['O', 'sea,', 'digamos,', 'este,', 'nada,', 'eh,']);
        sucia.id = 2;
        const mala = tomaA(BASE + 400000, 60, 40);
        mala.id = 3;
        mala.descartada = true;

        const contestada = { estado: 'listo', porque: '', modelo: 'de-prueba', hallazgos: [] };
        for (const toma of [limpia, sucia, mala]) {
            toma.lengua = { det: lengua.medir(toma), ia: { ...contestada } };
        }
        return [limpia, sucia, mala];
    }

    t.test('la toma descartada no cuenta en ninguna de las tres tasas', () => {
        // Es el detalle de corrección del pedido: el número que ve el profesor
        // tiene que ser el de la clase que va a quedar, no el de todo lo grabado.
        const tomas = claseDePrueba();
        const conMala = lengua.agregado(tomas);
        t.eq(conMala.tomas, 2);
        t.eq(conMala.ppm, 170);

        tomas[2].descartada = false;
        const conTodas = lengua.agregado(tomas);
        t.eq(conTodas.tomas, 3);
        t.ok(conTodas.ppm < 170, 'la toma lenta arrastra el ritmo cuando cuenta');
    });

    t.test('volver a incluir una toma la trae con su medida intacta', () => {
        // Descartar no borra nada, y por eso descartar es reversible y gratis: la
        // medida vive en la toma. Si se descartara del agregado, volver a
        // incluirla obligaría a medir de nuevo.
        const tomas = claseDePrueba();
        const antes = lengua.agregado(tomas).ppm;
        tomas[1].descartada = true;
        tomas[1].descartada = false;
        t.eq(lengua.agregado(tomas).ppm, antes);
    });

    t.test('la última que se muestra es la última que QUEDA', () => {
        // Si la de recién se descartó, lo que hay que mirar es la anterior: la
        // descartada no puede encabezar el panel más de lo que puede contar.
        const tomas = claseDePrueba();
        t.eq(lengua.agregado(tomas).ultima.toma, 2);
        tomas[1].descartada = true;
        t.eq(lengua.agregado(tomas).ultima.toma, 1);
    });

    t.test('la que todavía se está midiendo no encabeza el panel', () => {
        // Con el proveedor de esta Mac la lectura tarda dos minutos, así que la
        // toma más nueva casi siempre está en camino: si esa fuera "la última",
        // las tres filas del modelo estarían en un guion permanente.
        const tomas = claseDePrueba();
        tomas[1].lengua.ia = { estado: 'midiendo', porque: '', hallazgos: [] };
        const a = lengua.agregado(tomas);
        t.eq(a.ultima.toma, 1, 'se muestra lo último que el modelo dijo de verdad');
        t.eq(a.midiendo, 2, 'y aparte se dice qué toma está en el modelo ahora');
        t.eq(a.tomas, 2, 'las tasas la cuentan igual: no dependen del modelo');
    });

    t.test('una falla también es algo que el modelo contestó', () => {
        // "No se pudo medir, y por qué" es información. Saltearla dejaría el panel
        // mostrando un resultado viejo sin decir que el nuevo se cayó.
        const tomas = claseDePrueba();
        tomas[1].lengua.ia = { estado: 'falla', porque: 'se cayó la red', hallazgos: [] };
        t.eq(lengua.agregado(tomas).ultima.toma, 2);
    });

    t.test('la toma que el carril desplazó no se muestra ni se cuenta como medida', () => {
        // Queda sin estado de modelo a propósito: no falló nada, no se preguntó.
        const tomas = claseDePrueba();
        delete tomas[1].lengua.ia;
        const a = lengua.agregado(tomas);
        t.eq(a.ultima.toma, 1);
        t.eq(a.midiendo, null);
        t.eq(a.tomas, 2, 'sus palabras y sus segundos siguen contando');
    });

    t.test('la toma abierta se declara abierta y no se cuenta', () => {
        const tomas = claseDePrueba();
        tomas.push({ id: 4, inMs: BASE + 600000, outMs: null, palabras: [], descartada: false });
        const a = lengua.agregado(tomas);
        t.eq(a.abierta, true);
        t.eq(a.tomas, 2, 'sigue siendo el agregado de las dos cerradas que quedan');
    });

    t.test('las cerradas sin medir se cuentan aparte, para no parecer roto', () => {
        // Entre que una toma cierra y que se le rehace el texto pasa un rato. Un
        // panel vacío con tomas en la lista se lee como un error si no lo explica.
        const tomas = claseDePrueba();
        tomas.push({ id: 4, inMs: BASE + 600000, outMs: BASE + 640000, palabras: [], descartada: false });
        t.eq(lengua.agregado(tomas).sinMedir, 1);
    });

    t.test('las tasas se agregan pooleadas, no promediando promedios', () => {
        // Una toma de diez segundos no puede pesar lo mismo que una de dos
        // minutos: se suman palabras y se suman segundos, y se divide una vez.
        const larga = tomaA(BASE, 200, 400);
        const corta = tomaA(BASE + 500000, 100, 50);
        corta.id = 2;
        for (const toma of [larga, corta]) toma.lengua = { det: lengua.medir(toma) };
        const a = lengua.agregado([larga, corta]);
        t.eq(a.ppm, 180, 'el promedio de 200 y 100 sería 150; pooleado, la larga pesa y da 180');
    });

    t.test('el agregado dice en qué zona cae cada tasa, y contra qué banda', () => {
        // La ventana no importa módulos del motor, así que si la comparación se
        // hiciera allá las bandas estarían escritas dos veces.
        const a = lengua.agregado(claseDePrueba());
        t.eq(a.zonas.ppm, 'bien');
        t.eq(a.zonas.muletillasPorMin, 'ojo', 'seis muletillas en 100 palabras');
        t.eq(a.bandas.ppm.desde, lengua.BANDAS.ppm.desde);
    });

    t.test('dice cuáles fueron las muletillas, y cuántas veces cada una', () => {
        const a = lengua.agregado(claseDePrueba());
        t.ok(a.masDichas.length > 0);
        t.eq(a.masDichas[0].cual, 'o sea');
        t.eq(a.masDichas[0].veces, 1);
    });

    t.test('una clase sin nada medido no explota', () => {
        const a = lengua.agregado([]);
        t.eq(a.tomas, 0);
        t.eq(a.ppm, null);
        t.eq(a.ultima, null);
        t.eq(a.zonas.ppm, null);
    });

    t.group('lengua · la aduana de lo que devuelve el modelo');

    const TOMA = {
        id: 1,
        inMs: BASE,
        outMs: BASE + 60000,
        palabras: hablar(BASE, [
            'Esto@0', 'que@0.3', 'ven@0.6', 'es@0.9', 'spec@1.2', 'driven@1.5',
            'development,@1.9', 'y@2.4', 'es@2.7', 'el@3', 'cambio@3.3', 'más@3.7',
            'grande@4', 'de@4.4', 'los@4.7', 'últimos@5', 'años.@5.4'
        ])
    };

    t.test('el hallazgo que cita algo que se dijo pasa', () => {
        const buenos = lengua.validar({
            hallazgos: [{ tipo: 'jerga', que: 'spec driven development', detalle: 'No lo explica.' }]
        }, TOMA);
        t.eq(buenos.length, 1);
        t.eq(buenos[0].tipo, 'jerga');
    });

    t.test('el hallazgo que cita algo que NO se dijo se tira', () => {
        // Es la defensa entera de esto: sin ancla verificable, un modelo que
        // alucina un problema lo pone en pantalla igual, y el profesor sale a
        // corregir en la toma siguiente una frase que nunca dijo.
        const buenos = lengua.validar({
            hallazgos: [
                { tipo: 'sin_cerrar', que: 'lo que quería decir es que', detalle: 'Queda colgando.' },
                { tipo: 'jerga', que: 'spec driven development', detalle: 'No lo explica.' }
            ]
        }, TOMA);
        t.eq(buenos.length, 1, 'sobrevive solo el que está en la toma');
        t.eq(buenos[0].tipo, 'jerga');
    });

    t.test('la cita se compara aplanada: una coma de más no tira un hallazgo bueno', () => {
        // El modelo repuntúa lo que copia. Pedir coincidencia exacta tiraría
        // hallazgos buenos por una tilde, y ahí la aduana pasaría a ser el problema.
        const buenos = lengua.validar({
            hallazgos: [{ tipo: 'jerga', que: 'Spec-Driven Development;', detalle: 'Sin explicar.' }]
        }, TOMA);
        t.eq(buenos.length, 1);
        t.eq(buenos[0].que, 'Spec-Driven Development;', 'se guarda como el modelo la escribió');
    });

    t.test('un tipo que no existe se tira', () => {
        const buenos = lengua.validar({
            hallazgos: [{ tipo: 'muletilla', que: 'spec driven', detalle: 'Algo.' }]
        }, TOMA);
        t.eq(buenos.length, 0);
    });

    t.test('un hallazgo sin detalle se tira', () => {
        // Una fila que dice "hay un problema" y no dice cuál no es accionable: el
        // profesor tendría que volver a escuchar la toma para saber de qué habla.
        t.eq(lengua.validar({
            hallazgos: [{ tipo: 'jerga', que: 'spec driven development', detalle: '  ' }]
        }, TOMA).length, 0);
    });

    t.test('un modelo hablador no llena el panel', () => {
        const muchos = [];
        for (let i = 0; i < 9; i++) {
            muchos.push({ tipo: 'jerga', que: 'spec driven development', detalle: `Otra vez ${i}.` });
        }
        t.eq(lengua.validar({ hallazgos: muchos }, TOMA).length, lengua.MAXIMO_POR_TIPO);
    });

    t.test('el tope es por tipo y no del total', () => {
        // Tres frases colgando y tres jergas son seis cosas distintas para
        // arreglar; un tope global tiraría los tres de un tipo por el otro.
        const mezcla = [];
        for (let i = 0; i < 4; i++) {
            mezcla.push({ tipo: 'jerga', que: 'spec driven', detalle: `Uno ${i}.` });
            mezcla.push({ tipo: 'sin_cerrar', que: 'el cambio más grande', detalle: `Otro ${i}.` });
        }
        const buenos = lengua.validar({ hallazgos: mezcla }, TOMA);
        t.eq(buenos.length, lengua.MAXIMO_POR_TIPO * 2);
    });

    t.test('una respuesta vacía, nula o rara devuelve una lista vacía', () => {
        // El modelo puede volver con cualquier cosa, y de acá no puede salir una
        // excepción: es una grabación en curso.
        t.eq(lengua.validar(null, TOMA).length, 0);
        t.eq(lengua.validar({}, TOMA).length, 0);
        t.eq(lengua.validar({ hallazgos: 'nada' }, TOMA).length, 0);
        t.eq(lengua.validar({ hallazgos: [null, 3, 'x'] }, TOMA).length, 0);
    });

    t.test('la consulta lleva el texto de la toma y los tres tipos', () => {
        const p = lengua.prompt(TOMA);
        t.ok(p.includes('spec driven development,'), 'el texto va de corrido');
        for (const tipo of lengua.TIPOS) t.ok(p.includes(tipo), `pide ${tipo}`);
        t.ok(p.includes('JSON'));
    });

    t.group('lengua · el medidor, enganchado al mecanismo');

    /** Un cliente de mentira: contesta lo que se le diga, sin red y sin proveedor. */
    function clienteQueDice(respuesta) {
        return { ask: async () => respuesta };
    }

    /**
     * Una toma que pasa los dos mínimos: 60 palabras y 21 s de habla.
     *
     * Hace falta que los pase los DOS, y por separado: con pocas palabras el
     * medidor no consulta, y con pocos segundos lo determinista no da tasa
     * propia. Una toma que falle uno de los dos haría pasar una prueba por el
     * motivo equivocado.
     */
    function tomaLarga(id) {
        const dicha = ['Esto', 'que', 'ven', 'es', 'spec', 'driven', 'development,', 'y', 'es',
            'el', 'cambio', 'más', 'grande', 'de', 'los', 'últimos', 'años.'];
        const palabras = [];
        for (let i = 0; i < 60; i++) palabras.push({ t: BASE + i * 350, texto: dicha[i % dicha.length] });
        return { id: id || 1, inMs: BASE, outMs: BASE + 60 * 350, palabras, descartada: false };
    }

    t.test('el medidor lee una respuesta buena y la deja en la toma', async () => {
        const toma = tomaLarga();
        await medirToma.conEstos([lengua.medidor], async () => {
            await medirToma.conModelo({
                toma,
                cliente: clienteQueDice({
                    hallazgos: [{ tipo: 'jerga', que: 'spec driven development', detalle: 'Sin explicar.' }]
                })
            });
        });
        t.eq(toma.lengua.ia.estado, 'listo');
        t.eq(toma.lengua.ia.hallazgos.length, 1);
    });

    t.test('sin proveedor, lo determinista queda y lo del modelo dice por qué no', async () => {
        // Es la mitad del diseño: el panel no puede quedarse en blanco porque no
        // haya proveedor configurado. Los tres números de arriba no lo necesitan.
        const toma = tomaLarga();
        await medirToma.conEstos([lengua.medidor], async () => {
            medirToma.medir(toma);
            await medirToma.conModelo({ toma, cliente: null });
        });
        t.eq(toma.lengua.ia.estado, 'sin-modelo');
        t.ok(toma.lengua.det.ppm > 0, 'lo determinista está igual');
    });

    t.test('una consulta que vuelve con error deja dicho que no se pudo', async () => {
        const toma = tomaLarga();
        await medirToma.conEstos([lengua.medidor], async () => {
            await medirToma.conModelo({ toma, cliente: clienteQueDice({ error: 'se cayó la red' }) });
        });
        t.eq(toma.lengua.ia.estado, 'falla');
        t.eq(toma.lengua.ia.porque, 'se cayó la red');
    });

    t.test('un medidor con un bug no tumba la grabación', async () => {
        // El panel tiene que poder decir "no se pudo" en vez de tirar abajo la
        // clase por un renglón.
        const toma = tomaLarga();
        const roto = {
            clave: 'roto',
            medir: () => { throw new Error('me caí midiendo'); },
            conModelo: async () => { throw new Error('me caí leyendo'); }
        };
        await medirToma.conEstos([roto, lengua.medidor], async () => {
            medirToma.medir(toma);
            await medirToma.conModelo({ toma, cliente: clienteQueDice({ hallazgos: [] }) });
        });
        t.eq(toma.roto.ia.estado, 'falla');
        t.eq(toma.lengua.ia.estado, 'listo', 'el medidor de al lado midió igual');
        t.ok(toma.lengua.det, 'y lo determinista también');
    });

    t.test('una toma de pocas palabras no se consulta', async () => {
        // En treinta palabras no hay una idea que pueda quedar colgando: la
        // consulta se pagaría para que conteste que no hay nada.
        let pedidas = 0;
        const toma = tomaA(BASE, 170, 10);
        await medirToma.conEstos([lengua.medidor], async () => {
            await medirToma.conModelo({
                toma,
                cliente: { ask: async () => { pedidas++; return { hallazgos: [] }; } }
            });
        });
        t.eq(pedidas, 0);
        t.eq(toma.lengua.ia.estado, 'listo', 'y queda dicho que no hay nada, no que falló');
    });

    t.test('una toma ya medida no se vuelve a consultar', async () => {
        // Mover un OUT una frase no cambia si una idea quedó colgando, y una
        // consulta por cada arrastre de borde es cómo esto se vuelve una factura.
        let pedidas = 0;
        const toma = tomaLarga();
        const cliente = { ask: async () => { pedidas++; return { hallazgos: [] }; } };
        await medirToma.conEstos([lengua.medidor], async () => {
            await medirToma.conModelo({ toma, cliente });
            await medirToma.conModelo({ toma, cliente });
        });
        t.eq(pedidas, 1);
    });

    t.test('lo que falló sí se reintenta en la relectura siguiente', () => {
        // Al revés que lo anterior: una consulta caída puede andar la próxima vez,
        // y no reintentarla dejaría la toma sin medir para siempre por un timeout.
        const toma = { lengua: { ia: { estado: 'falla', porque: 'se cayó', hallazgos: [] } } };
        t.eq(toma.lengua.ia.estado, 'falla');
    });

    t.test('en la cola espera solo la última toma; la del medio se cae', async () => {
        // Es lo que se aprendió midiendo: con el modelo configurado una toma tarda
        // dos minutos y las tomas cierran cada uno, así que una fila que las
        // guarde todas se atrasa sola y a la media hora está leyendo lo de hace
        // veinte minutos, cobrando cada una de las del medio.
        const preguntadas = [];
        let soltar = null;
        const cliente = {
            ask: async () => {
                if (!soltar) {
                    await new Promise(r => { soltar = r; });
                    return { hallazgos: [] };
                }
                return { hallazgos: [] };
            }
        };
        const medidor = {
            clave: 'lengua',
            medir: lengua.medidor.medir,
            conModelo: async ({ toma, cliente: c }) => {
                preguntadas.push(toma.id);
                await c.ask({});
                return { hallazgos: [] };
            }
        };

        const una = tomaLarga(1);
        const dos = tomaLarga(2);
        const tres = tomaLarga(3);
        await medirToma.conEstos([medidor], async () => {
            const primera = medirToma.conModelo({ toma: una, cliente });
            await new Promise(r => setTimeout(r, 10));
            const segunda = medirToma.conModelo({ toma: dos, cliente });
            const tercera = medirToma.conModelo({ toma: tres, cliente });
            await new Promise(r => setTimeout(r, 10));
            soltar();
            await Promise.all([primera, segunda, tercera]);
        });

        t.deep(preguntadas, [1, 3], 'la 2 se cayó cuando cerró la 3');
        t.eq(una.lengua.ia.estado, 'listo');
        t.eq(tres.lengua.ia.estado, 'listo');
        t.eq(dos.lengua.ia, undefined, 'la desplazada queda sin estado, no en falla');
    });

    t.test('las consultas van en fila y no encimadas', async () => {
        // Dos tomas pueden cerrar en segundos —el profesor arranca, se equivoca y
        // vuelve a arrancar—: con dos consultas en el aire el proveedor las cobra
        // las dos y la segunda respuesta puede llegar antes que la primera.
        let enElAire = 0;
        let maximo = 0;
        const cliente = {
            ask: async () => {
                enElAire++;
                maximo = Math.max(maximo, enElAire);
                await new Promise(r => setTimeout(r, 10));
                enElAire--;
                return { hallazgos: [] };
            }
        };
        const una = tomaLarga(1);
        const otra = tomaLarga(2);
        await medirToma.conEstos([lengua.medidor], async () => {
            await Promise.all([
                medirToma.conModelo({ toma: una, cliente }),
                medirToma.conModelo({ toma: otra, cliente })
            ]);
        });
        t.eq(maximo, 1);
        t.eq(una.lengua.ia.estado, 'listo');
        t.eq(otra.lengua.ia.estado, 'listo');
    });

    t.test('al terminar, lo que quedó a medio medir se dice y no queda "midiendo"', async () => {
        // Sobre una clase terminada, un "midiendo" eterno se lee como que sigue
        // pensando. El editor apretó Terminar porque quiere el XML en la mano.
        const toma = { id: 1, lengua: { det: { ppm: 170 }, ia: { estado: 'midiendo', porque: '', hallazgos: [] } } };
        await medirToma.conEstos([lengua.medidor], async () => {
            t.eq(await medirToma.cerrar([toma]), true);
        });
        t.eq(toma.lengua.ia.estado, 'falla');
        t.ok(toma.lengua.ia.porque.includes('terminó'));
        t.eq(toma.lengua.det.ppm, 170, 'lo determinista se guardó cuando la toma cerró');
    });

    t.group('lengua · lo que queda guardado');

    t.test('la medida de cada toma va al sidecar, y el agregado no', () => {
        // El agregado se recalcula al leer: si estuviera guardado, descartar una
        // toma en una clase vieja dejaría el número mintiendo. Es la misma
        // decisión que ya tomó `repeticiones`.
        const tomas = claseDePrueba();
        const escrito = notasXml.sidecar({
            secuencia: '05_curso_2026-09-08_15-20-00',
            clase: 5, parte: 1, curso: 'curso',
            ceroMs: BASE,
            tomas
        });
        const leido = JSON.parse(JSON.stringify(escrito));
        t.ok(leido.tomas[0].lengua, 'la toma trae su medida');
        t.eq(leido.tomas[0].lengua.det.ppm, 170);
        t.eq(leido.lengua, undefined, 'el agregado no se guarda: se recalcula');

        // Y lo que se guardó alcanza para rehacer el agregado sin volver a medir.
        t.eq(lengua.agregado(leido.tomas).ppm, 170);
    });

    t.group('lengua · las bandas, de los dos lados');

    t.test('la maqueta usa las mismas bandas que el motor', () => {
        // Ya no las copia: el servidor de la maqueta es Node y se las pasa, igual
        // que las vistas. Lo que se comprueba acá es que ese camino siga abierto,
        // porque cortarlo no rompe nada visible — la maqueta mostraría en zona un
        // número que en la app está fuera, y una maqueta que miente no sirve para
        // aprobar nada.
        const servido = maqueta.vistasParaElNavegador();
        const bandas = JSON.parse(servido.match(/window\.maquetaLengua = (\{.*\});/)[1]).BANDAS;
        t.deep(bandas, lengua.BANDAS, 'la maqueta recibe las bandas del motor, tal cual');

        const cc = fs.readFileSync('tools/maqueta/cc.js', 'utf8');
        t.ok(cc.includes('window.maquetaLengua.BANDAS'),
            'y las lee de ahí en vez de tener su propia tabla');
    });
};
