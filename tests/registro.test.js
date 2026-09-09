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
        t.ok(a.endsWith('.md'), 'markdown, que es lo que se pega en un issue o en un chat');
    });

    t.group('el registro · sobrevivir al cierre');

    // Esto es lo que lo vuelve útil. Antes vivía solo en memoria y se perdía
    // justo en el caso que más importa: si la app se cae, el diario de lo que la
    // hizo caer se cae con ella, y quien la reabre para pedir ayuda descarga un
    // archivo que empieza DESPUÉS del problema.

    function carpeta() {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diario-'));
    }

    t.test('lo anotado queda en disco y se puede volver a leer', () => {
        registro.limpiar();
        const dir = carpeta();
        t.ok(registro.abrirDiario(dir).ok);

        registro.anotar('main', 'app.arranca', { version: '1.0.0' });
        registro.anotar('main', 'corrida.empieza', { clases: 13 });
        registro.volcar();

        const enDisco = registro.leerDelDisco();
        t.eq(enDisco.length, 2);
        t.eq(enDisco[1].evento, 'corrida.empieza');
        t.eq(enDisco[1].datos.clases, 13);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un error se vuelca en el acto, sin esperar al temporizador', () => {
        // El caso: el proceso se está cayendo. El segundo que faltaba para el
        // volcado no llega nunca, y la línea que explica la caída es la única
        // que hacía falta.
        registro.limpiar();
        const dir = carpeta();
        registro.abrirDiario(dir);

        registro.anotar('main', 'corrida.empieza', { clases: 1 });
        t.eq(registro.leerDelDisco().length, 0, 'lo normal espera y se junta');

        registro.anotar('main', 'error.no-atrapado', { mensaje: 'se rompió' });
        const enDisco = registro.leerDelDisco();
        t.eq(enDisco.length, 2, 'y el error arrastra lo pendiente con él');
        t.eq(enDisco[1].evento, 'error.no-atrapado');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('la descarga junta las corridas de antes, no solo la de ahora', () => {
        // «Descargar el log de todas las ejecuciones» quiere decir esto: que la
        // corrida de ayer siga estando cuando el problema aparece hoy.
        registro.limpiar();
        const dir = carpeta();
        registro.abrirDiario(dir);
        registro.anotar('main', 'app.arranca', { version: '1.0.0' });
        registro.anotar('main', 'corrida.termina', { clases: 3 });
        registro.volcar();

        // Otra sesión: memoria nueva, mismo disco.
        registro.limpiar();
        registro.abrirDiario(dir);
        registro.anotar('main', 'app.arranca', { version: '1.0.0' });
        registro.anotar('main', 'corrida.empieza', { clases: 5 });

        const bajada = carpeta();
        const res = registro.escribir(bajada, { version: '1.0.0' });
        t.ok(res.ok, res.error);
        t.eq(res.lineas, 4, 'las dos de antes y las dos de ahora');

        const md = fs.readFileSync(res.archivo, 'utf8');
        t.ok(md.includes('corrida.termina'), 'sigue estando lo de la sesión anterior');
        t.ok(md.includes('corrida.empieza'), 'y lo de esta');
        t.ok(md.includes('| Corridas | 2 |'), 'y dice cuántas veces se abrió la app');

        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(bajada, { recursive: true, force: true });
    });

    t.test('el disco tiene su propio tope, más alto que el de memoria', () => {
        // En memoria el tope existe porque el array compite con el modelo. En
        // disco no compite con nada, y perder la corrida de ayer sí duele.
        t.ok(registro.TOPE_EN_DISCO > registro.TOPE);

        registro.limpiar();
        const dir = carpeta();
        registro.abrirDiario(dir);
        for (let i = 0; i < registro.TOPE + 100; i++) registro.anotar('main', 'prueba', { i });
        registro.volcar();

        t.eq(registro.estado().lineas, registro.TOPE, 'la memoria se recortó');
        t.eq(registro.leerDelDisco().length, registro.TOPE + 100, 'el disco las tiene todas');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('una línea cortada por la mitad no se lleva puesto el resto', () => {
        // Pasa de verdad: un cierre justo en medio de un append. Perder una línea
        // es aceptable; perder las otras veinte mil por una línea rota, no.
        registro.limpiar();
        const dir = carpeta();
        registro.abrirDiario(dir);
        registro.anotar('main', 'antes', {});
        registro.volcar();
        fs.appendFileSync(path.join(dir, 'diario.ndjson'), '{"ts":1,"evento":"cor\n');
        registro.anotar('main', 'despues', {});
        registro.volcar();

        const enDisco = registro.leerDelDisco();
        t.eq(enDisco.length, 2, 'la rota se saltea y las sanas quedan');
        t.deep(enDisco.map(l => l.evento), ['antes', 'despues']);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('sin carpeta donde guardar, se sigue anotando en memoria', () => {
        // Que no se pueda escribir la historia no puede impedir que la app abra.
        registro.limpiar();
        const res = registro.abrirDiario('/no/se/puede/crear/esto');
        t.ok(!res.ok, 'avisa que no pudo');
        registro.anotar('main', 'algo', {});
        t.eq(registro.estado().lineas, 1, 'y la app sigue andando igual');
    });

    t.group('el registro · el .md');

    t.test('los problemas van arriba, antes del relato', () => {
        // Quien abre esto busca por qué algo no anduvo. Con el relato primero,
        // diagnosticar empieza por leer dos mil líneas para encontrar la que
        // importa.
        registro.limpiar();
        registro.anotar('main', 'app.arranca', {});
        for (let i = 0; i < 20; i++) registro.anotar('main', 'corrida.etapa', { i });
        registro.anotar('main', 'corrida.se-cayo', { mensaje: 'whisper no contestó' });

        const md = registro.texto({ version: '1.0.0' });
        t.ok(md.indexOf('## Lo que salió mal') < md.indexOf('## Qué pasó'));
        t.ok(md.includes('## Lo que salió mal (1)'), 'y dice cuántos son');
        t.ok(md.indexOf('whisper no contestó') < md.indexOf('## Qué pasó'),
            'el error está arriba, no solo enterrado en el relato');
    });

    t.test('una línea con error adentro también cuenta como problema', () => {
        // No alcanza con mirar el nombre del evento: media app contesta
        // `{ok: false, error}` sin ponerle "falla" al nombre.
        registro.limpiar();
        registro.anotar('main', 'visor.guarda', { ok: false, error: 'no se pudo escribir' });
        t.ok(registro.texto({}).includes('## Lo que salió mal (1)'));
    });

    t.test('sin problemas lo dice, en vez de dejar la sección vacía', () => {
        registro.limpiar();
        registro.anotar('main', 'app.arranca', {});
        const md = registro.texto({});
        t.ok(md.includes('## Lo que salió mal (0)'));
        t.ok(/Ninguna línea quedó marcada como error/.test(md));
    });

    t.test('el relato va en un bloque de código, para que markdown no lo coma', () => {
        registro.limpiar();
        registro.anotar('main', 'algo', { ruta: '…/Day_1/Clase 03' });
        const md = registro.texto({});
        const relato = md.slice(md.indexOf('## Qué pasó'));
        t.ok(relato.includes('```'), 'abre y cierra el bloque');
    });
};
