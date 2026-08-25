'use strict';
/**
 * Que se puedan tener varias carpetas cargadas sin que se pisen.
 *
 * Lo que se prueba acá es la regla de contención: es la que evita que el mismo
 * material aparezca dos veces en la tabla —con dos raíces distintas y dos "The
 * Cutter"— cuando el editor agrega el día y después el curso entero.
 */

const carpetas = require('../engine/carpetas');

module.exports = function (t) {
    t.group('carpetas · quién contiene a quién');

    t.test('una carpeta está dentro de la que la contiene, y de sí misma', () => {
        t.eq(carpetas.dentroDe('/cursos/spec/Day_1', '/cursos/spec'), true);
        t.eq(carpetas.dentroDe('/cursos/spec', '/cursos/spec'), true, 'la misma cuenta');
        t.eq(carpetas.dentroDe('/cursos/spec', '/cursos/spec/Day_1'), false, 'al revés no');
    });

    t.test('un prefijo de texto no es una carpeta padre', () => {
        // El error clásico de resolver esto con startsWith: estas dos carpetas
        // comparten las primeras letras y no tienen nada que ver.
        t.eq(carpetas.dentroDe('/cursos/spec-viejo', '/cursos/spec'), false);
    });

    t.test('la barra final y los tramos raros no cambian la respuesta', () => {
        t.eq(carpetas.dentroDe('/cursos/spec/Day_1/', '/cursos/spec/'), true);
        t.eq(carpetas.dentroDe('/cursos/spec/./Day_1', '/cursos/spec'), true);
    });

    t.group('carpetas · qué hacer al agregar una');

    t.test('la primera, y una que no se toca con nada, se suman', () => {
        t.eq(carpetas.fusionar([], '/cursos/spec').accion, 'agregar');
        const otra = carpetas.fusionar(['/cursos/spec'], '/cursos/otro');
        t.eq(otra.accion, 'agregar');
        t.deep(otra.reemplaza, [], 'no saca ninguna');
    });

    t.test('la misma otra vez se refresca en su lugar', () => {
        const res = carpetas.fusionar(['/cursos/spec'], '/cursos/spec/');
        t.eq(res.accion, 'refrescar');
        t.deep(res.reemplaza, ['/cursos/spec'], 'para no quedar cargada dos veces');
    });

    t.test('el curso entero reemplaza a los días que ya estaban', () => {
        // Es el caso real: se procesó Day_1, después se arrastra el curso. Las
        // clases de Day_1 están en las dos, y duplicadas no sirven a nadie.
        const res = carpetas.fusionar(
            ['/cursos/spec/Day_1', '/cursos/spec/Day_2', '/cursos/otro'],
            '/cursos/spec');
        t.eq(res.accion, 'agregar');
        t.deep(res.reemplaza.sort(), ['/cursos/spec/Day_1', '/cursos/spec/Day_2']);
    });

    t.test('un día que ya está dentro de un curso cargado no se agrega', () => {
        const res = carpetas.fusionar(['/cursos/spec'], '/cursos/spec/Day_1');
        t.eq(res.accion, 'cubierta');
        t.eq(res.cubiertaPor, '/cursos/spec');
        t.deep(res.reemplaza, [], 'y el curso no se toca');
    });

    t.test('estar cubierta se mira antes que contener', () => {
        // Una clase suelta de un curso cargado está dentro de él Y no contiene
        // nada: la respuesta útil es "ya la tenés", no reemplazar el curso por
        // una sola de sus clases.
        const res = carpetas.fusionar(['/cursos/spec'], '/cursos/spec/Day_1/Clase 01');
        t.eq(res.accion, 'cubierta');
    });
};
