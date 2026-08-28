'use strict';
/**
 * Deshacer y rehacer los cortes.
 *
 * Es de las pocas cosas del visor que se pueden probar enteras sin abrir la app,
 * y de las que más conviene: un deshacer que se equivoca no avisa, deja los
 * cortes en algo que nunca estuvo en pantalla y el editor lo descubre en
 * Premiere.
 */

const path = require('path');
const { pathToFileURL } = require('url');

async function cargar() {
    return import(pathToFileURL(
        path.join(__dirname, '..', 'src', 'js', 'visor', 'estado.js')).href);
}

module.exports = async t => {
    const { rev, editar, deshacer, rehacer, olvidarHistoria, pasos } = await cargar();

    /** Deja el visor con tres bloques y sin historial, como al abrir una clase. */
    function arrancar() {
        olvidarHistoria();
        rev.segments = [0, 1, 2].map(i => ({
            blockIndex: i, sourceStartSec: i * 100, sourceEndSec: i * 100 + 10, keep: true
        }));
        rev.selected = 0;
        rev.dirty = false;
    }

    t.group('visor · deshacer un cambio en los cortes');

    t.test('vuelve el corte a donde estaba', () => {
        arrancar();
        editar('mover la entrada', () => { rev.segments[0].sourceStartSec = 42; });
        t.eq(rev.segments[0].sourceStartSec, 42);
        t.eq(deshacer(), 'mover la entrada', 'y dice qué deshizo');
        t.eq(rev.segments[0].sourceStartSec, 0);
    });

    t.test('deshace de a uno, en orden inverso', () => {
        arrancar();
        editar('uno', () => { rev.segments[0].sourceStartSec = 1; });
        editar('dos', () => { rev.segments[0].sourceStartSec = 2; });
        editar('tres', () => { rev.segments[0].sourceStartSec = 3; });
        t.eq(deshacer(), 'tres');
        t.eq(rev.segments[0].sourceStartSec, 2);
        t.eq(deshacer(), 'dos');
        t.eq(rev.segments[0].sourceStartSec, 1);
    });

    t.test('sin nada hecho no inventa nada', () => {
        arrancar();
        t.eq(deshacer(), null);
        t.eq(rehacer(), null);
    });

    t.test('vuelve también al bloque donde pasó', () => {
        // Deshacer sin volver a lo que se estaba mirando obliga a buscar dónde
        // ocurrió lo que se acaba de revertir, con quince bloques en pantalla.
        arrancar();
        rev.selected = 2;
        editar('sacar el bloque', () => { rev.segments[2].keep = false; });
        rev.selected = 0;
        deshacer();
        t.eq(rev.selected, 2);
        t.eq(rev.segments[2].keep, true);
    });

    t.test('deshacer del todo deja la clase como estaba, sin cambios pendientes', () => {
        // Si `dirty` quedara prendido, el botón de guardar seguiría ofreciendo
        // escribir un XML idéntico al que ya está en el disco.
        arrancar();
        editar('uno', () => { rev.segments[0].sourceStartSec = 1; });
        editar('dos', () => { rev.segments[1].sourceStartSec = 2; });
        t.eq(rev.dirty, true);
        deshacer();
        deshacer();
        t.eq(rev.dirty, false, 'volvió al estado guardado');
    });

    t.group('visor · rehacer');

    t.test('rehace lo último que se deshizo', () => {
        arrancar();
        editar('mover', () => { rev.segments[0].sourceStartSec = 7; });
        deshacer();
        t.eq(rev.segments[0].sourceStartSec, 0);
        t.eq(rehacer(), 'mover');
        t.eq(rev.segments[0].sourceStartSec, 7);
    });

    t.test('editar después de deshacer borra el futuro', () => {
        // Ese futuro dejó de existir: rehacerlo pegaría un cambio hecho sobre un
        // estado que ya no es el que hay.
        arrancar();
        editar('vieja', () => { rev.segments[0].sourceStartSec = 1; });
        deshacer();
        t.eq(pasos().adelante, 1);
        editar('nueva', () => { rev.segments[0].sourceStartSec = 2; });
        t.eq(pasos().adelante, 0);
        t.eq(rehacer(), null);
    });

    t.group('visor · el historial no cruza clases');

    t.test('abrir otra clase lo deja en cero', () => {
        // Las fotos son de los bloques de la clase anterior: deshacer con ellas
        // metería los cortes de una clase adentro de otra.
        arrancar();
        editar('algo', () => { rev.segments[0].sourceStartSec = 5; });
        t.eq(pasos().atras, 1);
        olvidarHistoria();
        t.eq(pasos().atras, 0);
        t.eq(deshacer(), null);
    });

    t.test('el historial tiene tope y tira lo más viejo', () => {
        arrancar();
        for (let i = 0; i < 80; i++) {
            editar(`paso ${i}`, () => { rev.segments[0].sourceStartSec = i; });
        }
        t.eq(pasos().atras, 60, 'no crece sin límite');
        t.eq(deshacer(), 'paso 79', 'y lo último sigue siendo lo último');
    });

    t.test('la copia no comparte los bloques con la foto', () => {
        // Guardando el mismo objeto, editarlo después cambiaría también el
        // pasado y deshacer devolvería el estado actual.
        arrancar();
        editar('mover', () => { rev.segments[0].sourceStartSec = 1; });
        const antes = rev.segments[0];
        deshacer();
        t.eq(antes === rev.segments[0], false, 'el bloque de ahora es otro objeto');
        t.eq(rev.segments[0].sourceStartSec, 0);
    });
};
