'use strict';
/**
 * El motor de mutación de proyectos de Premiere.
 *
 * **Todo esto corre contra un proyecto de juguete y no contra un `.prproj` de
 * verdad, y es a propósito.** El motor no sabe qué es una secuencia ni un clip:
 * sabe de objetos raíz, referencias entre ellos y listas con índice denso. Si
 * hace falta medio mega de proyecto de Premiere para probarlo, el motor está
 * mirando cosas que no le tocan y la separación con `prproj-secuencia.js` no
 * sirvió de nada. Cuatro objetos inventados alcanzan, y la prueba dice en dos
 * líneas qué se espera en vez de esconderlo en un archivo binario.
 *
 * Lo que sí necesita un `.prproj` real —que los moldes se reconozcan, que
 * Premiere abra lo que sale— vive en `tools/prproj-molde.js`, que es una
 * herramienta y no una prueba porque depende de un archivo del disco del editor.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const prproj = require('../engine/prproj');

/**
 * Un proyecto de juguete: cuatro objetos, las dos formas de clave y las dos
 * formas de referencia.
 *
 *     S (UID)  →  A (ID)  →  B (ID)  →  M (UID)
 *                    └──────────────────→ M
 *
 * `M` está apuntado por dos lados, que es lo que hace falta para ver si el
 * clonado lo copia dos veces o lo reusa una.
 */
function juguete(extra) {
    return [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<PremiereData Version="3">',
        '\t<Sobre ObjectUID="11111111-1111-4111-8111-111111111111" ClassID="c1" Version="1">',
        '\t\t<Name>el sobre</Name>',
        '\t\t<Adentro ObjectRef="1"/>',
        '\t</Sobre>',
        '\t<Cosa ObjectID="1" ClassID="c2" Version="1">',
        '\t\t<Name>la de arriba</Name>',
        '\t\t<ID>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</ID>',
        '\t\t<DefMappingID>dddddddd-dddd-4ddd-8ddd-dddddddddddd</DefMappingID>',
        '\t\t<Hija ObjectRef="2"/>',
        '\t\t<Medio ObjectURef="99999999-9999-4999-8999-999999999999"/>',
        '\t\t<Lista Version="1">',
        '\t\t\t<Item Index="0" ObjectRef="2"/>',
        '\t\t</Lista>',
        '\t</Cosa>',
        '\t<Cosa ObjectID="2" ClassID="c2" Version="1">',
        '\t\t<Name>la de abajo</Name>',
        '\t\t<ClipID>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb</ClipID>',
        '\t\t<Medio ObjectURef="99999999-9999-4999-8999-999999999999"/>',
        '\t</Cosa>',
        '\t<Medio ObjectUID="99999999-9999-4999-8999-999999999999" ClassID="c3" Version="1">',
        '\t\t<Name>el material</Name>',
        '\t\t<FilePath>/tmp/nada.mp4</FilePath>',
        '\t</Medio>',
        ...(extra || []),
        '</PremiereData>'
    ].join('\n');
}

const S = prproj.clave('UID', '11111111-1111-4111-8111-111111111111');
const A = prproj.clave('ID', '1');
const B = prproj.clave('ID', '2');
const M = prproj.clave('UID', '99999999-9999-4999-8999-999999999999');

module.exports = t => {

    t.group('prproj · el gzip que Premiere acepta');

    t.test('la cabecera sale con los cuatro campos forzados', () => {
        const gz = prproj.comprimir('<hola/>');
        t.eq(prproj.cabeceraDe(gz), prproj.CABECERA_ESPERADA);
        // El byte 9 es el sistema operativo. El gzip de macOS pone 0x03 y el de
        // Python 0xff; Premiere escribe 0x13 y se le copia sin discutir.
        t.eq(gz[9], 0x13, 'el byte de sistema operativo');
        t.eq(gz.readUInt32LE(4), 0, 'MTIME en cero');
        t.eq(gz[8], 0, 'XFL en cero, aunque el nivel 9 lo deje en 2');
    });

    t.test('ida y vuelta no cambia una coma', () => {
        const texto = juguete();
        t.eq(prproj.descomprimir(prproj.comprimir(texto)), texto);
    });

    t.test('dos corridas dan el mismo archivo byte a byte', () => {
        // Es lo que compra MTIME=0: sin eso, dos salidas del generador con los
        // mismos datos difieren, y comparar dos versiones se vuelve imposible.
        const a = prproj.comprimir(juguete());
        const b = prproj.comprimir(juguete());
        t.ok(a.equals(b), 'el gzip tiene que ser determinista');
    });


    t.group('prproj · el índice de objetos');

    t.test('entran los cuatro objetos raíz, con las dos formas de clave', () => {
        const p = new prproj.Proyecto(juguete());
        t.eq(p.bloques.length, 4);
        t.deep(p.claves().sort(), [A, B, M, S].sort());
        t.eq(p.clase(A), 'Cosa');
        t.eq(p.nombre(M), 'el material');
    });

    t.test('lo que cuelga del <Project> no entra al índice', () => {
        // Es la trampa de los dos espacios de numeración: adentro de `<Project>`
        // hay otros `ObjectID` que empiezan de nuevo en 1, y si entraran al
        // índice pisarían los de arriba. La regla que los deja afuera es que un
        // objeto raíz abre a UNA tabulación.
        const p = new prproj.Proyecto(juguete([
            '\t<Project ObjectID="7" ClassID="c9" Version="1">',
            '\t\t<Node Version="1">',
            '\t\t\t<Cosa ObjectID="1" ClassID="c2" Version="1">',
            '\t\t\t\t<Name>la de adentro</Name>',
            '\t\t\t</Cosa>',
            '\t\t</Node>',
            '\t</Project>'
        ]));
        t.eq(p.bloques.length, 5, 'el Project entra; lo de adentro no');
        t.eq(p.nombre(A), 'la de arriba', 'la Cosa 1 sigue siendo la de afuera');
        t.eq(p.maxId(), 7);
    });

    t.test('las referencias se leen en los dos sentidos', () => {
        const p = new prproj.Proyecto(juguete());
        t.deep(p.refsDe(A).sort(), [B, M].sort());
        t.deep(p.quienReferencia(M).sort(), [A, B].sort());
        t.deep(p.quienReferencia(A), [S]);
    });

    t.test('el texto vuelve a salir igual que entró', () => {
        const texto = juguete();
        t.eq(new prproj.Proyecto(texto).texto(), texto);
    });


    t.group('prproj · clonar con frontera');

    t.test('la frontera por clase se reusa, no se copia', () => {
        // Es la razón de ser de las fronteras: sin ellas, clonar un corte se
        // llevaría puesto el archivo de video, y el mismo medio entraría al panel
        // de proyecto una vez por corte.
        const p = new prproj.Proyecto(juguete());
        const { clonados } = p.clonar([A], { claseFrontera: ['Medio'], uid: prproj.generadorDeUid(1) });
        t.eq(clonados.length, 2, 'se copian A y B, no el Medio');
        t.eq(p.porClase('Medio').length, 1, 'sigue habiendo un solo Medio');
        const copiaDeA = clonados.find(k => p.nombre(k) === 'la de arriba');
        t.ok(p.refsDe(copiaDeA).includes(M), 'la copia apunta al Medio original');
    });

    t.test('la frontera por objeto también', () => {
        const p = new prproj.Proyecto(juguete());
        const { clonados } = p.clonar([A], { objFrontera: [B], uid: prproj.generadorDeUid(1) });
        t.eq(clonados.length, 2, 'se copian A y el Medio; B se reusa');
        t.eq(p.porClase('Cosa').length, 3, 'A original, B original y la copia de A');
    });


    t.test('sin frontera se copia el subgrafo entero', () => {
        const p = new prproj.Proyecto(juguete());
        const { clonados } = p.clonar([A], { uid: prproj.generadorDeUid(1) });
        t.eq(clonados.length, 3, 'A, B y el Medio');
        t.eq(p.porClase('Medio').length, 2);
    });

    t.test('la copia estrena claves y nadie de afuera la nombra', () => {
        const p = new prproj.Proyecto(juguete());
        const { clonados, mapaId, mapaUid } = p.clonar([A], { claseFrontera: ['Medio'], uid: prproj.generadorDeUid(1) });
        for (const k of clonados) t.ok(!/^(ID:1|ID:2)$/.test(k), `${k} estrenó clave`);
        t.eq(mapaId.get('1'), String(p.maxId() - 1), 'los ObjectID nuevos siguen al máximo');
        t.eq(mapaUid.size, 0, 'no había nada con UID para renombrar');
        // El sobre seguía apuntando al A original: un clonado agrega, no reemplaza.
        t.deep(p.refsDe(S), [A]);
    });

    t.test('las referencias internas de la copia apuntan a la copia', () => {
        const p = new prproj.Proyecto(juguete());
        const { clonados } = p.clonar([A], { claseFrontera: ['Medio'], uid: prproj.generadorDeUid(1) });
        const copiaA = clonados.find(k => p.nombre(k) === 'la de arriba');
        const copiaB = clonados.find(k => p.nombre(k) === 'la de abajo');
        t.ok(p.refsDe(copiaA).includes(copiaB), 'la copia de A apunta a la copia de B');
        t.ok(!p.refsDe(copiaA).includes(B), 'y no al B original');
        t.ok(/<Item Index="0" ObjectRef="\d+"\/>/.test(p.contenido(copiaA)));
    });

    t.test('clonar por una raíz con UID también renombra la clave', () => {
        const p = new prproj.Proyecto(juguete());
        const { clonados, mapaUid } = p.clonar([S], { claseFrontera: ['Cosa'], uid: prproj.generadorDeUid(1) });
        t.eq(clonados.length, 1);
        t.eq(mapaUid.size, 1, 'el UID del sobre se cambió por uno nuevo');
        t.ok(clonados[0].startsWith('UID:'));
        t.ok(clonados[0] !== S);
    });


    t.group('prproj · los GUID que no son ObjectUID');

    t.test('<ID> y <ClipID> se renuevan; <DefMappingID> no', () => {
        // La trampa 2: `<ID>` y `<ClipID>` son identidad y repetidos rompen el
        // proyecto, pero `<DefMappingID>` es una constante compartida —aparece
        // idéntica en los doce clips maestros del proyecto del editor— y
        // renovarla sería inventar una identidad donde no hay ninguna.
        const p = new prproj.Proyecto(juguete());
        const uid = prproj.generadorDeUid(5);
        const { clonados } = p.clonar([A], { claseFrontera: ['Medio'], uid });
        p.renovarGuidSueltos(clonados, uid);
        const texto = clonados.map(k => p.contenido(k)).join('\n');
        t.ok(!/aaaaaaaa-aaaa/.test(texto), 'el <ID> es otro');
        t.ok(!/bbbbbbbb-bbbb/.test(texto), 'el <ClipID> es otro');
        t.ok(/dddddddd-dddd-4ddd-8ddd-dddddddddddd/.test(texto), 'el <DefMappingID> quedó igual');
    });

    t.test('los GUID inventados son UUID v4 de verdad', () => {
        const uid = prproj.generadorDeUid(3);
        for (let i = 0; i < 50; i++) t.ok(prproj.ES_GUID.test(uid()), 'con forma de UUID');
        t.eq(uid()[14], '4', 'la versión va en su lugar');
        t.ok('89ab'.includes(prproj.generadorDeUid(9)()[19]), 'y la variante también');
    });

    t.test('la misma semilla da la misma tira, y otra semilla otra', () => {
        // Es lo que hace que dos corridas del generador se puedan comparar.
        const a = prproj.generadorDeUid(42);
        const b = prproj.generadorDeUid(42);
        const c = prproj.generadorDeUid(43);
        t.eq(a(), b());
        t.ok(a() !== c());
    });


    t.group('prproj · verificar antes de escribir');

    t.test('un proyecto sano pasa limpio', () => {
        const v = new prproj.Proyecto(juguete()).verificar();
        t.ok(v.ok);
        t.deep([v.colgadas.length, v.indices.length, v.repetidos.length], [0, 0, 0]);
    });

    t.test('una referencia a un objeto que no está se ve', () => {
        // Es lo ÚNICO que separa un archivo que abre de uno que Premiere declara
        // dañado, medido en la prueba C. De ahí que se verifique siempre.
        const p = new prproj.Proyecto(juguete());
        p.cambiar(A, '<Hija ObjectRef="2"/>', '<Hija ObjectRef="404"/>');
        const v = p.verificar();
        t.ok(!v.ok);
        t.eq(v.colgadas.length, 1);
        t.eq(v.colgadas[0].a, 'ID:404');
        t.eq(v.colgadas[0].desde, A);
    });


    t.test('una lista con un hueco en el índice se ve', () => {
        const p = new prproj.Proyecto(juguete());
        p.cambiar(A, '<Item Index="0"', '<Item Index="1"');
        const v = p.verificar();
        t.ok(!v.ok);
        t.eq(v.indices.length, 1);
        t.ok(v.indices[0].lista.startsWith('Item@'), 'dice qué lista y a qué profundidad');
    });

    t.test('un GUID suelto repetido se ve', () => {
        const p = new prproj.Proyecto(juguete());
        p.cambiar(B, '<ClipID>bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb</ClipID>',
            '<ClipID>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</ClipID>');
        const v = p.verificar();
        t.ok(!v.ok);
        t.eq(v.repetidos.length, 1);
        t.eq(v.repetidos[0].donde.length, 2, 'dice los dos lugares donde está');
    });

    t.test('clonar sin renovar los GUID sueltos deja el proyecto repetido', () => {
        // Los dos pasos van juntos siempre, y esta prueba es la que lo sostiene:
        // si alguien clona y se olvida de renovar, esto se pone rojo.
        const p = new prproj.Proyecto(juguete());
        p.clonar([A], { claseFrontera: ['Medio'], uid: prproj.generadorDeUid(1) });
        t.ok(!p.verificar().ok, 'el <ID> quedó en dos objetos a la vez');
    });

    t.test('guardar se niega a escribir un proyecto roto, y no deja el archivo', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const ruta = path.join(dir, 'roto.prproj');
        const p = new prproj.Proyecto(juguete());
        p.cambiar(A, '<Hija ObjectRef="2"/>', '<Hija ObjectRef="404"/>');
        let tiro = null;
        try { p.guardar(ruta); } catch (e) { tiro = e; }
        t.ok(tiro, 'tenía que tirar');
        t.ok(/404/.test(tiro.message), 'y decir qué referencia falta');
        t.ok(!fs.existsSync(ruta), 'no puede quedar un .prproj a medio escribir');
        fs.rmSync(dir, { recursive: true, force: true });
    });


    t.test('guardar un proyecto sano deja un archivo que se puede releer', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const ruta = path.join(dir, 'sano.prproj');
        const p = new prproj.Proyecto(juguete());
        p.guardar(ruta);
        t.eq(prproj.cabeceraDe(fs.readFileSync(ruta)), prproj.CABECERA_ESPERADA);
        t.eq(prproj.Proyecto.leer(ruta).texto(), p.texto(), 'ida y vuelta por el disco');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('la carpeta del destino se crea si no está', () => {
        // El proyecto va en un `Proyecto/` propio y la primera vez no existe.
        // Quien llama pasa la ruta completa y no tiene por qué preparar el
        // terreno antes.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const ruta = path.join(dir, 'Proyecto', 'nuevo.prproj');
        new prproj.Proyecto(juguete()).guardar(ruta);
        t.ok(fs.existsSync(ruta), 'el archivo tiene que estar');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('y si la escritura falla, no queda una carpeta vacía', () => {
        // Una carpeta `Proyecto/` vacía manda al editor a buscar adentro un
        // archivo que nunca se escribió. Se crea al escribir y se deshace si la
        // escritura no llega.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const carpeta = path.join(dir, 'Proyecto');
        const p = new prproj.Proyecto(juguete());
        const escribir = fs.writeFileSync;
        fs.writeFileSync = () => { throw new Error('el disco dijo que no'); };
        let tiro = null;
        try { p.guardar(path.join(carpeta, 'x.prproj')); } catch (e) { tiro = e; }
        fs.writeFileSync = escribir;
        t.ok(tiro, 'tenía que tirar');
        t.ok(!fs.existsSync(carpeta), 'la carpeta que creamos se deshace');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('pero una carpeta que ya estaba no se toca, aunque esté vacía', () => {
        // Vacía es justamente el caso que distingue. Con algo adentro se salva
        // sola —`rmdir` no borra una carpeta con contenido—, así que solo esta
        // prueba dice si de verdad se está mirando quién la creó. Y borrarla
        // sería llevarse puesto algo ajeno: el editor pudo haberla hecho él.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prproj-'));
        const carpeta = path.join(dir, 'Proyecto');
        fs.mkdirSync(carpeta);
        const p = new prproj.Proyecto(juguete());
        const escribir = fs.writeFileSync;
        fs.writeFileSync = () => { throw new Error('el disco dijo que no'); };
        try { p.guardar(path.join(carpeta, 'x.prproj')); } catch (e) { /* se espera */ }
        fs.writeFileSync = escribir;
        t.ok(fs.existsSync(carpeta), 'la que no creamos nosotros se queda');
        fs.rmSync(dir, { recursive: true, force: true });
    });


    t.group('prproj · el tiempo en ticks');

    t.test('un cuadro de cualquiera de los formatos cae en un tick entero', () => {
        // Es la razón por la que Premiere eligió este número: 254016000000 se
        // divide entero por 24, 25, 30, 48, 50 y 60, así que el redondeo no se
        // acumula a lo largo de una clase de una hora.
        for (const fps of [24, 25, 30, 48, 50, 60]) {
            t.eq(prproj.TICKS % fps, 0, `${fps} divide exacto`);
        }
    });

    t.test('ida y vuelta a segundos no pierde nada en los tiempos redondos', () => {
        for (const seg of [0, 1, 12.5, 3600]) {
            t.eq(prproj.aSegundos(prproj.aTicks(seg)), seg);
        }
    });

    t.test('los ticks son enteros, que es lo único que el formato acepta', () => {
        for (const seg of [1 / 3, 0.0333333, 1001 / 30000]) {
            t.eq(prproj.aTicks(seg) % 1, 0, `${seg} da un tick entero`);
        }
    });
};
