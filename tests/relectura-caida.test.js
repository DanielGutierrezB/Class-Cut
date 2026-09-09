'use strict';
/**
 * Una toma que se quedó sin relectura, en una sesión de verdad y contra disco.
 *
 * El criterio y la cadena hasta la marca están en `tests/insistir.test.js`, con
 * procesos que se mueren de verdad. Lo de acá es la otra mitad, la que solo se
 * puede ver con el motor entero andando: que la marca **quede en el archivo** y
 * sobreviva a cerrar la app, que la pantalla la diga, que la toma no se quede
 * callada, y que "Regenerar" la limpie.
 *
 * Todo pasa por el disco de verdad, en una carpeta temporal, y lo que se mira es
 * lo que quedó en ella. Lo que se reemplaza es la oreja y nada más —`oir.escuchar`
 * contesta un guion escrito, porque Whisper tarda un segundo por pedazo y
 * necesita un modelo bajado—, que es el patrón de `tests/gestionar-clases.test.js`.
 * El WAV, el XML, el sidecar, la cola de relecturas y la forma de la carpeta son
 * los reales.
 *
 * **Por qué el fallo de casi todas es un código y no una señal.** Los dos llegan
 * por el mismo camino y la marca que dejan es la misma; lo que cambia es la
 * espera, y con una señal la política espera de verdad los 4,25 s que tiene
 * razonados. Una prueba que necesite comprobar ESA espera está abajo y es una
 * sola; las demás usan un código, que se resuelve sin esperar nada, para no
 * cobrarle a la suite cuatro segundos por cada cosa que se mira.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const clases = require('../engine/clases-grabadas');
const grabacion = require('../engine/grabacion');
const insistir = require('../engine/insistir');
const medirToma = require('../engine/medir-toma');
const oir = require('../engine/oir');
const paths = require('../engine/paths');
const transcribe = require('../engine/transcribe');
const workspace = require('../engine/workspace');

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

function palabrasDelGuion(p) {
    return GUION
        .map(([texto, seg]) => ({ t: p.sesion.desdeMs + Math.round(seg * 1000), texto }))
        .filter(w => w.t >= p.desdeMs && w.t <= p.hastaMs);
}

/** El error que larga `runWhisper` cuando el proceso se muere, con su dato. */
function muerto(como) {
    const err = new transcribe.TranscribeError(
        como === 'senal'
            ? transcribe.motivoDeSalida(null, 'SIGKILL', 'ggml_metal_init: no se pudo reservar', '')
            : transcribe.motivoDeSalida(3, null, 'error: no se pudo abrir el modelo', ''),
        'whisper');
    err.muerte = como === 'senal'
        ? transcribe.comoMurio(null, 'SIGKILL')
        : transcribe.comoMurio(3, null);
    return err;
}

/**
 * Graba una clase entera y la deja cerrada en el disco.
 *
 * El ciclo de señales siempre oye el guion —de él salen las tomas— y la pasada
 * grande hace lo que diga `alReleer`, que es la que se está probando. Es la misma
 * frontera que tiene la app: dos ciclos, y solo uno escribe el texto que queda.
 *
 * Cierra con `terminar` y no con `apagar` porque `terminar` es el único que
 * ESPERA la cola de relecturas, que es justo lo que hay que dejar terminar acá.
 * Y corre sin medidores de toma (`conEstos([])`) para que el cierre no salga a
 * preguntarle nada a ningún proveedor: lo que se prueba es lo que quedó escrito.
 */
async function grabar(dir, params) {
    const p = params || {};
    const antes = oir.escuchar;
    let releidas = 0;
    // Con qué modelo se pidió cada pasada grande, en orden. Lo trae el pedido que
    // arma `oir-toma`, así que es lo que la política eligió de verdad y no lo que
    // la prueba supone: es el único lugar desde donde se ve la bajada de modelo.
    const conQue = [];
    oir.escuchar = async pedido => {
        if (pedido.liviano) {
            return { palabras: palabrasDelGuion(pedido), colapsadas: 0, rellenadas: 0 };
        }
        releidas++;
        conQue.push(pedido.modelo ? pedido.modelo.name : null);
        const que = p.alReleer(releidas, pedido);
        if (que instanceof Error) throw que;
        return que || { palabras: palabrasDelGuion(pedido), colapsadas: 0, rellenadas: 0 };
    };
    try {
        return await medirToma.conEstos(p.medidores || [], async () => {
            grabacion.iniciar({
                dir, clase: p.clase || 2, curso: p.curso || 'Curso',
                sampleRate: TASA, canales: 1, sinReloj: true
            });
            grabacion.pcm(silencio(30));
            await grabacion.buscarSenales();
            const salida = await grabacion.terminar();
            return { secuencia: salida.secuencia, veces: releidas, conQue };
        });
    } finally {
        oir.escuchar = antes;
        if (grabacion.activa()) grabacion.apagar();
    }
}

function sidecarDe(dir, secuencia) {
    return JSON.parse(fs.readFileSync(workspace.notasArchivos(dir, secuencia).json, 'utf8'));
}

function temporal() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-relectura-'));
}

/** Lo que pesa un modelo de esta máquina, para mirar que la bajada baje. */
function pesoDe(nombre) {
    const suyo = paths.modelosInstalados().find(m => m.name === nombre);
    return suyo ? suyo.bytes : 0;
}

/** Corre el cuerpo con un escalón de abajo puesto, y devuelve el que había. */
async function conEscalon(nombre, cuerpo) {
    const antes = paths.escalonDebajo;
    paths.escalonDebajo = modelo => (modelo && modelo.name !== nombre
        ? { name: nombre, path: `/no/importa/${nombre}`, bytes: 1 }
        : null);
    try {
        return await cuerpo();
    } finally {
        paths.escalonDebajo = antes;
    }
}

module.exports = async t => {
    const src = nombre => pathToFileURL(path.join(__dirname, '..', 'src', 'js', nombre)).href;
    const tarjeta = await import(src('grabar/tomas.js'));

    t.group('la toma que se quedó sin relectura · lo que queda en el archivo');

    t.test('queda marcada «sin-leer» en el sidecar, con el texto del ciclo liviano', async () => {
        // **El caso que esto vino a arreglar.** Antes la toma se quedaba con el
        // texto descartable y el editor recibía un aviso que se iba solo: al día
        // siguiente, con la app cerrada, no había forma de saber cuál era.
        const dir = temporal();
        try {
            const { secuencia, conQue } = await grabar(dir, { alReleer: () => muerto('codigo') });

            // **Cuántos intentos gasta esto depende de qué haya bajado la máquina,
            // así que lo que se afirma es la invariante y no el número.** Escrito
            // como `veces === 1` valía mientras esta Mac no tuviera ningún modelo
            // más liviano que el grande; el día que apareció `small` se puso en
            // rojo sin que nada estuviera roto. Lo que no puede pasar nunca es que
            // un código —que es determinista— se reintente con el mismo modelo, ni
            // que la bajada se detenga antes del último escalón.
            t.eq(new Set(conQue).size, conQue.length,
                `ningún modelo dos veces: ${conQue.join(' → ')}`);
            t.eq(conQue[0], paths.whisperModel().name, 'se empieza por el bueno');
            for (let i = 1; i < conQue.length; i++) {
                t.ok(pesoDe(conQue[i]) < pesoDe(conQue[i - 1]),
                    `${conQue[i]} tiene que pesar menos que ${conQue[i - 1]}`);
            }
            t.eq(paths.escalonDebajo({ name: conQue[conQue.length - 1] }), null,
                `se bajó hasta el último escalón: ${conQue[conQue.length - 1]}`);

            const sidecar = sidecarDe(dir, secuencia);
            const toma = sidecar.tomas[0];
            t.ok(toma, 'la clase tiene su toma');
            t.eq(toma.relectura.estado, 'sin-leer', JSON.stringify(toma.relectura));
            t.ok(/Regenerar/.test(toma.relectura.porque), toma.relectura.porque);
            t.ok(/descartable/.test(toma.relectura.porque),
                'y dice que el texto que se ve no es el bueno');
            t.ok(toma.palabras.length > 0,
                'la toma conserva el texto que tenía: peor que nada es mejor que nada');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('leída con un modelo peor, queda marcada «degradada» con los dos nombres', async () => {
        const dir = temporal();
        try {
            const r = await conEscalon('ggml-base.bin', () => grabar(dir, {
                // El primero se muere; el escalón de abajo contesta.
                alReleer: vez => (vez === 1 ? muerto('codigo') : null)
            }));
            t.eq(r.veces, 2, 'el bueno y el escalón de abajo');

            const toma = sidecarDe(dir, r.secuencia).tomas[0];
            t.eq(toma.relectura.estado, 'degradada');
            t.eq(toma.relectura.modelo, 'ggml-base.bin', 'con qué se leyó');
            t.eq(toma.relectura.bueno, paths.whisperModel().name, 'y con qué se la quería leer');
            t.ok(toma.palabras.length > 0, 'y tiene texto, que es para lo que se bajó');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('una clase que salió bien no lleva ninguna marca', async () => {
        // La marca ausente es la que dice "esta toma está bien", así que una
        // política que marcara siempre no marcaría nada. Es la misma convención de
        // las medidas del panel: sin estado, la tarjeta no dibuja.
        const dir = temporal();
        try {
            const { secuencia, veces } = await grabar(dir, { alReleer: () => null });
            t.eq(veces, 1, 'una sola pasada, que es lo que cuesta una clase sana');
            t.eq(sidecarDe(dir, secuencia).tomas[0].relectura, null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('el texto descartable no se mide como si fuera bueno', async () => {
        // La toma sin releer conserva el texto del ciclo de señales para que no
        // quede en silencio, pero de ese texto no se cree ni una palabra: medirle
        // la lengua o el empalme sería sacar conclusiones de lo que está declarado
        // descartable, y el panel las mostraría con el mismo aspecto que las
        // buenas. Se mira con un medidor de mentira porque es la única forma de
        // ver que no lo llamaron: una medida ausente se parece demasiado a una
        // medida que nadie pidió.
        const dir = temporal();
        const pedidas = [];
        const chismoso = {
            clave: 'loQueSeMidio',
            medir: toma => { pedidas.push(toma.id); return { valor: 1 }; }
        };
        try {
            const roto = await grabar(dir, {
                alReleer: () => muerto('codigo'), medidores: [chismoso]
            });
            t.deep(pedidas, [], 'a nadie se le pidió medir la toma que no se pudo releer');
            const toma = sidecarDe(dir, roto.secuencia).tomas[0];
            t.eq(toma.lengua, null, 'y no quedó ninguna medida en el archivo');

            // Y la otra mitad, sin la cual lo de arriba lo cumpliría una app que
            // no midiera nunca: la toma que SÍ se releyó se mide igual que siempre.
            const sano = await grabar(dir, { clase: 3, alReleer: () => null, medidores: [chismoso] });
            t.eq(pedidas.length, 1, 'la toma buena sí se midió');
            t.ok(sidecarDe(dir, sano.secuencia).tomas[0], 'y quedó su clase escrita');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.group('la toma que se quedó sin relectura · lo que dice la tarjeta');

    t.test('la degradada avisa sin ámbar: la app hizo lo que decidió y salió', async () => {
        const dicho = tarjeta.avisos({
            id: 3,
            relectura: insistir.degradada({ modelo: 'ggml-base.bin', bueno: 'ggml-large-v3-turbo.bin' })
        });
        t.eq(dicho.length, 1, 'un renglón y nada más');
        t.eq(dicho[0].clase, 'es-degradada',
            'la barra del acento, como `es-abstenido` en el panel, y no el ámbar de una falla');
        t.ok(/ggml-base\.bin/.test(dicho[0].texto), dicho[0].texto);
        t.ok(/ggml-large-v3-turbo\.bin/.test(dicho[0].texto), 'y con cuál se la quería leer');
    });

    t.test('la sin-leer avisa en el ámbar de los demás avisos, no en un cartel', async () => {
        // El peso que le corresponde: el mismo que "Se cerró sola", en la tarjeta
        // de su toma. Un diálogo o una franja arriba, en medio de una clase que se
        // está grabando, se cierra sin leer — y con veinte tomas por clase se
        // convierte en algo que se aprende a cerrar.
        const dicho = tarjeta.avisos({
            id: 3,
            relectura: insistir.sinLeer({ bueno: 'ggml-large-v3-turbo.bin' })
        });
        t.eq(dicho.length, 1);
        t.eq(dicho[0].clase, 'es-sin-leer', 'sin clase propia de color: hereda el ámbar de `.toma-aviso`');
        t.ok(/Regenerar/.test(dicho[0].texto), dicho[0].texto);
    });

    t.test('una toma sana no agrega ningún renglón', async () => {
        t.deep(tarjeta.avisos({ id: 1, relectura: null }), []);
        t.deep(tarjeta.avisos({ id: 1 }), []);
    });

    t.test('y el aviso convive con los que ya estaban, en orden', async () => {
        // Una toma puede haberse cerrado sola Y haberse leído con un modelo peor.
        // Si el nuevo pisara a los otros, el arreglo costaría un aviso que ya
        // estaba probado.
        const dicho = tarjeta.avisos({
            id: 4,
            cerradaSola: true,
            relectura: insistir.sinLeer({ bueno: 'ggml-large-v3-turbo.bin' })
        });
        t.deep(dicho.map(d => d.clase || ''), ['', 'es-sin-leer']);
    });

    t.group('la toma que se quedó sin relectura · Regenerar la arregla');

    t.test('regenerar limpia la marca y lo cuenta', async () => {
        // **Es el gesto para el que la marca existe.** La toma que quedó leída con
        // un modelo peor es justo lo que "Regenerar" arregla: acá no hay ningún
        // Whisper de señales peleando la máquina, así que el modelo bueno sí entra.
        const dir = temporal();
        try {
            const r = await conEscalon('ggml-base.bin', () => grabar(dir, {
                alReleer: vez => (vez === 1 ? muerto('codigo') : null)
            }));
            const suyos = workspace.notasArchivos(dir, r.secuencia);
            t.eq(sidecarDe(dir, r.secuencia).tomas[0].relectura.estado, 'degradada');

            const antes = oir.escuchar;
            oir.escuchar = async pedido => ({
                palabras: palabrasDelGuion(pedido), colapsadas: 0, rellenadas: 0
            });
            let salida;
            try {
                salida = await clases.regenerar(suyos.json);
            } finally {
                oir.escuchar = antes;
            }

            t.eq(salida.degradadas, 0, 'ninguna quedó degradada');
            t.eq(salida.sinLeer, 0);
            t.eq(sidecarDe(dir, r.secuencia).tomas[0].relectura, null,
                'y la marca se fue del archivo, que es donde estaba');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('una regeneración que tampoco pudo lo dice en vez de decir "releída"', async () => {
        // Contestar "1 toma releída" sobre una toma que no se pudo leer es la misma
        // pérdida silenciosa que todo esto vino a arreglar, con un botón de más.
        const dir = temporal();
        try {
            const r = await grabar(dir, { alReleer: () => null });
            const suyos = workspace.notasArchivos(dir, r.secuencia);

            const antes = oir.escuchar;
            oir.escuchar = async () => { throw muerto('codigo'); };
            let salida;
            try {
                salida = await clases.regenerar(suyos.json);
            } finally {
                oir.escuchar = antes;
            }

            t.eq(salida.tomas, 1);
            t.eq(salida.sinLeer, 1, 'la cuenta separa lo que no salió');
            t.eq(salida.sinAudio, 0, 'y no lo confunde con no tener audio');
            t.eq(sidecarDe(dir, r.secuencia).tomas[0].relectura.estado, 'sin-leer',
                'la marca queda puesta también acá');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.group('la toma que se quedó sin relectura · la espera de verdad');

    t.test('una señal se reintenta después de esperar, y "Terminar" la espera', async () => {
        // **La única prueba que paga los 4,25 s, y paga por dos cosas que ninguna
        // otra puede ver.** Una: que la espera de la política corra de verdad en el
        // camino de la app, sin el atajo que usan las pruebas de `insistir`. Dos:
        // que `cerrarSesion` espere ese reintento en vez de soltar la clase con la
        // toma a medio releer — que es exactamente la forma en que este arreglo
        // podría existir y no servir de nada.
        const dir = temporal();
        try {
            const arranque = Date.now();
            const { secuencia, veces } = await grabar(dir, {
                alReleer: vez => (vez === 1 ? muerto('senal') : null)
            });
            const tardo = Date.now() - arranque;

            t.eq(veces, 2, 'se insistió con el mismo modelo');
            t.ok(tardo >= insistir.ESPERA_MS,
                `esperó de verdad: ${tardo} ms contra los ${insistir.ESPERA_MS} de la política`);

            const toma = sidecarDe(dir, secuencia).tomas[0];
            t.eq(toma.relectura, null, 'el segundo intento salió con el modelo bueno: sin marca');
            t.ok(toma.palabras.length > 0, 'y la clase se cerró con la toma releída');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
};
