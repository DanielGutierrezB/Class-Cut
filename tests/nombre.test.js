'use strict';
/**
 * Cómo se llama el XML de una clase tomada en vivo.
 *
 * Lo que de verdad se prueba acá es la ida y vuelta: lo que se escribe al
 * arrancar una grabación tiene que poder leerse meses después, cuando el
 * escáner busca a qué carpeta del Rodecaster corresponde. Si las dos mitades se
 * separan, no falla nada — empareja mal, que es peor.
 */

const nombre = require('../engine/nombre-de-clase');
const rodecaster = require('../engine/rodecaster-xml');

module.exports = t => {
    t.group('el nombre de una clase · lo que se escribe');

    // 8 de septiembre de 2026, 13:01:47, hora de esta máquina.
    const CUANDO = new Date(2026, 8, 8, 13, 1, 47).getTime();

    t.test('el número va con dos dígitos, como en la carpeta del Rodecaster', () => {
        t.eq(nombre.armar({ clase: 1, curso: 'El curso', cuandoMs: CUANDO }),
            '01_el-curso_2026-09-08_13-01-47');
        t.eq(nombre.armar({ clase: 13, curso: 'El curso', cuandoMs: CUANDO }),
            '13_el-curso_2026-09-08_13-01-47');
    });

    t.test('la hora es la del reloj de la pared, no UTC', () => {
        // Es contra lo que hay que emparejar: el Rodecaster escribe la hora de su
        // propio reloj en el nombre de su carpeta. Con UTC habría que convertir
        // una de las dos, y con el Rodecaster en otra zona se correría horas.
        const armado = nombre.armar({ clase: 1, curso: 'x', cuandoMs: CUANDO });
        t.eq(armado.endsWith('_2026-09-08_13-01-47'), true, armado);
    });

    t.test('la primera parte no se escribe, la segunda sí', () => {
        // Un "_p1_" en todas las clases haría ruido justo para distinguir el caso
        // raro, que es la clase que se grabó en dos tandas.
        t.eq(nombre.armar({ clase: 1, parte: 1, curso: 'x', cuandoMs: CUANDO }),
            '01_x_2026-09-08_13-01-47');
        t.eq(nombre.armar({ clase: 1, parte: 3, curso: 'x', cuandoMs: CUANDO }),
            '01_p3_x_2026-09-08_13-01-47');
    });

    t.test('el curso sale del nombre de una carpeta, así que se limpia', () => {
        // Lo que llega es el nombre de la carpeta que eligió el editor: puede
        // traer tildes, espacios, barras y mayúsculas.
        t.eq(nombre.cursoEnElNombre('Spec-Driven Development'), 'spec-driven-development');
        t.eq(nombre.cursoEnElNombre('Diseño / UX 2026'), 'diseno-ux-2026');
        // Una carpeta siempre se llama de algo, y si lo que se llama no deja
        // ninguna letra, igual tiene que quedar un nombre: uno vacío daría
        // "01__2026-09-08_…", que ya no se puede volver a leer.
        t.eq(nombre.cursoEnElNombre('   '), 'sin-nombre', 'lo pone `workspace.safeName`');
        t.eq(nombre.cursoEnElNombre('///'), 'clase');
        t.eq(nombre.leer(nombre.armar({ clase: 1, curso: '///', cuandoMs: CUANDO })).clase, 1);
    });

    t.group('el nombre de una clase · lo que se lee');

    t.test('ida y vuelta: lo que se escribe se vuelve a leer entero', () => {
        for (const parte of [1, 2, 5]) {
            const armado = nombre.armar({ clase: 7, parte, curso: 'El curso', cuandoMs: CUANDO });
            const leido = nombre.leer(armado);
            t.eq(leido.clase, 7, armado);
            t.eq(leido.parte, parte, armado);
            t.eq(leido.curso, 'el-curso', armado);
            t.eq(leido.cuandoMs, CUANDO, armado);
        }
    });

    t.test('con la extensión puesta, que es como llega del escáner', () => {
        const leido = nombre.leer('01_p2_el-curso_2026-09-08_15-10-00.xml');
        t.eq(leido.clase, 1);
        t.eq(leido.parte, 2);
        t.eq(leido.cuandoMs, new Date(2026, 8, 8, 15, 10, 0).getTime());
    });

    t.test('un curso que se llama como una fecha no confunde a nadie', () => {
        // La fecha y la hora están ancladas al final, así que el curso puede
        // parecerse a ellas sin que se las coma.
        const leido = nombre.leer('02_2026-08-18_2026-09-08_13-01-47');
        t.eq(leido.clase, 2);
        t.eq(leido.curso, '2026-08-18');
        t.eq(leido.cuandoMs, CUANDO);
    });

    t.test('un nombre viejo se lee igual, sin hora', () => {
        // Los que se escribieron antes de que la hora existiera. No es un error:
        // tienen número de clase, que es con lo que se emparejaba entonces, y
        // quien empareja los deja para el final (ver `xmlDeNotas`).
        const leido = nombre.leer('01_2609_el-curso-1788571821039');
        t.eq(leido.clase, 1);
        t.eq(leido.parte, 1);
        t.eq(leido.cuandoMs, null);
    });

    t.test('lo que no es un nombre de clase no lo es', () => {
        t.eq(nombre.leer('Sync.xml'), null);
        t.eq(nombre.leer(''), null);
        t.eq(nombre.leer(null), null);
    });

    t.test('una parte sigue siendo la misma clase para todo post', () => {
        // Es lo que decide el guión bajo del "_p2_": el número de clase se lee
        // con la misma expresión que los XML del director de contenido, así que
        // "01p2_…" no daría clase ninguna y la carpeta se quedaría sin XML.
        const armado = nombre.armar({ clase: 4, parte: 2, curso: 'x', cuandoMs: CUANDO });
        t.eq(rodecaster.classNumberFromSequenceName(armado), 4, armado);
        t.eq(rodecaster.classNumberFromSequenceName(
            nombre.armar({ clase: 4, curso: 'x', cuandoMs: CUANDO })), 4);
    });
};
