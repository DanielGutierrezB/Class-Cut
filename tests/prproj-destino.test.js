'use strict';
/**
 * Dónde cae el proyecto de Premiere, y qué pasa cuando ya hay uno.
 *
 * Las dos preguntas van juntas porque la segunda la creó la primera: mientras el
 * nombre lo elegía el motor podía ser distinto cada vez, pero atarlo al de la
 * carpeta —que es lo que se pidió, y con razón, porque es como el editor llama al
 * curso en el Finder— garantiza que el segundo apretón del botón apunte al mismo
 * archivo que el primero.
 *
 * Y ese archivo no es un resultado, es un lugar de trabajo: el editor lo abre en
 * Premiere y edita adentro. Para cuando alguien vuelva a generar puede haber una
 * tarde de edición ahí. Por eso `alLado` existe, y por eso esta prueba fija que
 * NO pise: un generador que reemplaza en silencio es el defecto caro de este
 * archivo, y es de los que solo se descubren cuando ya se perdió algo.
 *
 * Lo que esta prueba NO puede mirar es el diálogo que pregunta, que vive en el
 * manejador y necesita una ventana. Lo que sí se puede fijar, y es donde está el
 * riesgo, son las dos funciones que deciden las rutas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const prproj = require('../ipc/prproj');

module.exports = t => {
    t.test('el proyecto se llama como la carpeta del curso', () => {
        t.eq(prproj.destinoDe('/Users/x/CUR/2026_curso-spec-driven-development'),
            '/Users/x/CUR/2026_curso-spec-driven-development/Proyecto/2026_curso-spec-driven-development.prproj',
            'el nombre del curso es el de su carpeta y no uno inventado por nosotros');
    });

    t.test('y va en su propia carpeta, no suelto en la del curso', () => {
        const destino = prproj.destinoDe('/Users/x/CUR/taller');
        t.eq(path.basename(path.dirname(destino)), 'Proyecto',
            'Premiere deja auto-guardados y previsualizaciones al lado del proyecto');
        t.eq(path.dirname(path.dirname(destino)), '/Users/x/CUR/taller',
            'y esa carpeta cuelga de la del curso');
    });

    t.test('una carpeta con espacios o puntos no rompe el nombre', () => {
        t.eq(path.basename(prproj.destinoDe('/Users/x/Curso de Lu 2.0')),
            'Curso de Lu 2.0.prproj',
            'el nombre se copia tal cual: el editor lo va a buscar por como se llama la carpeta');
    });

    t.test('una barra al final no deja el nombre vacío', () => {
        // `path.basename` de una ruta terminada en barra ya la ignora, pero esto
        // llega de la ventana y de un `data-` de HTML, y por ahí pasan las dos
        // formas. Un nombre vacío daría `/Proyecto/.prproj`, que es un archivo
        // oculto y sin nombre.
        t.eq(path.basename(prproj.destinoDe('/Users/x/CUR/taller/')), 'taller.prproj');
    });

    t.test('con el nombre ocupado, el de al lado es el 2 y no pisa al 1', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const uno = path.join(dir, 'Curso.prproj');
        fs.writeFileSync(uno, 'el trabajo de una tarde');

        const otro = prproj.alLado(uno);
        t.eq(path.basename(otro), 'Curso 2.prproj', 'se cuenta, como hace el Finder');
        t.eq(fs.readFileSync(uno, 'utf8'), 'el trabajo de una tarde',
            'y el que ya estaba sigue entero');
    });

    t.test('y sigue contando mientras encuentre ocupado', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const uno = path.join(dir, 'Curso.prproj');
        for (const n of ['Curso.prproj', 'Curso 2.prproj', 'Curso 3.prproj']) {
            fs.writeFileSync(path.join(dir, n), '');
        }
        t.eq(path.basename(prproj.alLado(uno)), 'Curso 4.prproj');
    });

    t.test('el de al lado queda en la misma carpeta que el ocupado', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const uno = path.join(dir, 'Proyecto', 'Curso.prproj');
        fs.mkdirSync(path.dirname(uno), { recursive: true });
        fs.writeFileSync(uno, '');
        t.eq(path.dirname(prproj.alLado(uno)), path.dirname(uno));
    });
};
