'use strict';
/**
 * El puente de la toma de notas: `ipc/grabar.js`, del lado de acá del cable.
 *
 * Por qué hace falta si el motor ya está probado hasta el disco
 * (`gestionar-clases.test.js`). Porque entre el gesto y el motor hay una capa que
 * no es el motor y que puede fallar sola, y de la que dependen cosas que del otro
 * lado no se ven:
 *
 * **Un manejador que TIRA en vez de contestar deja la pantalla colgada.** El
 * motor se niega tirando —es lo correcto: un renombrado que no se puede hacer no
 * tiene resultado— y el puente tiene que convertir eso en `{ok:false, error}`. Si
 * dejara escapar la excepción, `ipcRenderer.invoke` rechaza, el `await` de la
 * vista tira, y el botón «Guardar» se queda en «Guardando…» para siempre con el
 * motivo perdido en una consola que nadie abre.
 *
 * **Y lo que se contesta tiene que poder viajar.** Lo que vuelve de un `invoke`
 * se copia con el algoritmo de clonado estructurado, que no sabe copiar
 * funciones, clases ni referencias circulares: una respuesta que en Node se lee
 * perfecta puede reventar en el puente y solo en producción. Se comprueba acá con
 * el mismo `structuredClone`, que es exactamente la regla que Electron aplica.
 *
 * Lo que esto NO es: la prueba de que el viaje se hace. Eso pide Electron
 * levantado y la ventana pidiendo por `window.cc`, y vive en
 * `tools/probar-gestionar.js`. Acá se prueba la capa; allá, el cable.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const puente = require('../ipc/grabar');
const grabacion = require('../engine/grabacion');
const workspace = require('../engine/workspace');

const TASA = 16000;

/**
 * Los canales del puente, con el diario que fueron escribiendo.
 *
 * Se registran contra un `ipcMain` de mentira que se limita a guardar cada
 * manejador: lo que interesa de él es qué canales pide y con qué contesta, no
 * cómo Electron los transporta. El `app` también, porque el puente le cuelga el
 * cierre de la grabación al salir y acá no hay app que salga.
 */
function montar() {
    const canales = new Map();
    const diario = [];
    puente.registrar({
        ipcMain: {
            handle: (canal, fn) => canales.set(canal, fn),
            on: (canal, fn) => canales.set(canal, fn)
        },
        app: { on: () => {} },
        send: () => {},
        anotar: (evento, datos) => diario.push({ evento, datos })
    });
    return {
        diario,
        /** Como lo llama Electron: el `event` primero, y después lo que mandó la ventana. */
        pedir: (canal, ...args) => {
            const fn = canales.get(canal);
            if (!fn) throw new Error(`el puente no registró el canal ${canal}`);
            return fn({}, ...args);
        },
        eventos: () => diario.map(l => l.evento)
    };
}

/**
 * Una clase grabada y cerrada en una carpeta temporal, con sus tres archivos.
 *
 * Sin pasar nunca por el ciclo de señales, así que no se levanta ningún Whisper:
 * la clase queda sin tomas, que para renombrarla y borrarla da igual. El WAV es
 * silencio, pero es un WAV de verdad escrito por `captura`, que es lo que hace
 * falta para poder mirar si el renombrado se lo lleva.
 */
function grabar(dir, clase, curso) {
    grabacion.iniciar({ dir, clase, curso, sampleRate: TASA, canales: 1, sinReloj: true });
    grabacion.pcm(Buffer.alloc(TASA * 2));
    const secuencia = grabacion.resumen().secuencia;
    grabacion.apagar();
    return secuencia;
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

async function carpetaCon(lista) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-puente-'));
    const grabadas = [];
    for (const [clase, curso] of lista) {
        grabadas.push(grabar(dir, clase, curso));
        // Dos clases seguidas caen en el mismo segundo y comparten nombre.
        await dormir(1100);
    }
    return { dir, grabadas };
}

/** Lo que Electron le hace a una respuesta antes de entregarla a la ventana. */
function comoLlegaALaVentana(valor) {
    return structuredClone(valor);
}

module.exports = async t => {
    t.group('el puente de grabar · renombrar');

    t.test('contesta {ok:true} con todo lo que la vista lee', async () => {
        // Los campos son los que `src/js/grabar/grabadas.js` usa para armar el
        // aviso: sin `movida` no sabe si decir "quedó como…" o "no había nada que
        // mover", y sin `audios` no sabe si nombrar el audio.
        const { dir, grabadas } = await carpetaCon([[3, 'Curso Viejo']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const app = montar();

        const r = app.pedir('grabar-renombrar', suyos.json, { clase: 5, curso: 'Curso Nuevo' });

        t.eq(r.ok, true, r.error);
        t.eq(r.secuencia, `05_curso-nuevo_${grabadas[0].slice(-19)}`);
        t.eq(r.movida, true, 'dice que movió los archivos');
        t.eq(r.audios, 1, 'y que se llevó el audio');
        t.ok(r.archivos && r.archivos.xml && r.archivos.json, 'y dónde quedó cada archivo');
        t.ok(fs.existsSync(r.archivos.json), 'que es donde están de verdad');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('la respuesta sobrevive al clonado del puente', async () => {
        // Es la regla de `ipcRenderer.invoke` y no se puede ver leyendo el código:
        // cualquier cosa que el motor devuelva y no sea copiable —una función, una
        // instancia de clase, un ciclo— revienta en el cable y solo en producción.
        const { dir, grabadas } = await carpetaCon([[3, 'Curso']]);
        const app = montar();

        const r = app.pedir('grabar-renombrar',
            workspace.notasArchivos(dir, grabadas[0]).json, { clase: 6 });
        t.deep(comoLlegaALaVentana(r), r, 'llega igual del otro lado');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('lo que el motor niega vuelve como {ok:false, error} y no como una excepción', async () => {
        // Es la razón entera del `try` del puente. Si la excepción se escapara, el
        // `invoke` de la ventana rechazaría, el `await` de `renombrar` tiraría, y el
        // botón se quedaría en «Guardando…» con el motivo perdido en una consola.
        const { dir, grabadas } = await carpetaCon([[3, 'Curso']]);
        const app = montar();

        let tiro = null;
        let r = null;
        try {
            r = app.pedir('grabar-renombrar',
                workspace.notasArchivos(dir, grabadas[0]).json, { curso: '   ' });
        } catch (e) {
            tiro = e.message;
        }
        t.eq(tiro, null, `el puente dejó escapar la excepción: ${tiro}`);
        t.eq(r.ok, false, 'contestó que no se pudo');
        t.ok(/no puede quedar vacío/.test(r.error || ''), r.error || 'sin motivo que mostrar');
        t.deep(comoLlegaALaVentana(r), r, 'y el motivo también viaja');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('deja las dos líneas en el diario: la que pide y la que salió', async () => {
        // El diario es lo único que queda cuando el editor dice "no me anduvo": sin
        // la segunda línea, un renombrado que se colgó a mitad y uno que salió bien
        // se leen igual.
        const { dir, grabadas } = await carpetaCon([[3, 'Curso']]);
        const app = montar();

        app.pedir('grabar-renombrar', workspace.notasArchivos(dir, grabadas[0]).json, { clase: 7 });
        t.deep(app.eventos(), ['grabar.renombrar', 'grabar.renombrada']);
        t.eq(app.diario[1].datos.secuencia, `07_curso_${grabadas[0].slice(-19)}`,
            'y la segunda dice con qué nombre quedó');

        app.pedir('grabar-renombrar', 'cualquier-cosa.txt', { clase: 7 });
        t.eq(app.eventos()[3], 'grabar.renombrar-falla', 'lo que no se pudo también se anota');
        t.ok(/no es el archivo de una clase/.test(app.diario[3].datos.error), app.diario[3].datos.error);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.group('el puente de grabar · borrar');

    t.test('contesta qué se fue de los tres archivos', async () => {
        // Los tres por separado y no un "listo": la vista los nombra en el aviso, y
        // puede irse menos de lo que el cartel anunciaba —un audio que alguien ya
        // había movido a mano no estaba para borrar—.
        const { dir, grabadas } = await carpetaCon([[3, 'Curso']]);
        const suyos = workspace.notasArchivos(dir, grabadas[0]);
        const wav = JSON.parse(fs.readFileSync(suyos.json, 'utf8')).sesiones[0].archivo;
        const app = montar();

        const r = app.pedir('grabar-borrar', suyos.json);

        t.deep({ ok: r.ok, xml: r.xml, sidecar: r.sidecar, audios: r.audios },
            { ok: true, xml: true, sidecar: true, audios: 1 });
        t.eq(r.secuencia, grabadas[0], 'y de cuál clase se habla');
        t.deep(comoLlegaALaVentana(r), r, 'la respuesta viaja entera');
        t.eq(fs.existsSync(suyos.xml), false, 'el XML se fue');
        t.eq(fs.existsSync(suyos.json), false, 'el archivo de datos se fue');
        t.eq(fs.existsSync(wav), false, 'y el audio también');
        t.deep(app.eventos(), ['grabar.borrar', 'grabar.borrada']);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.test('un archivo que no es una clase se contesta, no se borra', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-puente-'));
        const ajeno = path.join(dir, 'importante.txt');
        fs.writeFileSync(ajeno, 'no me borres');
        const app = montar();

        const r = app.pedir('grabar-borrar', ajeno);
        t.eq(r.ok, false);
        t.ok(/no es el archivo de una clase/.test(r.error || ''), r.error);
        t.eq(fs.readFileSync(ajeno, 'utf8'), 'no me borres', 'sigue ahí, entero');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    t.group('el puente de grabar · la clase que se está grabando');

    t.test('renombrarla y borrarla se niegan las dos, por el mismo canal que las hace', async () => {
        // Que la negativa viva en la fachada del motor y no en el puente es lo que
        // hace que estos dos canales no puedan olvidarse de preguntar: acá se
        // comprueba que el camino de ida —el que la ventana usa— la respeta.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-puente-'));
        const app = montar();
        try {
            const arranque = app.pedir('grabar-iniciar',
                { dir, clase: 2, curso: 'Curso', sampleRate: TASA, canales: 1, sinReloj: true });
            t.eq(arranque.ok, true, arranque.error);
            const suyo = arranque.estado.archivos.json;

            const negado = app.pedir('grabar-renombrar', suyo, { clase: 8 });
            t.eq(negado.ok, false, 'renombrar se negó');
            t.ok(/se está grabando/.test(negado.error || ''), negado.error);

            const otro = app.pedir('grabar-borrar', suyo);
            t.eq(otro.ok, false, 'borrar también');
            t.ok(/se está grabando/.test(otro.error || ''), otro.error);

            t.ok(fs.existsSync(suyo), 'y los archivos de la sesión siguen donde estaban');
            t.eq(app.pedir('grabar-listar', [dir]).length, 0,
                'la clase en curso tampoco se lista, que es la otra mitad de lo mismo');
        } finally {
            grabacion.apagar();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
};
