'use strict';
/**
 * El diario de la sesión.
 *
 * Lo que se prueba acá es lo que hace que el archivo se pueda mandar sin
 * leerlo antes —que no lleve claves ni el árbol de nadie— y lo que hace que la
 * app no se hinche por tenerlo. El formato de las líneas casi no se prueba: es
 * texto para una persona y puede cambiar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const registro = require('../engine/registro');

module.exports = t => {
    t.group('el registro · el tope');

    t.test('guarda lo último y cuenta lo que tiró', () => {
        registro.limpiar();
        for (let i = 0; i < registro.TOPE + 250; i++) registro.anotar('main', 'prueba', { i });

        const estado = registro.estado();
        t.eq(estado.lineas, registro.TOPE, 'no pasa del tope');
        t.eq(estado.descartadas, 250, 'y dice cuántas se perdieron');

        const todas = registro.todo();
        t.eq(todas[0].datos.i, 250, 'lo que queda es la cola, no la cabeza');
        t.eq(todas[todas.length - 1].datos.i, registro.TOPE + 249);
    });

    t.test('el archivo avisa que se descartaron líneas', () => {
        registro.limpiar();
        for (let i = 0; i < registro.TOPE + 5; i++) registro.anotar('main', 'prueba', { i });
        t.ok(registro.texto({}).includes('se descartaron 5'), 'el encabezado no miente por omisión');
    });

    t.group('el registro · lo que no puede salir');

    t.test('un campo que se llama como un secreto no se escribe', () => {
        registro.limpiar();
        const linea = registro.anotar('main', 'ajustes', {
            apiKey: 'sk-ant-api03-jamas-esto',
            claveDelLlavero: 'otra',
            token: 'abc',
            Authorization: 'Bearer xyz',
            modelo: 'claude-sonnet-5-thinking-high'
        });
        t.eq(linea.datos.apiKey, registro.OCULTO);
        t.eq(linea.datos.claveDelLlavero, registro.OCULTO);
        t.eq(linea.datos.token, registro.OCULTO);
        t.eq(linea.datos.Authorization, registro.OCULTO);
        t.eq(linea.datos.modelo, 'claude-sonnet-5-thinking-high', 'lo que no es secreto queda entero');
    });

    t.test('una clave suelta dentro de un mensaje tampoco', () => {
        // El caso de verdad: la clave no viene en un campo que se llame
        // "apiKey", viene pegada en el texto de un error del proveedor.
        const linea = registro.anotar('main', 'error', {
            mensaje: 'Claude contestó 401 con la clave sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'
        });
        t.ok(!linea.datos.mensaje.includes('sk-ant-api03-AAAA'), 'la clave no está');
        t.ok(linea.datos.mensaje.includes(registro.OCULTO), 'y se ve que había algo');
        t.ok(linea.datos.mensaje.startsWith('Claude contestó 401'), 'el resto del error sirve igual');
    });

    t.test('las rutas van cortas y sin la carpeta del usuario', () => {
        const linea = registro.anotar('main', 'carpeta', {
            carpeta: path.join(os.homedir(), 'Movies', 'CUR', '2026_curso', 'Day_1', 'Clase 03')
        });
        t.ok(!linea.datos.carpeta.includes(os.homedir()), 'no aparece el home real');
        t.ok(linea.datos.carpeta.endsWith('Day_1/Clase 03'), `queda de qué clase se habla: ${linea.datos.carpeta}`);
    });

    t.test('un texto larguísimo se recorta', () => {
        const linea = registro.anotar('main', 'algo', { texto: 'x'.repeat(5000) });
        t.ok(linea.datos.texto.length < 300, 'un transcript entero no es una línea de log');
    });

    t.test('un objeto muy anidado se corta en vez de volcar un artefacto', () => {
        const linea = registro.anotar('main', 'algo', { a: { b: { c: { d: { e: 1 } } } } });
        t.eq(linea.datos.a.b.c, '…');
    });

    t.test('una lista larga se resume', () => {
        const linea = registro.anotar('main', 'algo', { ids: Array.from({ length: 30 }, (_, i) => i) });
        t.eq(linea.datos.ids.length, 11, 'diez y el aviso');
        t.eq(linea.datos.ids[10], '… y 20 más');
    });

    t.group('el registro · escribirlo');

    t.test('se escribe entero y de forma atómica', () => {
        registro.limpiar();
        registro.anotar('main', 'app.arranca', { version: '1.2.3' });
        registro.anotar('ventana', 'paso', { a: 2 });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-registro-'));
        const res = registro.escribir(dir, { version: '1.2.3', electron: '32', plataforma: 'darwin' });
        t.ok(res.ok, res.error);
        t.eq(res.lineas, 2);

        const contenido = fs.readFileSync(res.archivo, 'utf8');
        t.ok(contenido.includes('app.arranca'), 'está lo del motor');
        t.ok(contenido.includes('paso'), 'y lo de la ventana, en el mismo archivo');
        t.ok(contenido.includes('version=1.2.3'));

        // Atómico quiere decir que no quedó ningún temporal a medias al lado.
        const sobrantes = fs.readdirSync(dir).filter(n => n.includes('.tmp-'));
        t.eq(sobrantes.length, 0, 'no quedó ningún temporal');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('escribir donde no se puede contesta en vez de tirar', () => {
        const res = registro.escribir('/no/existe/y/no/se/puede/crear', {});
        t.ok(!res.ok, 'contesta que no');
        t.ok(res.error, 'y por qué');
    });

    t.test('dos descargas seguidas no se pisan', () => {
        const a = registro.nombreDeArchivo(new Date('2026-08-25T15:04:05'));
        const b = registro.nombreDeArchivo(new Date('2026-08-25T15:04:06'));
        t.ok(a !== b, `${a} vs ${b}`);
        t.ok(a.endsWith('.txt'));
    });
};
