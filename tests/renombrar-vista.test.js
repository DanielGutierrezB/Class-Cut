'use strict';
/**
 * Lo que la lista PROMETE antes de renombrar, contra lo que el motor hace después.
 *
 * `src/js/grabar/gestionar.js` calcula en qué parte va a quedar una clase si se le
 * cambia el número, y lo muestra mientras alguien escribe: "queda como parte 2".
 * Eso es la misma regla que `engine/clases-grabadas.js` aplica cuando escribe, o
 * sea la misma regla escrita dos veces, y la de la pantalla es la peligrosa: es la
 * que puede mentir sin que nada falle. Un cartel que dice "parte 2" y un archivo
 * que sale `p3_` no rompen nada — dejan al editor con dos clases que creía que
 * eran la misma.
 *
 * Así que acá corren las dos contra la misma carpeta y se comparan: la pantalla
 * dice su número, el motor renombra de verdad, y del nombre que quedó en el disco
 * se relee la parte. Si alguien toca una de las dos, esto falla, que es lo único
 * que hace sostenible tenerlas separadas.
 *
 * También está acá el cartel de borrar, por lo mismo: nombra archivos, y lo que
 * nombra tiene que ser lo que se va.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const clases = require('../engine/clases-grabadas');
const nombreDeClase = require('../engine/nombre-de-clase');
const notasXml = require('../engine/notas-xml');
const workspace = require('../engine/workspace');

/** El 3 de marzo a las 9, y cada clase un rato después: horas fijas, capturas repetibles. */
const CERO = new Date('2026-03-03T09:00:00').getTime();

/**
 * Deja una clase en la carpeta de notas, con su XML y su sidecar de verdad.
 *
 * Sin grabarla: lo que se prueba acá es la regla de los nombres y las partes, que
 * no toca el audio. Los archivos igual los escriben `notasXml` y `workspace`, o
 * sea los mismos de la app, porque `renombrar` los va a volver a leer.
 */
function poner(dir, { clase, parte = 1, curso = 'fisica', minuto = 0, sesiones }) {
    const cuandoMs = CERO + minuto * 60000;
    const secuencia = nombreDeClase.armar({ clase, parte, curso, cuandoMs });
    const estado = {
        secuencia, clase, parte, curso,
        ceroMs: cuandoMs,
        tomas: [{ id: 1, vista: 'PV', inMs: 0, outMs: 4000, palabras: [], comentarios: [] }],
        sesiones: sesiones || [{ archivo: path.join(dir, `${secuencia}.wav`) }]
    };
    const donde = workspace.notasArchivos(dir, workspace.safeName(secuencia));
    workspace.ensureDir(path.dirname(donde.xml));
    workspace.ensureDir(path.dirname(donde.json));
    workspace.writeAtomic(donde.xml, notasXml.xmlDeNotas(estado));
    workspace.writeJson(donde.json, notasXml.sidecar(estado));
    for (const s of estado.sesiones) fs.writeFileSync(s.archivo, 'RIFF');
    return donde.json;
}

/** La parte que dice el nombre que quedó en el disco. */
function parteEnElDisco(secuencia) {
    return (nombreDeClase.leer(secuencia) || {}).parte;
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const gestionar = await import(src('grabar/gestionar.js'));

    const dirs = [];
    const carpeta = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-renombrar-'));
        dirs.push(d);
        return d;
    };

    t.group('renombrar · la parte que la pantalla promete es la que sale');

    t.test('un número libre no la convierte en parte de nada', () => {
        const dir = carpeta();
        poner(dir, { clase: 1 });
        const json = poner(dir, { clase: 2, minuto: 30 });

        const lista = clases.listar([dir]);
        const mia = lista.find(c => Number(c.clase) === 2);
        const promesa = gestionar.parteQueQueda(mia, lista, 7);

        const r = clases.renombrar(json, { clase: 7 });
        t.eq(promesa, 1);
        t.eq(parteEnElDisco(r.secuencia), promesa);
    });

    t.test('un número ya usado la deja como la parte siguiente, y la pantalla lo dijo antes', () => {
        // El caso por el que existe el cartel: se renombra justamente para juntar
        // esta clase con una que ya está, así que "queda como parte 2" es la
        // respuesta que el editor está buscando.
        const dir = carpeta();
        poner(dir, { clase: 4 });
        const json = poner(dir, { clase: 9, minuto: 45 });

        const lista = clases.listar([dir]);
        const mia = lista.find(c => Number(c.clase) === 9);
        const promesa = gestionar.parteQueQueda(mia, lista, 4);

        const r = clases.renombrar(json, { clase: 4 });
        t.eq(promesa, 2);
        t.eq(parteEnElDisco(r.secuencia), promesa);
    });

    t.test('con dos partes ya puestas, la que entra es la tercera', () => {
        const dir = carpeta();
        poner(dir, { clase: 4 });
        poner(dir, { clase: 4, parte: 2, minuto: 20 });
        const json = poner(dir, { clase: 9, minuto: 45 });

        const lista = clases.listar([dir]);
        const mia = lista.find(c => Number(c.clase) === 9);
        const promesa = gestionar.parteQueQueda(mia, lista, 4);

        const r = clases.renombrar(json, { clase: 4 });
        t.eq(promesa, 3);
        t.eq(parteEnElDisco(r.secuencia), promesa);
    });

    t.test('cambiar solo el curso no le mueve la parte', () => {
        // La trampa de contarse a sí misma: si la pantalla cuenta la clase que se
        // está renombrando entre "las que ya usan ese número", una parte 1 pasa a
        // decir "parte 2" por cambiarle una tilde al curso.
        const dir = carpeta();
        const json = poner(dir, { clase: 5, curso: 'fisica' });

        const lista = clases.listar([dir]);
        const mia = lista[0];
        const promesa = gestionar.parteQueQueda(mia, lista, 5);

        const r = clases.renombrar(json, { curso: 'física' });
        t.eq(promesa, 1);
        t.eq(parteEnElDisco(r.secuencia), promesa);
    });

    t.test('y a una parte 2 que se queda en su número le deja su parte', () => {
        const dir = carpeta();
        poner(dir, { clase: 6 });
        const json = poner(dir, { clase: 6, parte: 2, minuto: 25 });

        const lista = clases.listar([dir]);
        const mia = lista.find(c => Number(c.parte) === 2);
        const promesa = gestionar.parteQueQueda(mia, lista, 6);

        const r = clases.renombrar(json, { curso: 'otro-curso' });
        t.eq(promesa, 2);
        t.eq(parteEnElDisco(r.secuencia), promesa);
    });

    t.group('renombrar · la hora de captura, que es lo que no se toca');

    t.test('se muestra la hora que la clase guardó, y sin aviso', () => {
        const aviso = gestionar.horaDeCaptura({ ceroMs: CERO });
        t.eq(aviso.hora, '09:00:00');
        t.eq(aviso.aviso, null);
    });

    t.test('renombrar deja la hora donde estaba: el nombre nuevo dice la misma', () => {
        // Es la razón entera de que ese campo no se edite: el Rodecaster escribe su
        // propia hora en el nombre de SU carpeta, y post empareja las dos.
        const dir = carpeta();
        const json = poner(dir, { clase: 8, minuto: 17 });
        const antes = nombreDeClase.leer(path.basename(json, clases.SUFIJO_SIDECAR)).cuandoMs;

        const r = clases.renombrar(json, { clase: 11, curso: 'quimica' });
        t.eq(nombreDeClase.leer(r.secuencia).cuandoMs, antes);
    });

    t.test('sin hora guardada avisa, pero no prohíbe', () => {
        // Prohibir acá le negaría el renombrado justo a las clases más viejas, que
        // son las que más lo necesitan. El motor todavía puede sacarla del nombre.
        const r = gestionar.horaDeCaptura({ clase: 3 });
        t.eq(r.hora, null);
        t.ok(/no guardó su hora/.test(r.aviso), 'el aviso dice que falta la hora');
        t.ok(/carpeta del Rodecaster/.test(r.aviso), 'y dice para qué servía');
    });

    t.group('borrar · el cartel nombra lo que se va');

    t.test('dice los tres archivos y cuenta los audios', () => {
        const clase = {
            clase: 4, parte: 1, curso: 'fisica', carpeta: '/cursos/fisica',
            secuencia: '04_fisica_2026-03-03_09-00-00',
            archivos: { xml: '/cursos/fisica/notas/04_fisica_2026-03-03_09-00-00.xml', json: '/x/y.cc.json' },
            sesiones: [{ archivo: '/a/uno.wav' }, { archivo: '/a/dos.wav' }]
        };
        const cartel = gestionar.queSeBorra(clase);
        t.ok(/Clase 4/.test(cartel.titulo), 'el título nombra la clase');
        t.ok(/fisica/.test(cartel.titulo), 'y el curso');
        t.ok(/XML/.test(cartel.mensaje), 'nombra el XML');
        t.ok(/archivo de datos/.test(cartel.mensaje), 'nombra el sidecar');
        t.ok(/2 archivos de audio/.test(cartel.mensaje), 'y cuenta los dos audios');
        t.ok(/no van a la papelera/.test(cartel.mensaje), 'avisa que no van a la papelera');
        t.ok(/no se puede deshacer/.test(cartel.mensaje), 'y que no hay Cmd-Z');
        t.ok(/\/cursos\/fisica/.test(cartel.mensaje), 'y dice dónde están');
    });

    t.test('el mismo audio en dos sesiones se cuenta una vez', () => {
        const cartel = gestionar.queSeBorra({
            clase: 2, carpeta: '/c', secuencia: 'x', archivos: { xml: '/c/x.xml' },
            sesiones: [{ archivo: '/a/uno.wav' }, { archivo: '/a/uno.wav' }]
        });
        t.ok(/1 archivo de audio/.test(cartel.mensaje), `contó de más: ${cartel.mensaje}`);
    });

    t.test('una clase sin audio anotado lo dice, en vez de callarse', () => {
        // Se llega a borrar una clase justamente cuando quedó mal, y "ningún audio"
        // es información: dice que el WAV se perdió antes, no que esto no borra.
        const cartel = gestionar.queSeBorra({
            clase: 2, carpeta: '/c', secuencia: 'x', archivos: { xml: '/c/x.xml' }, sesiones: []
        });
        t.ok(/ningún audio/.test(cartel.mensaje), `no dijo nada del audio: ${cartel.mensaje}`);
    });

    t.group('el número que se escribe en el campo');

    t.test('lo que no es número se limpia, y vacío es 1', () => {
        t.eq(gestionar.numeroLeido('7'), 7);
        t.eq(gestionar.numeroLeido('  12 '), 12);
        t.eq(gestionar.numeroLeido('clase 3'), 3);
        t.eq(gestionar.numeroLeido(''), 1);
        t.eq(gestionar.numeroLeido(null), 1);
    });

    t.test('el número se escribe a dos dígitos, como en la carpeta del Rodecaster', () => {
        t.eq(gestionar.dosDigitos(3), '03');
        t.eq(gestionar.dosDigitos(12), '12');
        t.eq(gestionar.dosDigitos(0), '01');
        t.eq(gestionar.dosDigitos(4000), '999');
    });

    t.group('cómo se lee una clase en la lista');

    t.test('la parte 1 no se escribe, y la 2 sí', () => {
        t.eq(gestionar.comoSeLlama({ clase: 3, parte: 1 }), 'Clase 3');
        t.eq(gestionar.comoSeLlama({ clase: 3, parte: 2 }), 'Clase 3 · parte 2');
    });

    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
