'use strict';
/**
 * Renombrar y borrar una clase de la carpeta de notas.
 *
 * Todo lo de acá pasa por el disco de verdad, en una carpeta temporal, y lo que
 * se mira es lo que quedó en ella: que el XML resultante lo lea el parser que
 * usa post, que el sidecar diga lo mismo que el nombre del archivo, y que el WAV
 * esté donde el sidecar dice. Es la única forma de probar esto que sirve —una
 * operación de tres archivos falla justamente en la costura entre dos de ellos—
 * y por eso las clases se graban con el motor entero en vez de escribirse a mano.
 *
 * Lo que se reemplaza es la oreja y nada más: `oir.escuchar` contesta un guion
 * escrito, porque Whisper tarda un segundo por pedazo y necesita un modelo
 * bajado. El WAV, el XML, el sidecar y la forma de la carpeta son los reales.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const grabacion = require('../engine/grabacion');
const clases = require('../engine/clases-grabadas');
const espejo = require('../engine/espejo');
const historial = require('../engine/deshacer');
const nombreDeClase = require('../engine/nombre-de-clase');
const notasXml = require('../engine/notas-xml');
const vivo = require('../engine/notas-vivo');
const workspace = require('../engine/workspace');
const rodecaster = require('../engine/rodecaster-xml');
const oir = require('../engine/oir');

const TASA = 16000;

/** Una clase corta: un conteo que abre la toma y una "Pausa" que la cierra. */
const GUION = [
    ['3,', 1], ['2,', 1.4], ['1.', 1.8],
    ['Hoy', 2.5], ['vemos', 2.8], ['el', 3.1], ['ejercicio', 3.4],
    ['Pausa.', 8]
];

function silencio(segundos) {
    return Buffer.alloc(TASA * 2 * segundos);
}

/**
 * Graba una clase entera y la deja cerrada en el disco.
 *
 * Cierra con `apagar` y no con `terminar` a propósito: los dos escriben el XML y
 * el sidecar y cierran el WAV, pero `terminar` además sale a medir cada toma con
 * un proveedor, y acá lo que se está probando es lo que quedó en la carpeta.
 */
async function grabar(dir, clase, curso) {
    const antes = oir.escuchar;
    oir.escuchar = async p => ({
        palabras: GUION
            .map(([texto, seg]) => ({ t: p.sesion.desdeMs + Math.round(seg * 1000), texto }))
            .filter(w => w.t >= p.desdeMs && w.t <= p.hastaMs),
        colapsadas: 0,
        rellenadas: 0
    });
    try {
        grabacion.iniciar({ dir, clase, curso, sampleRate: TASA, canales: 1, sinReloj: true });
        grabacion.pcm(silencio(12));
        await grabacion.buscarSenales();
        // La cola de relecturas no se exporta: se le da lugar para que termine
        // antes de cerrar, que si no la toma queda con el texto del ciclo liviano.
        for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
        const secuencia = grabacion.resumen().secuencia;
        grabacion.apagar();
        return secuencia;
    } finally {
        oir.escuchar = antes;
    }
}

/** Una carpeta temporal con las clases que se le pidan, ya grabadas y cerradas. */
async function carpeta(lista) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gestionar-'));
    const grabadas = [];
    for (const [clase, curso] of lista) {
        grabadas.push(await grabar(dir, clase, curso));
        // Dos clases seguidas caen en el mismo segundo y comparten nombre: una
        // clase de verdad tarda una hora, y acá la hora es parte de la identidad.
        await new Promise(r => setTimeout(r, 1100));
    }
    return { dir, grabadas };
}

/** La clase que quedó en el disco con ese nombre, tal como la ve la pantalla. */
function enElDisco(dir, secuencia) {
    return clases.listar([dir]).find(c => c.secuencia === secuencia) || null;
}

function sidecarDe(dir, secuencia) {
    return JSON.parse(fs.readFileSync(workspace.notasArchivos(dir, secuencia).json, 'utf8'));
}

/** El `fecha_hora` del final de un nombre, que es lo que un renombrado no toca. */
function horaDelNombre(secuencia) {
    return secuencia.slice(-'2026-09-08_13-01-47'.length);
}

module.exports = async t => {
    t.group('renombrar · el número y el curso, nunca la hora');

    t.test('cambia los dos y deja los tres archivos coherentes', async () => {
        const { dir, grabadas } = await carpeta([[3, 'Curso Viejo']]);
        const antes = grabadas[0];
        const viejo = workspace.notasArchivos(dir, antes);
        const wavViejo = sidecarDe(dir, antes).sesiones[0].archivo;
        t.ok(fs.existsSync(wavViejo), 'la clase grabada dejó su WAV');

        const r = grabacion.renombrarGrabada(viejo.json, { clase: 5, curso: 'Otro Curso' });

        t.eq(r.secuencia, `05_otro-curso_${horaDelNombre(antes)}`, 'el nombre nuevo');
        t.eq(r.audios, 1, 'y el audio se movió con ella');

        // Lo viejo se fue entero: un XML huérfano se importa en Premiere sin que
        // nadie note que es el de antes.
        t.eq(fs.existsSync(viejo.xml), false, 'el XML viejo ya no está');
        t.eq(fs.existsSync(viejo.json), false, 'el sidecar viejo tampoco');
        t.eq(fs.existsSync(wavViejo), false, 'ni el WAV con el nombre viejo');

        // Y lo nuevo está entero y se lee.
        t.ok(fs.existsSync(r.archivos.xml), 'el XML nuevo está');
        const leido = rodecaster.parseFile(r.archivos.xml);
        t.eq(leido.ok, true, leido.error || 'el XML renombrado se parsea');
        t.eq(leido.sequenceName, r.secuencia, 'y la secuencia que declara es la nueva');
        t.eq(rodecaster.classNumberFromSequenceName(leido.sequenceName), 5,
            'post le lee el número nuevo, que es para lo que se renombra');

        const sidecar = sidecarDe(dir, r.secuencia);
        t.eq(sidecar.secuencia, r.secuencia, 'el sidecar dice cómo se llama ahora');
        t.eq(sidecar.clase, 5);
        t.eq(sidecar.curso, 'Otro Curso');
        t.ok(fs.existsSync(sidecar.sesiones[0].archivo), 'y el WAV está donde el sidecar dice');
        t.eq(path.basename(sidecar.sesiones[0].archivo).startsWith(r.secuencia), true,
            'el WAV se llama como la clase');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('la hora de captura sobrevive intacta', async () => {
        // Es la regla que hace que renombrar sea seguro: con esa hora post
        // empareja la clase con la carpeta del Rodecaster, que lleva la suya.
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const antes = grabadas[0];
        const cero = sidecarDe(dir, antes).ceroMs;

        const r = grabacion.renombrarGrabada(
            workspace.notasArchivos(dir, antes).json, { clase: 9, curso: 'Todo Nuevo' });

        t.eq(horaDelNombre(r.secuencia), horaDelNombre(antes), 'el _fecha_hora es el mismo');
        t.eq(nombreDeClase.leer(r.secuencia).cuandoMs, nombreDeClase.leer(antes).cuandoMs);
        t.eq(sidecarDe(dir, r.secuencia).ceroMs, cero, 'y el cero guardado no se movió');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un número ya usado la convierte en la parte siguiente', async () => {
        // Es el mismo criterio que grabar: arrancar con un número usado abre la
        // parte 2 (`parteQueSigue`). Rechazarlo acá sería tener dos reglas para lo
        // mismo, y la peor de las dos para el caso que se quiere resolver.
        const { dir, grabadas } = await carpeta([[1, 'Curso'], [2, 'Curso']]);

        const r = grabacion.renombrarGrabada(
            workspace.notasArchivos(dir, grabadas[1]).json, { clase: 1 });

        t.eq(r.secuencia, `01_p2_curso_${horaDelNombre(grabadas[1])}`, 'quedó como parte 2');
        t.eq(sidecarDe(dir, r.secuencia).parte, 2);
        t.eq(rodecaster.classNumberFromSequenceName(r.secuencia), 1,
            'y para post sigue siendo la clase 1, que es el punto del "_p2_"');
        t.ok(enElDisco(dir, grabadas[0]), 'la parte 1 sigue ahí, sin tocar');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('renombrar al número que ya tenía no la asciende a parte 2', async () => {
        // Corregir el nombre del curso no puede cambiar de qué parte es la clase:
        // contando a ciegas, la clase se encontraba a sí misma y se ascendía sola.
        const { dir, grabadas } = await carpeta([[4, 'Curso Mal Escrito']]);

        const r = grabacion.renombrarGrabada(
            workspace.notasArchivos(dir, grabadas[0]).json, { clase: 4, curso: 'Curso Bien Escrito' });

        t.eq(r.secuencia, `04_curso-bien-escrito_${horaDelNombre(grabadas[0])}`);
        t.eq(sidecarDe(dir, r.secuencia).parte, 1, 'sigue siendo la parte 1');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('sin cambios de verdad no se escribe nada', async () => {
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const cuando = fs.statSync(suyos.xml).mtimeMs;

        const r = grabacion.renombrarGrabada(suyos.json, { clase: 3, curso: 'Curso' });
        t.eq(r.movida, false, 'dice que no movió nada');
        t.eq(fs.statSync(suyos.xml).mtimeMs, cuando, 'y no reescribió el XML');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.group('renombrar · lo que no se puede');

    t.test('un nombre que ya existe no se pisa', async () => {
        // La clase de destino podría ser una parte de verdad, con horas de audio
        // adentro. Pisarla es lo único irreversible que esto podría hacer.
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const destino = workspace.notasArchivos(dir, `07_curso_${horaDelNombre(grabadas[0])}`);
        workspace.writeAtomic(destino.xml, '<xmeml>el de otro</xmeml>');

        let error = '';
        try {
            grabacion.renombrarGrabada(suyos.json, { clase: 7 });
        } catch (e) {
            error = e.message;
        }
        t.ok(/Ya hay una clase/.test(error), error || 'tendría que haberse negado');
        t.eq(fs.readFileSync(destino.xml, 'utf8'), '<xmeml>el de otro</xmeml>', 'no lo tocó');
        t.ok(fs.existsSync(suyos.json), 'y la clase de origen sigue entera');
        t.ok(enElDisco(dir, grabadas[0]), 'y se sigue listando con su nombre');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('la clase que se está grabando ahora no se renombra', async () => {
        // El motor tiene su nombre en memoria y le reescribe el XML en cada
        // cambio: moverle los archivos por debajo la partiría en dos.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gestionar-'));
        const antes = oir.escuchar;
        oir.escuchar = async () => ({ palabras: [], colapsadas: 0, rellenadas: 0 });
        try {
            const estado = grabacion.iniciar({ dir, clase: 2, curso: 'Curso', sampleRate: TASA, canales: 1, sinReloj: true });
            let error = '';
            try {
                grabacion.renombrarGrabada(estado.archivos.json, { clase: 8 });
            } catch (e) {
                error = e.message;
            }
            t.ok(/se está grabando/.test(error), error || 'tendría que haberse negado');
            t.ok(fs.existsSync(estado.archivos.json), 'el sidecar de la sesión sigue donde estaba');

            // Y borrar tampoco, por lo mismo y con más razón.
            let otro = '';
            try {
                grabacion.borrarGrabada(estado.archivos.json);
            } catch (e) {
                otro = e.message;
            }
            t.ok(/se está grabando/.test(otro), otro || 'borrar tendría que haberse negado');
            t.ok(fs.existsSync(estado.archivos.xml), 'y el XML de la sesión sigue ahí');
        } finally {
            oir.escuchar = antes;
            grabacion.apagar();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('un número fuera de rango no llega al disco', async () => {
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);

        for (const malo of [0, -2, 1000, 'siete', NaN]) {
            let error = '';
            try {
                grabacion.renombrarGrabada(suyos.json, { clase: malo });
            } catch (e) {
                error = e.message;
            }
            t.ok(/entre 1 y 999/.test(error), `${malo}: ${error || 'pasó sin quejarse'}`);
        }
        t.ok(enElDisco(dir, grabadas[0]), 'la clase quedó como estaba');

        // Y no mandar el número es distinto de mandar uno malo: es "dejalo como
        // está", igual que con el curso. La pantalla va a mandar los dos campos
        // siempre, pero el que solo quiera corregir el curso no tiene por qué.
        const r = grabacion.renombrarGrabada(suyos.json, { curso: 'Otro' });
        t.eq(r.secuencia, `03_otro_${horaDelNombre(grabadas[0])}`, 'sigue siendo la clase 3');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un curso vacío no deja la clase sin nombre', async () => {
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        let error = '';
        try {
            grabacion.renombrarGrabada(workspace.notasArchivos(dir, grabadas[0]).json, { curso: '   ' });
        } catch (e) {
            error = e.message;
        }
        t.ok(/no puede quedar vacío/.test(error), error || 'pasó sin quejarse');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un curso con barras y ".." no escribe fuera de la carpeta', async () => {
        // El nombre del curso lo tipea el editor y viaja por el puente. Que
        // `safeName` lo limpie no alcanza como respuesta: acá se comprueba que el
        // archivo cayó adentro, que es lo que de verdad importa.
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const afuera = path.dirname(dir);
        const habia = new Set(fs.readdirSync(afuera));

        const r = grabacion.renombrarGrabada(
            workspace.notasArchivos(dir, grabadas[0]).json,
            { clase: 3, curso: '../../fuera/de/aca' });

        t.eq(workspace.dentroDe(workspace.notasXmlDir(dir), r.archivos.xml), true,
            `el XML quedó en ${r.archivos.xml}`);
        t.eq(workspace.dentroDe(workspace.notasXmlDir(dir), r.archivos.json), true,
            'y el sidecar también');
        t.eq(r.secuencia.includes('..'), false, `sin ".." en el nombre: ${r.secuencia}`);
        t.eq(r.secuencia.includes('/'), false, 'y sin barras');
        t.deep(fs.readdirSync(afuera).filter(x => !habia.has(x)), [],
            'y no apareció nada nuevo un piso más arriba');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('si falla a mitad de camino, la clase queda como estaba', async () => {
        // El caso que justifica el orden y la vuelta atrás: el audio ya se movió y
        // la escritura del XML se cae (un disco lleno). Sin deshacerlo, la clase
        // se quedaba con el sidecar viejo apuntando a un WAV con nombre nuevo, o
        // sea sin audio, y eso no se ve hasta que alguien aprieta "Regenerar".
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const wav = sidecarDe(dir, grabadas[0]).sesiones[0].archivo;

        const antes = notasXml.xmlDeNotas;
        notasXml.xmlDeNotas = () => { throw new Error('no entra en el disco'); };
        let error = '';
        try {
            grabacion.renombrarGrabada(suyos.json, { clase: 6 });
        } catch (e) {
            error = e.message;
        } finally {
            notasXml.xmlDeNotas = antes;
        }

        t.eq(error, 'no entra en el disco', 'el fallo se cuenta tal cual');
        t.ok(fs.existsSync(wav), 'el WAV volvió a su nombre de antes');
        t.ok(fs.existsSync(suyos.xml), 'el XML viejo sigue ahí');
        t.ok(fs.existsSync(suyos.json), 'y el sidecar viejo también');
        const destino = workspace.notasArchivos(dir, `06_curso_${horaDelNombre(grabadas[0])}`);
        t.eq(fs.existsSync(destino.xml), false, 'y no quedó medio archivo con el nombre nuevo');
        t.eq(fs.existsSync(destino.json), false);
        t.ok(enElDisco(dir, grabadas[0]), 'la clase se sigue listando entera');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.group('borrar · los tres archivos, de verdad');

    t.test('se lleva el XML, el sidecar y el audio', async () => {
        const { dir, grabadas } = await carpeta([[3, 'Curso'], [4, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const wav = sidecarDe(dir, grabadas[0]).sesiones[0].archivo;
        t.ok(fs.existsSync(wav), 'había audio que borrar');

        const r = grabacion.borrarGrabada(suyos.json);

        t.deep({ xml: r.xml, sidecar: r.sidecar, audios: r.audios }, { xml: true, sidecar: true, audios: 1 });
        t.eq(fs.existsSync(suyos.xml), false, 'el XML se fue');
        t.eq(fs.existsSync(suyos.json), false, 'el sidecar se fue');
        t.eq(fs.existsSync(wav), false, 'y el audio también, que es el que ocupa el disco');
        t.eq(enElDisco(dir, grabadas[0]), null, 'y deja de aparecer en la lista');
        t.ok(enElDisco(dir, grabadas[1]), 'la otra clase de la carpeta no se tocó');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('si falta alguno de los tres, termina el trabajo igual', async () => {
        // Se borra una clase justamente cuando quedó mal. Plantarse en el primer
        // archivo ausente dejaría los otros dos sin forma de sacarlos desde la app.
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        fs.rmSync(sidecarDe(dir, grabadas[0]).sesiones[0].archivo);
        fs.rmSync(suyos.xml);

        const r = grabacion.borrarGrabada(suyos.json);

        t.deep({ xml: r.xml, sidecar: r.sidecar, audios: r.audios }, { xml: false, sidecar: true, audios: 0 },
            'cuenta lo que había, sin inventar');
        t.eq(fs.existsSync(suyos.json), false, 'y se llevó lo único que quedaba');
        t.deep(clases.listar([dir]), [], 'la carpeta quedó sin clases');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('volver a apretar sobre una clase a medio borrar la termina', async () => {
        // Es lo que hace que dejar el sidecar para el final sea seguro: un corte
        // deja la clase visible y a medias, y el gesto siguiente la limpia.
        const { dir, grabadas } = await carpeta([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);

        grabacion.borrarGrabada(suyos.json);
        const otra = grabacion.borrarGrabada.bind(null, suyos.json);
        let error = '';
        try { otra(); } catch (e) { error = e.message; }
        t.ok(/No pude leer esa clase/.test(error), error || 'sin sidecar ya no hay clase que leer');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('una escritura que llega tarde no resucita la clase borrada', () => {
        // Borrar se aprieta con la clase recién terminada, y de una sesión que se
        // cierra quedan cosas en el aire: una medida que salió a preguntarle a un
        // modelo vuelve medio minuto después y escribe el XML y el sidecar. Si esa
        // escritura no supiera que la sesión ya se soltó, el archivo volvería solo
        // y la clase reaparecería en la lista después de haberla borrado.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gestionar-'));
        const sesion = {
            viva: true,
            dir,
            estado: vivo.estadoNuevo({
                secuencia: '03_curso_2026-09-08_13-01-47',
                clase: 3, parte: 1, curso: 'Curso', ceroMs: Date.UTC(2026, 8, 8, 13, 1, 47)
            }),
            captura: null,
            historia: historial.nueva(),
            midiendoTemario: null,
            terminando: false,
            avisar: () => {}
        };

        t.ok(espejo.fijar(sesion), 'con la sesión viva, escribe');
        const suyos = workspace.notasArchivos(dir, sesion.estado.secuencia);
        t.ok(fs.existsSync(suyos.xml) && fs.existsSync(suyos.json), 'y la clase está en el disco');

        t.eq(grabacion.borrarGrabada(suyos.json).sidecar, true, 'se la borra');
        // Lo que hace `grabacion.apagar` al soltar la sesión.
        sesion.viva = false;

        t.eq(espejo.fijar(sesion), null, 'la escritura tardía no hace nada');
        t.eq(fs.existsSync(suyos.xml), false, 'el XML no volvió');
        t.eq(fs.existsSync(suyos.json), false, 'y el sidecar tampoco');
        t.deep(clases.listar([dir]), [], 'la clase sigue borrada');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un archivo que no es una clase no se borra', async () => {
        // La ruta llega por el puente. Que solo se acepte el sufijo del sidecar es
        // lo que impide que esto se convierta en un "borrá cualquier cosa".
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gestionar-'));
        const ajeno = path.join(dir, 'importante.txt');
        fs.writeFileSync(ajeno, 'no me borres');

        for (const gesto of [() => grabacion.borrarGrabada(ajeno),
            () => grabacion.renombrarGrabada(ajeno, { clase: 1 })]) {
            let error = '';
            try { gesto(); } catch (e) { error = e.message; }
            t.ok(/no es el archivo de una clase/.test(error), error || 'pasó sin quejarse');
        }
        t.eq(fs.readFileSync(ajeno, 'utf8'), 'no me borres', 'sigue ahí, entero');

        fs.rmSync(dir, { recursive: true, force: true });
    });
};
