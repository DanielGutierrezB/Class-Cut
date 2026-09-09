'use strict';
/**
 * Qué hace la app cuando el sistema se lleva a whisper-cli en medio de una toma.
 *
 * El diagnóstico —distinguir un código de salida de una señal— está probado en
 * `tests/transcribe.test.js`. Acá está la política que se apoya en él: reintentar
 * esa toma sola, y si vuelve a fallar bajar de modelo, dejando dicho lo que pasó.
 *
 * Está en cuatro capas y cada una prueba una cosa que las otras no pueden:
 *
 * 1. **El criterio** (`engine/insistir.js`), que es puro: cuántos intentos y con
 *    qué espera, según cómo se murió. Sin audio y sin modelos.
 * 2. **El escalón de abajo** (`engine/paths.js`), donde está el hallazgo que
 *    define lo que "bajar de modelo" quiere decir en este proyecto: la lista de
 *    preferencia va de mejor a peor PARA TRANSCRIBIR, y su segundo renglón pesa
 *    el doble que el primero.
 * 3. **La política de punta a punta contra procesos que se mueren de verdad.** El
 *    whisper-cli de estas pruebas es un script que se manda un `kill -9` a sí
 *    mismo: la señal la entrega el sistema, el `close` de Node trae el `null` y
 *    el `'SIGKILL'` de verdad, y lo que se recorre es la cadena entera —
 *    `oir-toma` → `oir` → `transcribe` → un proceso muriéndose → la marca en la
 *    toma—. Con un `runWhisper` de mentira esto estaría probando la idea del
 *    fallo y no el fallo.
 * 4. **Un whisper-cli de VERDAD matado con SIGKILL desde afuera**, con el modelo
 *    grande de esta máquina, para que la distinción no dependa de que el script
 *    de arriba se parezca a él. Se saltea donde no haya modelo.
 *
 * Y la sesión de verdad contra disco —que la marca sobreviva a cerrar la app, y
 * que "Regenerar" la limpie— está en `tests/relectura-caida.test.js`, con el
 * motor entero y la oreja falseada, que es el patrón de esta zona.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const captura = require('../engine/captura');
const grabacion = require('../engine/grabacion');
const insistir = require('../engine/insistir');
const oirToma = require('../engine/oir-toma');
const paths = require('../engine/paths');
const transcribe = require('../engine/transcribe');

const TASA = 16000;

/* ─── El whisper-cli de mentira que se muere de verdad ────────────────────
 *
 * Recibe las mismas banderas que el de verdad y solo mira dos: `-m`, para anotar
 * con qué modelo lo llamaron, y `-of`, que es donde el de verdad deja el JSON.
 *
 * `MUERTES` dice cuántas de las primeras invocaciones tienen que morirse y cómo.
 * `kill -9 $$` es el proceso pidiéndole al sistema que lo mate: `code` llega en
 * null y `signal` en 'SIGKILL', que es exactamente lo que llegó de la corrida
 * real. `exit 3` es la otra salida, la que whisper.cpp usa para decir que no
 * puede con esto.
 */
function cliQueSeMuere(dir, muertes) {
    const script = path.join(dir, 'whisper-cli');
    const cuenta = path.join(dir, 'cuenta.txt');
    const diario = path.join(dir, 'llamadas.txt');

    fs.writeFileSync(script, `#!/bin/sh
n=0
[ -f "${cuenta}" ] && n=$(cat "${cuenta}")
n=$((n+1))
echo "$n" > "${cuenta}"

modelo=""
salida=""
while [ $# -gt 0 ]; do
    case "$1" in
        -m) modelo="$2"; shift 2 ;;
        -of) salida="$2"; shift 2 ;;
        *) shift ;;
    esac
done
echo "$(basename "$modelo")" >> "${diario}"

case "$n" in
${muertes.map((como, i) => `    ${i + 1}) ${como === 'senal'
        ? 'echo "ggml_metal_init: no se pudo reservar" >&2; kill -9 $$'
        : 'echo "error: no se pudo abrir el modelo" >&2; exit 3'} ;;`).join('\n')}
esac

cat > "\${salida}.json" <<'FIN'
{"transcription":[
  {"text":" Hoy","offsets":{"from":500,"to":900}},
  {"text":" vemos","offsets":{"from":1000,"to":1500}},
  {"text":" el","offsets":{"from":1600,"to":1800}},
  {"text":" ejercicio","offsets":{"from":1900,"to":2600}}
]}
FIN
exit 0
`);
    fs.chmodSync(script, 0o755);
    return {
        script,
        llamadas: () => (fs.existsSync(diario)
            ? fs.readFileSync(diario, 'utf8').trim().split('\n').filter(Boolean)
            : [])
    };
}

/**
 * Un WAV de verdad con una toma adentro, y la sesión de captura que lo describe.
 *
 * Se escribe con `captura`, que es lo que escribe el audio de una clase, y se lo
 * pasa a `oirToma.leer` tal como se lo pasa el motor: así el recorte con ffmpeg y
 * el reparto por los bordes son los de la app y no una maqueta.
 */
function conAudio(dir, segundos) {
    const abierta = captura.abrir({ dir, nombre: 'prueba', sampleRate: TASA, canales: 1, desdeMs: Date.now() });
    captura.escribir(abierta.id, Buffer.alloc(TASA * 2 * segundos));
    const cerrada = captura.cerrar(abierta.id, abierta.desdeMs + segundos * 1000);
    return {
        archivos: [cerrada],
        toma: {
            id: 1,
            inMs: cerrada.desdeMs + 1000,
            outMs: cerrada.desdeMs + (segundos - 1) * 1000,
            palabras: []
        }
    };
}

/**
 * Corre el cuerpo con el whisper-cli de mentira y los modelos que se le digan.
 *
 * Se reemplazan las tres preguntas que `paths` contesta y nada más: cuál es el
 * binario, cuál es el modelo grande y cuál es el escalón de abajo. Todo lo demás
 * —ffmpeg, el recorte, el reparto, el JSON— es el de la app. Y se devuelve lo que
 * había, que es la regla de esta suite: las pruebas corren en un proceso, y un
 * `paths` que quedara con un whisper de mentira puesto rompería las que vengan
 * después según el orden de `tests/run.js`.
 */
async function conCli(params, cuerpo) {
    const antes = {
        whisper: paths.whisper,
        whisperModel: paths.whisperModel,
        escalonDebajo: paths.escalonDebajo
    };
    const escalones = params.escalones || [];
    paths.whisper = () => ({ name: 'whisper-cli', path: params.script, source: 'prueba', searched: [] });
    paths.whisperModel = () => ({ path: `/no/importa/${params.bueno}`, name: params.bueno, source: 'prueba', searched: [] });
    paths.escalonDebajo = modelo => {
        const i = [params.bueno, ...escalones].indexOf(modelo.name);
        const abajo = i >= 0 ? escalones[i] : null;
        return abajo ? { name: abajo, path: `/no/importa/${abajo}`, bytes: 1000 - i } : null;
    };
    try {
        return await cuerpo();
    } finally {
        Object.assign(paths, antes);
    }
}

/** Un WAV mínimo que whisper-cli pueda abrir, para el intento contra el de verdad. */
function wavCorto(dir, segundos) {
    const archivo = path.join(dir, 'corto.wav');
    const datos = Buffer.alloc(16000 * 2 * segundos);
    fs.writeFileSync(archivo, Buffer.concat([captura.cabecera(datos.length, 16000, 1), datos]));
    return archivo;
}

module.exports = async t => {
    t.group('insistir · cuántos intentos y con qué espera');

    t.test('una señal se insiste UNA vez, con el mismo modelo', () => {
        // Ese único reintento pone a prueba una hipótesis falsable: que lo que lo
        // mató fue la competencia por la memoria con el Whisper de las señales, y
        // que ya pasó.
        t.deep(insistir.queHacer({ muerte: 'senal', conElBueno: true, yaInsistio: false, hayEscalon: true }),
            { que: 'insistir', esperaMs: insistir.ESPERA_MS });
    });

    t.test('y no dos: el segundo intento ya baja de modelo', () => {
        // Si esperar un ciclo entero no alcanzó, esperar otro tampoco va a
        // alcanzar. Lo que cambia las probabilidades es bajar los pesos.
        t.deep(insistir.queHacer({ muerte: 'senal', conElBueno: true, yaInsistio: true, hayEscalon: true }),
            { que: 'bajar', esperaMs: 0 });
    });

    t.test('un código no se reintenta nunca con el mismo modelo', () => {
        // whisper.cpp es determinista: mismo binario, mismo audio, mismo modelo,
        // misma respuesta. Repetirlo cuesta una pasada del modelo grande en la
        // fila que decide dónde arrancan las tomas siguientes y compra nada.
        t.deep(insistir.queHacer({ muerte: 'codigo', conElBueno: true, yaInsistio: false, hayEscalon: true }),
            { que: 'bajar', esperaMs: 0 });
    });

    t.test('un escalón que se muere se cambia por el siguiente, sin insistir', () => {
        // Una vez que la máquina demostró que no aguanta este modelo, cada escalón
        // es una hipótesis nueva y se le da un intento. Insistir dos veces con el
        // mismo liviano sería volver a probar lo que ya se probó.
        t.deep(insistir.queHacer({ muerte: 'senal', conElBueno: false, yaInsistio: false, hayEscalon: true }),
            { que: 'bajar', esperaMs: 0 });
    });

    t.test('sin ningún modelo más liviano se rinde, y eso es un resultado', () => {
        for (const muerte of ['senal', 'codigo']) {
            t.deep(insistir.queHacer({ muerte, conElBueno: true, yaInsistio: true, hayEscalon: false }),
                { que: 'rendirse', esperaMs: 0 }, muerte);
        }
    });

    t.test('lo que no llegó a correr se rinde sin gastar tres intentos', () => {
        // Falta el binario, falta el modelo, el `spawn` se cayó: no hay hipótesis
        // que probar y ningún modelo lo arregla. Es de configuración, y quien lo
        // dice es Diagnóstico.
        t.deep(insistir.queHacer({ muerte: null, conElBueno: true, yaInsistio: false, hayEscalon: true }),
            { que: 'rendirse', esperaMs: 0 });
    });

    t.test('la espera sale del ciclo de señales y no de un número elegido', () => {
        // **Esta prueba es la que ata los dos números.** La espera tiene que caer
        // AFUERA del pico de memoria del Whisper de las señales, que aparece cada
        // `CICLO_MS` y dura una pasada: un período entero más una pasada es el
        // mínimo que garantiza no volver a caer dentro de la misma ventana
        // ocupada. `insistir` se copia los dos números para no cerrar el círculo
        // de requires, así que si alguien cambia el ciclo de la grabación esto se
        // pone en rojo en vez de dejar la espera apuntando a un ritmo que ya no es.
        t.eq(insistir.CICLO_MS, grabacion.CICLO_MS, 'el ciclo de señales es el de `grabacion.js`');
        t.eq(insistir.ESPERA_MS, insistir.CICLO_MS + insistir.PASADA_MS);
        t.ok(insistir.ESPERA_MS > grabacion.CICLO_MS,
            `${insistir.ESPERA_MS} ms tiene que pasar el período entero de ${grabacion.CICLO_MS} ms`);
        t.ok(insistir.ESPERA_MS < 10000,
            `${insistir.ESPERA_MS} ms: más que esto atrasa la fila que decide dónde arrancan las tomas`);
    });

    t.group('insistir · qué quiere decir "bajar de modelo"');

    t.test('el escalón de abajo va por PESO, no por la lista de preferencia', () => {
        // **El hallazgo entero de esta zona, con los dos modelos que hay en esta
        // Mac y sus tamaños de verdad.** `MODEL_PREFERENCE` está ordenada de mejor
        // a peor para transcribir, y `large-v3-turbo` la encabeza porque da la
        // misma calidad mucho más rápido. El que le sigue en esa lista, `large-v3`,
        // pesa el doble. Así que bajar por la lista sería pedirle a una máquina que
        // acaba de quedarse sin memoria que cargue 2,9 GB en vez de 1,5.
        const instalados = [
            { name: 'ggml-large-v3.bin', bytes: 3095033483 },
            { name: 'ggml-large-v3-turbo.bin', bytes: 1624555275 }
        ];
        t.eq(paths.MODEL_PREFERENCE.indexOf('ggml-large-v3.bin'),
            paths.MODEL_PREFERENCE.indexOf('ggml-large-v3-turbo.bin') + 1,
            'en la preferencia, large-v3 es el renglón siguiente al turbo');
        t.eq(paths.elDeAbajo(instalados[1], instalados), null,
            'y aun así no es el escalón de abajo: pesa el doble');
    });

    t.test('con varios más chicos se baja UN escalón y no al sótano', () => {
        // Bajar hasta el más chico de una vez sería pagar de entrada toda la
        // pérdida de calidad para resolver algo que puede ceder con la mitad.
        const instalados = [
            { name: 'ggml-large-v3-turbo.bin', bytes: 1624555275 },
            { name: 'ggml-medium.bin', bytes: 1533763059 },
            { name: 'ggml-base.bin', bytes: 147951465 }
        ];
        t.eq(paths.elDeAbajo(instalados[0], instalados).name, 'ggml-medium.bin');
        t.eq(paths.elDeAbajo(instalados[1], instalados).name, 'ggml-base.bin', 'y del medium, el base');
        t.eq(paths.elDeAbajo(instalados[2], instalados), null, 'del más chico no se baja a ninguna parte');
    });

    t.test('un modelo que no se sabe cuánto pesa no tiene escalón', () => {
        // No es lo mismo que no haber ninguno más liviano, pero se contesta igual:
        // sin saber de qué peso se baja, no se puede decir qué pesa menos.
        t.eq(paths.elDeAbajo(null, []), null);
        t.eq(paths.elDeAbajo({ name: 'ggml-x.bin' }, [{ name: 'ggml-base.bin', bytes: 10 }]), null);
    });

    t.test('en el disco de esta máquina, lo que devuelva pesa menos de verdad', () => {
        // La invariante y no el resultado: cuál es el escalón depende de qué haya
        // instalado, y una prueba que nombrara un modelo se pondría en rojo el día
        // que alguien baje otro. Lo que no puede pasar nunca es que ofrezca uno más
        // pesado, que es el error que esto vino a evitar.
        const instalados = paths.modelosInstalados();
        t.ok(Array.isArray(instalados), 'la lista se lee del disco');
        for (const modelo of instalados) {
            t.ok(modelo.bytes > 0, `${modelo.name} tiene peso: ${modelo.bytes}`);
            t.ok(!/silero|vad/i.test(modelo.name), `${modelo.name} no es el modelo de VAD`);
            const abajo = paths.escalonDebajo(modelo);
            if (abajo) {
                t.ok(abajo.bytes < modelo.bytes,
                    `${abajo.name} (${abajo.bytes}) tiene que pesar menos que ${modelo.name} (${modelo.bytes})`);
            }
        }
    });

    t.group('insistir · contra procesos que se mueren de verdad');

    t.test('una señal y el segundo intento sale: la toma queda sin marca', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-'));
        try {
            const cli = cliQueSeMuere(dir, ['senal']);
            const { archivos, toma } = conAudio(dir, 30);
            const leido = await conCli(
                { script: cli.script, bueno: 'ggml-large-v3-turbo.bin', escalones: ['ggml-base.bin'] },
                () => oirToma.leer(archivos, toma, { esperaMs: 5 }));

            t.eq(cli.llamadas().length, 2, 'se llamó dos veces');
            t.deep(cli.llamadas(), ['ggml-large-v3-turbo.bin', 'ggml-large-v3-turbo.bin'],
                'las dos con el modelo bueno: insistir es insistir, no bajar');
            t.ok(leido.palabras.length > 0, 'la toma salió con texto');
            t.eq(leido.relectura, null, 'y sin marca: salió con el modelo que correspondía');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('dos señales: baja de modelo y la toma queda marcada «degradada»', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-'));
        try {
            const cli = cliQueSeMuere(dir, ['senal', 'senal']);
            const { archivos, toma } = conAudio(dir, 30);
            const leido = await conCli(
                { script: cli.script, bueno: 'ggml-large-v3-turbo.bin', escalones: ['ggml-base.bin'] },
                () => oirToma.leer(archivos, toma, { esperaMs: 5 }));

            t.deep(cli.llamadas(),
                ['ggml-large-v3-turbo.bin', 'ggml-large-v3-turbo.bin', 'ggml-base.bin'],
                'el bueno, el bueno otra vez, y recién ahí el escalón de abajo');
            t.ok(leido.palabras.length > 0, 'la toma tiene texto, que es el punto de bajar');
            t.eq(leido.relectura.estado, 'degradada');
            t.eq(leido.relectura.modelo, 'ggml-base.bin', 'con qué salió');
            t.eq(leido.relectura.bueno, 'ggml-large-v3-turbo.bin', 'y con qué se la quería leer');
            t.ok(/SIGKILL/.test(leido.relectura.detalle),
                `el detalle guarda cómo se murió: «${leido.relectura.detalle}»`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('un código baja de modelo en el acto, sin gastar el reintento', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-'));
        try {
            const cli = cliQueSeMuere(dir, ['codigo']);
            const { archivos, toma } = conAudio(dir, 30);
            const leido = await conCli(
                { script: cli.script, bueno: 'ggml-large-v3-turbo.bin', escalones: ['ggml-base.bin'] },
                () => oirToma.leer(archivos, toma, { esperaMs: 5 }));

            t.deep(cli.llamadas(), ['ggml-large-v3-turbo.bin', 'ggml-base.bin'],
                'dos llamadas y no tres: la del bueno no se repite');
            t.eq(leido.relectura.estado, 'degradada');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('si falla hasta el más chico, la toma queda «sin-leer» y regenerable', async () => {
        // El peor caso, que es el que hay que dejar dicho: la clase ya se grabó y
        // no se vuelve a dar, así que el silencio es exactamente lo que no puede
        // pasar. La toma vuelve sin palabras —quien la pidió se queda con el texto
        // del ciclo de señales— y con la marca que dice que ese texto no es el bueno.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-'));
        try {
            const cli = cliQueSeMuere(dir, ['senal', 'senal', 'senal', 'senal']);
            const { archivos, toma } = conAudio(dir, 30);
            const leido = await conCli(
                { script: cli.script, bueno: 'ggml-large-v3-turbo.bin', escalones: ['ggml-medium.bin', 'ggml-base.bin'] },
                () => oirToma.leer(archivos, toma, { esperaMs: 5 }));

            t.deep(cli.llamadas(), [
                'ggml-large-v3-turbo.bin', 'ggml-large-v3-turbo.bin',
                'ggml-medium.bin', 'ggml-base.bin'
            ], 'dos con el bueno y una por escalón: un intento por hipótesis');
            t.eq(leido.palabras, undefined, 'sin palabras nuevas');
            t.eq(leido.relectura.estado, 'sin-leer');
            t.ok(/Regenerar/.test(leido.relectura.porque),
                `el aviso dice cómo salir de esto: «${leido.relectura.porque}»`);
            t.ok(/ggml-base\.bin/.test(leido.relectura.porque), 'y hasta dónde se bajó');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('sin ningún escalón se rinde en dos intentos y no en cinco', async () => {
        // Es el caso de esta Mac, donde `escalonDebajo` del modelo grande es null.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-'));
        try {
            const cli = cliQueSeMuere(dir, ['senal', 'senal']);
            const { archivos, toma } = conAudio(dir, 30);
            const leido = await conCli(
                { script: cli.script, bueno: 'ggml-large-v3-turbo.bin', escalones: [] },
                () => oirToma.leer(archivos, toma, { esperaMs: 5 }));

            t.eq(cli.llamadas().length, 2, 'el bueno y el reintento, y se acabó');
            t.eq(leido.relectura.estado, 'sin-leer');
            t.ok(/ningún modelo más liviano/.test(leido.relectura.porque),
                `y lo dice: «${leido.relectura.porque}»`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.group('insistir · un whisper-cli de verdad, matado de verdad');

    const whisper = paths.whisper();
    const modelo = paths.whisperModel();
    if (!whisper.path || !modelo.path) {
        t.skip('matar el whisper-cli de verdad', 'falta el binario o el modelo en esta máquina');
    } else {
        t.test('matar el whisper-cli de verdad se lee como señal y no como «código null»', async () => {
            // **La diferencia entre probar la idea del fallo y probar el fallo.** Lo
            // de arriba corre contra un script; esto levanta el whisper-cli que la
            // app usa, con el modelo grande de esta Mac, y le manda un SIGKILL
            // desde afuera mientras carga los pesos — que es lo que hace el sistema
            // cuando se queda sin memoria. Lo que se comprueba es que `close`
            // llegue con `code` en null y el motivo entero en `signal`, y que eso
            // salga del error como un dato y no como una frase.
            //
            // Se mata solo a los hijos DIRECTOS de este proceso (`pgrep -P`) y no
            // por nombre: un `pkill whisper-cli` se llevaría el de una grabación
            // que el editor tuviera andando en otra ventana.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insistir-real-'));
            try {
                const corriendo = transcribe.runWhisper(wavCorto(dir, 20), { language: 'es' });
                let matado = null;
                for (let n = 0; n < 100 && !matado; n++) {
                    await new Promise(r => setTimeout(r, 50));
                    const hijos = spawnSync('/usr/bin/pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
                    for (const pid of String(hijos.stdout || '').trim().split('\n').filter(Boolean)) {
                        const quien = spawnSync('/bin/ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8' });
                        if (!/whisper-cli/.test(String(quien.stdout || ''))) continue;
                        process.kill(Number(pid), 'SIGKILL');
                        matado = pid;
                    }
                }
                t.ok(matado, 'se encontró el whisper-cli hijo y se lo mató');

                let err = null;
                try { await corriendo; } catch (e) { err = e; }
                t.ok(err, 'la promesa tiene que romperse');
                t.eq(err.code, 'whisper');
                t.eq(err.muerte.como, 'senal', `llegó ${JSON.stringify(err.muerte)}`);
                t.eq(err.muerte.senal, 'SIGKILL');
                t.eq(err.muerte.codigo, null, 'y el código no se inventa');
                t.ok(/SIGKILL/.test(err.message), `el mensaje también lo dice: «${err.message}»`);
                // Y con eso la política decide lo que tiene que decidir.
                t.eq(insistir.comoSeMurio(err), 'senal');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
};
