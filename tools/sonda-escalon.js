'use strict';
/**
 * tools/sonda-escalon.js — Bajar de modelo, con los modelos de verdad.
 *
 * **El hueco que esto viene a tapar.** La política de `engine/insistir.js` está
 * probada de punta a punta, pero contra un whisper-cli que es un script de shell
 * (`tests/insistir.test.js`) y contra una oreja falseada
 * (`tests/relectura-caida.test.js`). Las dos prueban la decisión; ninguna puede
 * probar lo único que justifica la decisión: **que el modelo de abajo se levante
 * de verdad y escriba algo que se pueda leer.** Y no podían: hasta que se bajó
 * `ggml-small.bin` no había en esta Mac ningún modelo más liviano que el grande,
 * así que `paths.escalonDebajo` contestaba null y la rama no se podía disparar.
 *
 * Acá se dispara. El binario es el de la app, los modelos son los dos que hay en
 * el disco, el audio es un pedazo del Live-Mix de una clase de verdad y la muerte
 * la entrega el sistema.
 *
 * **Cómo se mata, y por qué así.** No se falsea nada: un vigía mira cada 25 ms
 * los hijos DIRECTOS de este proceso, le pregunta a `ps` con qué argumentos
 * arrancó cada uno, y le manda un SIGKILL a los que traen `-m <el modelo
 * grande>`. A los que traen el chico los deja vivir. Es lo mismo que hace el
 * sistema cuando se queda sin memoria —se lleva al que más pesa— y es el mismo
 * mecanismo con el que se OBSERVA la bajada: el vigía ve pasar cada invocación
 * con su modelo, así que la cadena de intentos no hace falta deducirla de nada ni
 * hay que parchear una sola función del motor.
 *
 * Se mira a los hijos por pid y no `pkill whisper-cli`, por lo mismo que la
 * prueba de la que sale esta idea: un pkill se llevaría el whisper-cli de una
 * grabación que el editor tuviera andando en otra ventana.
 *
 * **Es de solo lectura sobre el material.** El Live-Mix se abre para leer un
 * pedazo y nada más; todo lo que se escribe va a una carpeta temporal que se
 * borra al final.
 *
 *   node tools/sonda-escalon.js
 *   node tools/sonda-escalon.js --desde=2100 --dur=60 --rapido
 *
 *   --wav=<ruta>    el Live-Mix a leer (por omisión, la clase 02 del curso)
 *   --desde=<seg>   dónde empieza el pedazo que se lee
 *   --dur=<seg>     cuánto dura el pedazo
 *   --rapido        no paga los 4,25 s de la espera razonada
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const captura = require('../engine/captura');
const insistir = require('../engine/insistir');
const oirToma = require('../engine/oir-toma');
const paths = require('../engine/paths');

const RAIZ = path.join(__dirname, '..');
const TASA = 16000;

/** El mismo Live-Mix que usa `tools/probar-vivo.js`: la clase con claqueta y tomas. */
const WAV_POR_OMISION = path.join(os.homedir(), 'Movies', 'CUR',
    '2026_curso-spec-driven-development', 'Day_1 RODECASTER_Video',
    'Clase 02 - Default_2026-08-18_2_13-56-35', 'Audio', 'Live-Mix.wav');

function bandera(nombre, porOmision) {
    const hit = process.argv.find(a => a.startsWith(`--${nombre}=`));
    return hit ? hit.slice(nombre.length + 3) : porOmision;
}

const hay = nombre => process.argv.includes(`--${nombre}`);

/* ─── El material ─────────────────────────────────────────────────────── */

/**
 * Un pedazo del Live-Mix metido en una sesión de captura de verdad.
 *
 * Se escribe con `captura`, que es lo que escribe el audio de una clase, así que
 * el recorte con ffmpeg y el reparto por los bordes que vienen después son los
 * de la app y no una maqueta. El WAV del usuario se abre para leer y nada más.
 */
function sesionConAudio(dir, wav, desdeSec, durSec) {
    const pcm = path.join(dir, 'pedazo.raw');
    const ffmpeg = path.join(RAIZ, 'bin', 'mac', 'ffmpeg');
    const r = spawnSync(ffmpeg, [
        '-v', 'error', '-y', '-ss', String(desdeSec), '-t', String(durSec), '-i', wav,
        '-ar', String(TASA), '-ac', '1', '-f', 's16le', pcm
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg falló: ${r.stderr}`);

    const abierta = captura.abrir({
        dir, nombre: 'sonda', sampleRate: TASA, canales: 1, desdeMs: Date.now()
    });
    captura.escribir(abierta.id, fs.readFileSync(pcm));
    const cerrada = captura.cerrar(abierta.id, abierta.desdeMs + durSec * 1000);
    fs.rmSync(pcm, { force: true });

    // La toma con lugar para las dos orillas de 12 s que `oir-toma` pide a los
    // costados: así el tramo que se lee es el que leería una toma de una clase.
    const borde = oirToma.ORILLA_MS + 2000;
    return {
        archivos: [cerrada],
        toma: {
            id: 1,
            inMs: cerrada.desdeMs + borde,
            outMs: cerrada.desdeMs + durSec * 1000 - borde,
            palabras: []
        }
    };
}

/* ─── El vigía que mata al grande y mira pasar a los demás ────────────── */

function hijosWhisper() {
    const pgrep = spawnSync('/usr/bin/pgrep', ['-P', String(process.pid)], { encoding: 'utf8' });
    const pids = String(pgrep.stdout || '').trim().split('\n').filter(Boolean);
    const vistos = [];
    for (const pid of pids) {
        const ps = spawnSync('/bin/ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' });
        const args = String(ps.stdout || '').trim();
        if (!/whisper-cli/.test(args)) continue;
        const m = args.match(/-m\s+(\S+)/);
        vistos.push({ pid: Number(pid), modelo: m ? path.basename(m[1]) : '?' });
    }
    return vistos;
}

/**
 * Arranca el vigía. Devuelve cómo pararlo y el diario de lo que vio.
 *
 * @param {string|null} aMatar nombre del modelo cuyas pasadas se matan; null mira sin matar
 */
function vigilar(aMatar) {
    const diario = [];
    const conocidos = new Set();
    const reloj = setInterval(() => {
        for (const hijo of hijosWhisper()) {
            if (!conocidos.has(hijo.pid)) {
                conocidos.add(hijo.pid);
                diario.push({ ...hijo, matado: false });
            }
            if (aMatar && hijo.modelo === aMatar) {
                try { process.kill(hijo.pid, 'SIGKILL'); } catch (e) { /* ya se fue */ }
                const suyo = diario.find(d => d.pid === hijo.pid);
                if (suyo) suyo.matado = true;
            }
        }
    }, 25);
    return { parar: () => clearInterval(reloj), diario };
}

/* ─── Comparar los dos textos ─────────────────────────────────────────── */

const tokens = palabras => (palabras || [])
    .map(p => String(p.texto || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ]/g, ''))
    .filter(Boolean);

/** Distancia de edición entre las dos listas de palabras, o sea el WER crudo. */
function distancia(a, b) {
    let fila = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const nueva = [i];
        for (let j = 1; j <= b.length; j++) {
            nueva[j] = a[i - 1] === b[j - 1]
                ? fila[j - 1]
                : 1 + Math.min(fila[j - 1], fila[j], nueva[j - 1]);
        }
        fila = nueva;
    }
    return fila[b.length];
}

const texto = palabras => (palabras || []).map(p => p.texto).join('').trim();

/* ─── El recorrido ────────────────────────────────────────────────────── */

async function main() {
    const wav = bandera('wav', WAV_POR_OMISION);
    const desdeSec = Number(bandera('desde', 900));
    const durSec = Number(bandera('dur', 60));
    const esperaMs = hay('rapido') ? 10 : insistir.ESPERA_MS;

    const grande = paths.whisperModel();
    const abajo = paths.escalonDebajo(grande);
    const mb = b => `${Math.round(b / 1e6)} MB`;

    console.log('Bajar de modelo, con los modelos de verdad');
    console.log(`  binario     ${paths.whisper().path}`);
    console.log(`  grande      ${grande.name}`);
    console.log(`  escalón     ${abajo ? `${abajo.name} · ${mb(abajo.bytes)}` : 'NINGUNO'}`);
    console.log(`  material    ${wav}`);
    console.log(`  pedazo      ${desdeSec} s → ${desdeSec + durSec} s (solo lectura)`);
    if (!abajo) {
        console.log('\nSin escalón de abajo no hay nada que ejercitar. Bajá un modelo más liviano.');
        process.exit(1);
    }
    if (!fs.existsSync(wav)) {
        console.log('\nNo está el Live-Mix. Pasale otro con --wav=');
        process.exit(1);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sonda-escalon-'));
    try {
        const { archivos, toma } = sesionConAudio(dir, wav, desdeSec, durSec);

        // 1. La referencia: la misma toma leída como sale una clase sana. Sin esto
        //    "el chico escribió algo" no se puede comparar contra nada.
        console.log(`\n── 1. Con ${grande.name}, sin nadie molestando ──`);
        const mirando = vigilar(null);
        const arranqueBueno = Date.now();
        let bueno;
        try {
            bueno = await oirToma.leer(archivos, { ...toma }, { esperaMs });
        } finally {
            mirando.parar();
        }
        const tardoBueno = Date.now() - arranqueBueno;
        console.log(`  pasadas     ${mirando.diario.map(d => d.modelo).join(', ')}`);
        console.log(`  palabras    ${(bueno.palabras || []).length} · ${tardoBueno} ms`);
        console.log(`  relectura   ${JSON.stringify(bueno.relectura)}`);
        console.log(`  «${texto(bueno.palabras)}»`);

        // 2. Y ahora el sistema se lo lleva por delante, dos veces, que es lo que
        //    hace falta para que la política deje de insistir y baje.
        console.log(`\n── 2. Con el sistema matando cada pasada de ${grande.name} ──`);
        const verdugo = vigilar(grande.name);
        const arranqueMalo = Date.now();
        let degradado;
        try {
            degradado = await oirToma.leer(archivos, { ...toma }, { esperaMs });
        } finally {
            verdugo.parar();
        }
        const tardoMalo = Date.now() - arranqueMalo;
        for (const d of verdugo.diario) {
            console.log(`  pasada      ${d.modelo}${d.matado ? '  ← SIGKILL' : '  ← vivió'}`);
        }
        console.log(`  palabras    ${(degradado.palabras || []).length} · ${tardoMalo} ms`);
        console.log(`  relectura   ${degradado.relectura && degradado.relectura.estado}` +
            ` · modelo=${degradado.relectura && degradado.relectura.modelo}` +
            ` · bueno=${degradado.relectura && degradado.relectura.bueno}`);
        console.log(`  detalle     ${degradado.relectura && degradado.relectura.detalle}`);
        console.log(`  «${texto(degradado.palabras)}»`);

        // 3. Qué tan malo es el texto del escalón. Es el número que decide si el
        //    escalón sirve o solamente evita el silencio.
        const a = tokens(bueno.palabras);
        const b = tokens(degradado.palabras);
        const errores = distancia(a, b);
        console.log('\n── 3. Qué tan peor es el texto del escalón ──');
        console.log(`  ${grande.name}: ${a.length} palabras`);
        console.log(`  ${degradado.relectura ? degradado.relectura.modelo : '?'}: ${b.length} palabras`);
        console.log(`  distancia de edición ${errores} sobre ${a.length}` +
            ` = ${(100 * errores / Math.max(1, a.length)).toFixed(0)}% de palabras distintas`);

        // 4. Y las dos cosas que el escalón tiene que cumplir para servir de algo.
        console.log('\n── 4. Lo que tenía que quedar comprobado ──');
        const dicho = [
            [Boolean(bueno.palabras && bueno.palabras.length),
                'el modelo grande lee esta toma cuando lo dejan'],
            [verdugo.diario.filter(d => d.matado).length >= 2,
                'el sistema se llevó por delante dos pasadas del grande, de verdad'],
            [verdugo.diario.some(d => d.modelo === abajo.name && !d.matado),
                `${abajo.name} se levantó y corrió con el binario de la app`],
            [Boolean(degradado.palabras && degradado.palabras.length),
                'la toma salió CON TEXTO en vez de quedarse en silencio'],
            [degradado.relectura && degradado.relectura.estado === 'degradada',
                'y queda marcada «degradada», que es lo que "Regenerar" arregla'],
            [degradado.relectura && degradado.relectura.modelo === abajo.name,
                'con el nombre del modelo con el que salió']
        ];
        for (const [ok, que] of dicho) console.log(`  ${ok ? '✓' : '✗'} ${que}`);
        process.exitCode = dicho.every(([ok]) => ok) ? 0 : 1;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
