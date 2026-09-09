'use strict';
/**
 * Que la plantilla se busque sola en vez de pedirse.
 *
 * Pedirla era un requisito raro de explicar: quien aprieta «Generar .prproj»
 * quiere su curso en Premiere, no elegir un archivo del que nunca oyó hablar. Y
 * la respuesta correcta —«cualquier proyecto tuyo que tenga en la línea de tiempo
 * un video, un audio mono y uno estéreo»— es una condición que nadie tiene por
 * qué llevar en la cabeza, pero que la máquina puede probar. Así que se prueban
 * los proyectos que ya están y se usa el primero que pase.
 *
 * Lo que se fija acá es a QUIÉN se elige, que es donde está la decisión: del más
 * nuevo al más viejo, y los que escribimos nosotros al final. Un proyecto nuestro
 * sirve de molde, pero si un defecto nuestro escribiera un archivo torcido,
 * usarlo de molde lo propagaría a todos los que vengan — y eso ya pasó una vez,
 * con los marcadores saliendo con `ClassID="undefined"`.
 *
 * No hace falta un `.prproj` de verdad porque lo que se prueba es la elección, no
 * si Premiere lo abre; para eso hay que recorrer un proyecto del disco y eso vive
 * en `tools/prproj-molde.js`. Por eso `candidatosDe` y `loEscribimosNosotros`
 * están aparte de `buscarPlantilla`: la mitad barata se puede mirar sola.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ipc = require('../ipc/prproj');
const BINS = require('../engine/prproj-curso').ORDEN_DE_BINS;

/** Un `.prproj` de mentira: gzip con los `<Name>` que la búsqueda mira. */
function proyecto(dir, nombre, bins) {
    const xml = '<PremiereData Version="3">'
        + (bins || []).map(b => `<Name>${b}</Name>`).join('')
        + '</PremiereData>';
    const completo = path.join(dir, nombre);
    fs.mkdirSync(path.dirname(completo), { recursive: true });
    fs.writeFileSync(completo, zlib.gzipSync(Buffer.from(xml, 'utf8')));
    return completo;
}

/** Le cambia la fecha, para poder ordenar sin esperar. */
function fechar(ruta, haceMs) {
    const cuando = new Date(Date.now() - haceMs);
    fs.utimesSync(ruta, cuando, cuando);
}

const DIA = 1000 * 60 * 60 * 24;
const solos = ruta => ruta.split('/').pop();

module.exports = t => {

    t.group('la plantilla · a quién se elige');

    t.test('del más nuevo al más viejo', () => {
        // El más reciente es el que más se parece a lo que el editor usa hoy, y
        // el molde le presta al archivo nuevo la versión de su Premiere.
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
        const dir = path.join(home, 'Documents', 'Proyectos');
        fechar(proyecto(dir, 'anteayer.prproj', ['A']), 2 * DIA);
        fechar(proyecto(dir, 'hoy.prproj', ['A']), 60 * 1000);
        fechar(proyecto(dir, 'el-mes-pasado.prproj', ['A']), 30 * DIA);

        t.deep(ipc.candidatosDe(home).map(solos),
            ['hoy.prproj', 'anteayer.prproj', 'el-mes-pasado.prproj']);
        fs.rmSync(home, { recursive: true, force: true });
    });

    t.test('mira Movies, Documents y Desktop, y no el resto del home', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
        proyecto(path.join(home, 'Movies'), 'a.prproj', []);
        proyecto(path.join(home, 'Documents'), 'b.prproj', []);
        proyecto(path.join(home, 'Desktop'), 'c.prproj', []);
        proyecto(path.join(home, 'Library', 'Caches'), 'no.prproj', []);
        proyecto(home, 'suelto.prproj', []);

        const nombres = ipc.candidatosDe(home).map(solos).sort();
        t.deep(nombres, ['a.prproj', 'b.prproj', 'c.prproj'],
            'barrer el home entero tardaría y traería basura de Library');
        fs.rmSync(home, { recursive: true, force: true });
    });

    t.test('baja por las carpetas de adentro, pero no por node_modules', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
        proyecto(path.join(home, 'Movies', 'Curso', 'Project'), 'hondo.prproj', []);
        proyecto(path.join(home, 'Documents', 'node_modules', 'algo'), 'no.prproj', []);
        t.deep(ipc.candidatosDe(home).map(solos), ['hondo.prproj']);
        fs.rmSync(home, { recursive: true, force: true });
    });

    t.test('sin ningún .prproj no encuentra nada, y no tira', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
        fs.mkdirSync(path.join(home, 'Movies'), { recursive: true });
        t.deep(ipc.candidatosDe(home), []);
        fs.rmSync(home, { recursive: true, force: true });
    });

    t.test('una carpeta que no se puede leer no corta la búsqueda', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
        proyecto(path.join(home, 'Movies'), 'si.prproj', []);
        const cerrada = path.join(home, 'Documents', 'privada');
        fs.mkdirSync(cerrada, { recursive: true });
        fs.chmodSync(cerrada, 0o000);
        try {
            t.deep(ipc.candidatosDe(home).map(solos), ['si.prproj'],
                'un disco externo desmontado o una carpeta sin permiso no puede dejar sin plantilla');
        } finally {
            fs.chmodSync(cerrada, 0o700);
            fs.rmSync(home, { recursive: true, force: true });
        }
    });


    t.group('la plantilla · reconocer lo nuestro');

    t.test('un proyecto con los seis bins del generador es nuestro', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-nuestro-'));
        t.ok(ipc.loEscribimosNosotros(proyecto(dir, 'x.prproj', BINS)));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('y con cinco de los seis, no', () => {
        // Se piden todos y no algunos: un proyecto del editor puede llamarle
        // «01 Material» a un bin sin que lo hayamos escrito nosotros.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-nuestro-'));
        t.eq(ipc.loEscribimosNosotros(proyecto(dir, 'y.prproj', BINS.slice(1))), false);
        t.eq(ipc.loEscribimosNosotros(proyecto(dir, 'z.prproj', ['01 Material'])), false,
            'un bin con el mismo nombre no alcanza');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('los seis salen del motor y no están escritos otra vez acá', () => {
        // Si el generador les cambia el nombre, esto lo sigue solo en vez de
        // dejar de reconocer nada en silencio.
        t.eq(BINS.length, 6);
        t.ok(BINS.includes('01 Material') && BINS.includes('02 Secuencias'));
    });

    t.test('un archivo que no es gzip no es nuestro, y no tira', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-nuestro-'));
        const roto = path.join(dir, 'roto.prproj');
        fs.writeFileSync(roto, 'esto no es gzip');
        t.eq(ipc.loEscribimosNosotros(roto), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });
};
