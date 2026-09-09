'use strict';
/**
 * Las últimas carpetas del paso "Carpetas": lo que queda ESCRITO, no lo que se ve.
 *
 * Esto está acá y no en el arnés de gestos por una razón concreta y con nombre:
 * hubo un defecto en el que quitar una carpeta de una lista la sacaba de la
 * pantalla y la traía de vuelta en el repintado siguiente, porque el guardado
 * escribía sobre una copia que se tiraba. Una prueba que mire la pantalla lo
 * aprueba —la carpeta se fue— y el archivo dice otra cosa. Así que acá se
 * escribe el JSON de verdad, en una casa de mentira, y después se lo relee del
 * disco: la pregunta no es qué contestó `guardar`, es qué quedó en el archivo.
 *
 * Lo de la pantalla (que la fila aparezca, que el clic diga algo, que quitar no
 * revuelva) se prueba con gestos en `tools/probar-recientes.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ajustes = require('../engine/ajustes');

/**
 * Corre algo con el home apuntando a una carpeta temporal.
 *
 * `engine/ajustes.js` arma la ruta del JSON en cada llamada, así que alcanza con
 * cambiarle el `homedir` mientras dura la prueba. Sin esto, probar `guardar`
 * sería pisar los ajustes de verdad de quien corre las pruebas — el proveedor de
 * IA que tenga elegido, su carpeta de notas —, que es un precio que ninguna
 * prueba puede cobrar.
 */
function enUnaCasaDePrueba(fn) {
    const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recientes-'));
    const suyo = os.homedir;
    os.homedir = () => casa;
    try {
        return fn(casa);
    } finally {
        os.homedir = suyo;
        fs.rmSync(casa, { recursive: true, force: true });
    }
}

/** Lo que dice el ARCHIVO, sin pasar por `leer`. */
function delDisco() {
    return JSON.parse(fs.readFileSync(ajustes.archivo(), 'utf8'));
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const formato = await import(src('formato.js'));

    t.group('las últimas carpetas · lo que se sanea');

    t.test('un archivo sin la clave abre con la lista vacía', () => {
        t.deep(ajustes.sanear({}).carpetasRecientes, []);
        t.deep(ajustes.sanear(null).carpetasRecientes, []);
        // Y lo que no sea una lista tampoco tumba nada: el JSON se puede editar
        // a mano y un ajuste ilegible no puede dejar sin abrir carpetas.
        t.deep(ajustes.sanear({ carpetasRecientes: '/Cursos/uno' }).carpetasRecientes, []);
    });

    t.test('no entran las repetidas ni lo que no sea una ruta', () => {
        const r = ajustes.sanear({
            carpetasRecientes: ['/a', '/b', '/a', '', null, 7, { root: '/c' }, '/b']
        }).carpetasRecientes;
        t.deep(r, ['/a', '/b']);
    });

    t.test('el tope lo pone el saneado, así que nadie lo puede pasar por arriba', () => {
        const nueve = Array.from({ length: 9 }, (_, i) => `/Cursos/c${i}`);
        const r = ajustes.sanear({ carpetasRecientes: nueve }).carpetasRecientes;
        t.eq(r.length, ajustes.RECIENTES);
        // Se corta por el final: la lista viene con la última usada primero, o
        // sea que lo que sobra es lo más viejo.
        t.deep(r, nueve.slice(0, ajustes.RECIENTES));
    });

    t.group('las últimas carpetas · lo que queda escrito');

    t.test('abrir una carpeta la deja en el JSON del disco', () => {
        enUnaCasaDePrueba(() => {
            ajustes.recordarCarpeta('/Cursos/2609_curso');
            t.deep(delDisco().carpetasRecientes, ['/Cursos/2609_curso']);
        });
    });

    t.test('la última abierta va primera', () => {
        enUnaCasaDePrueba(() => {
            ajustes.recordarCarpeta('/Cursos/uno');
            ajustes.recordarCarpeta('/Cursos/dos');
            t.deep(delDisco().carpetasRecientes, ['/Cursos/dos', '/Cursos/uno']);
        });
    });

    t.test('volver a abrir una que ya estaba la sube, no la duplica', () => {
        enUnaCasaDePrueba(() => {
            for (const d of ['/a', '/b', '/c']) ajustes.recordarCarpeta(d);
            ajustes.recordarCarpeta('/c');
            t.deep(delDisco().carpetasRecientes, ['/c', '/b', '/a']);
            ajustes.recordarCarpeta('/a');
            t.deep(delDisco().carpetasRecientes, ['/a', '/c', '/b']);
        });
    });

    t.test('pasado el tope se cae la que hace más que nadie abre', () => {
        enUnaCasaDePrueba(() => {
            const tope = ajustes.RECIENTES;
            for (let i = 0; i < tope; i++) ajustes.recordarCarpeta(`/Cursos/c${i}`);
            // La primera que se abrió es la que hace más que no se usa…
            t.ok(delDisco().carpetasRecientes.includes('/Cursos/c0'), 'todavía está');
            // …salvo que se la vuelva a abrir, que es lo que la salva.
            ajustes.recordarCarpeta('/Cursos/c0');
            ajustes.recordarCarpeta('/Cursos/nueva');
            const quedaron = delDisco().carpetasRecientes;
            t.eq(quedaron.length, tope);
            t.eq(quedaron[0], '/Cursos/nueva');
            t.ok(quedaron.includes('/Cursos/c0'), 'la que se volvió a abrir se queda');
            t.ok(!quedaron.includes('/Cursos/c1'), 'la que se cae es la más vieja de uso');
        });
    });

    t.test('recordar una carpeta no toca lo demás de los ajustes', () => {
        enUnaCasaDePrueba(() => {
            ajustes.guardar({
                notasDir: '/Notas/curso',
                notasDirs: ['/Notas/curso', '/Notas/taller'],
                ia: { proveedor: 'cursor', cursor: { modelo: 'un-modelo' } }
            });
            ajustes.recordarCarpeta('/Cursos/material');
            const quedo = delDisco();
            t.deep(quedo.notasDirs, ['/Notas/curso', '/Notas/taller']);
            t.eq(quedo.ia.proveedor, 'cursor');
            t.eq(quedo.ia.cursor.modelo, 'un-modelo');
            t.deep(quedo.carpetasRecientes, ['/Cursos/material']);
        });
    });

    t.test('una carpeta que ya no está en el disco NO se cae sola de la lista', () => {
        enUnaCasaDePrueba(() => {
            // Un disco externo desenchufado es el estado normal de la mitad del
            // material de video. Si leer los ajustes filtrara lo que no existe,
            // desenchufar un disco borraría el curso de la lista y enchufarlo lo
            // traería de vuelta: la lista dejaría de ser algo en lo que confiar.
            ajustes.recordarCarpeta('/Volumes/Un disco que no está/Cursos/2508');
            t.deep(ajustes.leer().carpetasRecientes, ['/Volumes/Un disco que no está/Cursos/2508']);
        });
    });

    t.test('quitar una la saca del ARCHIVO, y no vuelve al releer', () => {
        enUnaCasaDePrueba(() => {
            for (const d of ['/a', '/b', '/c']) ajustes.recordarCarpeta(d);
            // El mismo camino que hace la pantalla: un parche sobre lo que hay,
            // como `ajustes-guardar` en `main.js`.
            const antes = ajustes.leer();
            ajustes.guardar({
                ...antes,
                carpetasRecientes: antes.carpetasRecientes.filter(d => d !== '/b')
            });
            t.deep(delDisco().carpetasRecientes, ['/c', '/a'], 'en el archivo');
            t.deep(ajustes.leer().carpetasRecientes, ['/c', '/a'], 'y al releerlo');
        });
    });

    t.group('las últimas carpetas · la ruta que se lee de un vistazo');

    t.test('se pliega por el medio, que es donde no dice nada', () => {
        t.eq(
            formato.rutaPlegada('/Volumes/Rushes 2026/Clientes/Fundación Norte/Cursos'),
            '/Volumes/Rushes 2026/…/Cursos'
        );
    });

    t.test('lo que se conserva es de qué disco es y en qué nido está', () => {
        const r = formato.rutaPlegada('/Volumes/Externo/a/b/c/d/Cursos');
        t.ok(r.startsWith('/Volumes/Externo/'), 'la cabeza dice el disco');
        t.ok(r.endsWith('/Cursos'), 'la cola dice el nido');
    });

    t.test('plegada mide menos que entera: si no, no sirvió de nada', () => {
        const entera = '/Volumes/Rushes 2026/Clientes/Fundación Norte/Cursos';
        t.ok(formato.rutaPlegada(entera).length < entera.length, 'quedó más corta');
    });

    t.test('la que ya entra no se toca: plegar de menos no ayuda a nadie', () => {
        t.eq(formato.rutaPlegada('/Cursos'), '/Cursos');
        t.eq(formato.rutaPlegada('/a/b/c'), '/a/b/c');
    });

    t.test('no inventa una barra donde no había', () => {
        t.eq(formato.rutaPlegada(''), '');
        t.eq(formato.rutaPlegada(null), '');
        t.eq(formato.rutaPlegada('Cursos/a/b/c/d'), 'Cursos/a/…/d');
    });
};
