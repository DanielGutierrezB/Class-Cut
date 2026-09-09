'use strict';
/**
 * probar-vivo.js — El recorrido de la toma de notas, en la app de verdad y con
 * audio de una clase de verdad.
 *
 *   node tools/probar-vivo.js
 *   node tools/probar-vivo.js --wav=<Live-Mix.wav> --minutos=4 --capturas=/tmp/cc-vivo
 *   node tools/probar-vivo.js --ritmo=1000   (tiempo real: tarda lo que dura la clase)
 *
 * Qué prueba, y por qué hacía falta otro arnés. `probar-repintado.js` y
 * `probar-lista.js` corren contra la MAQUETA: datos de mentira, sin motor y sin
 * Whisper. Sirven para lo que son —que la pantalla dibuje lo que se le da— y no
 * pueden ver nada de lo que pasa cuando el estado no lo escribe un archivo de
 * ejemplo sino el motor oyendo una clase. `simular-grabacion.js` es el otro
 * extremo: el motor entero con audio real, y sin una sola pantalla.
 *
 * Esto es el medio, que es donde estaba el agujero: **la ventana de verdad, el
 * motor de verdad, Whisper de verdad y el Live-Mix de una clase de verdad**, con
 * el audio entrando por el mismo puente por el que lo manda el micrófono
 * (`window.cc.grabarPcm`). Las tomas que aparecen en pantalla las abrió un "tres,
 * dos, uno" que alguien dijo de verdad, y lo que se comprueba después de cada
 * gesto es que la pantalla y el motor digan lo mismo.
 *
 * **Lo que NO prueba, y no puede.** El micrófono. `oido.js` pide el dispositivo
 * con `getUserMedia`, lo pasa por un `AudioWorklet` y de ahí salen los pedazos;
 * sin una entrada enchufada y sin nadie hablando, esa mitad no existe. Así que el
 * recorrido abre la sesión por el canal que abre "Iniciar grabación"
 * (`grabarIniciar`) y le mete los pedazos por donde los mete el worklet, y todo lo
 * que hay de ahí para adentro es el de la app. Que el dispositivo se abra, que se
 * caiga y se recupere, y que el medidor se mueva, sigue siendo de una persona con
 * un Rodecaster: no se sustituye por algo parecido acá.
 *
 * **Nada del usuario se toca.** La app guarda la carpeta de notas en
 * `~/Library/Application Support`, así que la ventana corre con un `HOME` propio
 * en un temporal: los ajustes de quien esté usando la Mac quedan intactos y la
 * clase cae en una carpeta que se tira al terminar. De paso eso deja el proveedor
 * de IA en 'local', que es la única configuración en la que se puede ver de
 * verdad la abstención por GPU ocupada (`engine/gpu.js`).
 *
 * **El umbral de parecido del empalme, medido acá.** El 0,5 de
 * `empalme.PARECIDO_PARA_PREGUNTAR` se había elegido con cinco empalmes escritos a
 * mano. Con las tomas que deja este arnés —Whisper de verdad sobre cuatro minutos
 * de la clase 02, que es material con retomas— los parecidos de los bordes caen en
 * dos montones separados: los empalmes que no repiten nada dan 0 · 0,167 · 0,333 y
 * las retomas dan 0,6 · 0,8 · 0,833 · 1. El umbral queda en el hueco. El caso
 * justo en 0,50 existe y es una retoma de verdad —el profesor se traba, dice «qué
 * pena, perdón, ok, ya» y arranca el tema de nuevo—, así que preguntar ahí está
 * bien aunque el empalme no tenga nada que recortar: una toma que se rehace entera
 * es de `repiteA` y no de acá. Es UNA clase, no una muestra; lo que se puede decir
 * con esto es que el umbral no está partiendo un montón al medio.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const TASA = 48000;
/** El mismo tamaño de pedazo que manda el worklet de la ventana. */
const MUESTRAS_POR_PEDAZO = 4096;

const dormir = ms => new Promise(r => setTimeout(r, ms));

/* ─── Del lado de Node: el material y la ventana ─────────────────────────── */

/** El Live-Mix de la clase 02 del curso, que es el que tiene claqueta y tomas. */
const WAV_POR_OMISION = path.join(os.homedir(), 'Movies', 'CUR',
    '2026_curso-spec-driven-development', 'Day_1 RODECASTER_Video',
    'Clase 02 - Default_2026-08-18_2_13-56-35', 'Audio', 'Live-Mix.wav');

function bandera(nombre, porOmision) {
    const hit = process.argv.find(a => a.startsWith(`--${nombre}=`));
    return hit ? hit.slice(nombre.length + 3) : porOmision;
}

/**
 * El WAV pasado a lo que manda la captura: 16 bits, mono, a la tasa de la ventana.
 *
 * Se convierte acá y no en la ventana porque la ventana no tiene ffmpeg ni disco,
 * y porque el recorrido tiene que poder empujar el audio más rápido que el reloj:
 * los tiempos del motor salen de la posición en el audio y no de `Date.now()`, así
 * que cuatro minutos de clase entran en menos de un minuto de arnés.
 */
function aPcm(wav, segundos, destino) {
    const ffmpeg = path.join(RAIZ, 'bin', 'mac', 'ffmpeg');
    const r = spawnSync(ffmpeg, [
        '-v', 'error', '-y', '-i', wav, '-t', String(segundos),
        '-ar', String(TASA), '-ac', '1', '-f', 's16le', destino
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg falló: ${r.stderr}`);
    return destino;
}

async function enNode() {
    const wav = bandera('wav', WAV_POR_OMISION);
    const minutos = Number(bandera('minutos', '4'));
    if (!fs.existsSync(wav)) {
        console.error(`No está el audio: ${wav}\nPasale otro con --wav=`);
        process.exit(1);
    }

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vivo-'));
    const casa = path.join(base, 'home');
    const notas = path.join(base, 'notas');
    fs.mkdirSync(path.join(casa, 'Library', 'Application Support', 'Class Cut'), { recursive: true });
    fs.mkdirSync(notas, { recursive: true });

    // La carpeta de notas queda elegida de antemano, y eso es a propósito:
    // "Elegir carpeta…" abre la hoja del sistema, que no se puede manejar desde
    // afuera. Lo que se prueba acá es lo que pasa DESPUÉS de tener una carpeta.
    fs.writeFileSync(
        path.join(casa, 'Library', 'Application Support', 'Class Cut', 'ajustes.json'),
        `${JSON.stringify({ version: 1, notasDir: notas, notasDirs: [notas] }, null, 2)}\n`);

    console.log(`Audio:    ${wav}`);
    console.log(`Minutos:  ${minutos}`);
    console.log(`Carpeta:  ${notas}`);
    console.log(`HOME:     ${casa}\n`);
    console.log('Convirtiendo el audio…');
    const raw = aPcm(wav, minutos * 60, path.join(base, 'in.raw'));
    console.log(`  ${(fs.statSync(raw).size / 2 / TASA).toFixed(0)}s de PCM\n`);

    const env = { ...process.env, HOME: casa };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = require('electron');
    const ventana = spawn(electron, [
        RAIZ,
        `--guion=${__filename}`,
        `--raw=${raw}`,
        `--notas=${notas}`,
        ...process.argv.slice(2)
    ], { cwd: RAIZ, stdio: 'inherit', env });

    process.on('SIGINT', () => { ventana.kill(); process.exit(130); });
    ventana.on('exit', codigo => {
        // El temporal queda: adentro está el XML que se acaba de escribir, que es
        // justo lo que se va a querer mirar cuando algo salga en rojo.
        console.log(`\nLo que quedó: ${base}`);
        process.exit(codigo == null ? 1 : codigo);
    });
}

/* ─── Adentro de la ventana: mirar, tocar y preguntar ────────────────────── */

const mirar = (wc, js) => wc.executeJavaScript(js);

async function donde(wc, sel) {
    const caja = await mirar(wc, `(() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(Math.min(Math.max(r.top + 12, r.top + r.height / 2), r.bottom - 4));
        return { x, y, dentro: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight };
    })()`);
    if (!caja) throw new Error(`no hay ningún «${sel}» en la pantalla`);
    // Alcanza con que el punto donde se va a hacer clic esté en la ventana, y no
    // con que entre el elemento entero: una tarjeta de toma con veinte renglones
    // de texto es más alta que la pantalla, y pedirla completa dejaba sin poder
    // tocar justamente las tomas largas, que son las que interesan.
    if (!caja.dentro) throw new Error(`«${sel}» quedó fuera de la ventana: agrandá --size`);
    await dormir(60);
    return caja;
}

/** Un clic del mouse, que es el que mueve el foco: ver `probar-repintado.js`. */
async function clic(wc, sel) {
    const { x, y } = await donde(wc, sel);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await dormir(180);
}

async function tecla(wc, k) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    await dormir(120);
}

async function escribir(wc, texto) {
    for (const letra of texto) await tecla(wc, letra);
}

/**
 * Se atajan los carteles del sistema, que bloquean.
 *
 * "Terminar" pregunta por `window.cc.confirmar`, que es una hoja del proceso
 * principal: desde acá no hay forma de contestarla, así que sin esto el recorrido
 * se cuelga en el último paso. Se reemplaza el manejador y se anota qué se
 * preguntó, que además es lo que hace falta comprobar.
 */
function atajarCarteles(ipcMain) {
    const preguntas = [];
    for (const canal of ['confirmar', 'preguntar']) {
        ipcMain.removeHandler(canal);
        ipcMain.handle(canal, (event, payload) => {
            preguntas.push({ canal, titulo: (payload && payload.titulo) || '' });
            return canal === 'confirmar' ? true : 0;
        });
    }
    return preguntas;
}

/** El estado del motor, pedido por el mismo canal que lo pide la pantalla. */
const delMotor = wc => mirar(wc, 'window.cc.grabarEstado()');

/** Lo que la pantalla muestra de cada tarjeta, para cruzarlo con el motor. */
const EN_PANTALLA = `(() => {
    const visible = e => Boolean(e) && !e.hidden;
    const tarjetas = [...document.querySelectorAll('#grabar-tomas .toma')];
    return {
        pantalla: visible(document.getElementById('grabar-pantalla-lista')) ? 'lista'
            : (visible(document.getElementById('grabar-pantalla-toma')) ? 'toma' : 'ninguna'),
        cuantas: tarjetas.length,
        tomas: tarjetas.map(t => ({
            id: Number(t.dataset.toma),
            vista: (t.querySelector('.toma-vista-puesta, .toma-vista.es-puesta') || {}).textContent
                || (t.dataset.vista || ''),
            nota: (t.querySelector('.toma-nota') || {}).value || '',
            descartada: t.classList.contains('es-descartada')
        })),
        deshacer: (() => {
            const b = document.getElementById('grabar-deshacer');
            return b ? { apagado: b.disabled, titulo: b.title } : null;
        })(),
        rehacer: (() => {
            const b = document.getElementById('grabar-rehacer');
            return b ? { apagado: b.disabled, titulo: b.title } : null;
        })(),
        clases: [...document.querySelectorAll('#grabar-grabadas .clase')].map(c => {
            const t = c.querySelector('.clase-titulo');
            return t ? t.textContent.trim() : '?';
        })
    };
})()`;

const enPantalla = wc => mirar(wc, EN_PANTALLA);

/**
 * Lo que el modelo dijo de cada toma, aplanado: una fila por medida.
 *
 * La medida vive en `toma.<clave>.ia` y no en `toma.<clave>`, porque al lado de lo
 * que contestó el modelo está lo que se midió sin él. Sirve igual para el estado en
 * memoria y para el archivo de datos, que guardan la misma forma: es lo que
 * permite preguntar lo mismo mientras se graba y con la clase ya cerrada.
 */
function medidasDe(tomas) {
    const filas = [];
    for (const t of tomas || []) {
        for (const clave of ['lengua', 'empalme']) {
            const ia = t[clave] && t[clave].ia;
            if (ia) filas.push({ toma: t.id, clave, ...ia });
        }
    }
    return filas;
}

/* ─── El audio, empujado por el puente de la ventana ─────────────────────── */

/**
 * Le pasa el PCM a la ventana para que ella lo mande por `grabarPcm`.
 *
 * Va en base64 por `executeJavaScript` y se rearma como `Int16Array`, que es
 * exactamente lo que le llega al puente desde el worklet
 * (`src/js/grabar/pcm-worklet.js`). Mandarlo desde acá al motor sería más simple
 * y no probaría el puente, que es la mitad de lo que se vino a ver.
 *
 * Se empuja de a un segundo de audio y se le da aire al reloj del motor, que cada
 * tres segundos corre el ciclo de señales (`grabacion.CICLO_MS`) y es el que abre
 * y cierra las tomas.
 *
 * **Cuánto aire, o sea `--ritmo`, cambia lo que se está probando.** Por omisión se
 * le dan 120 ms de reloj por cada segundo de audio, así que cuatro minutos de clase
 * pasan en unos cincuenta: alcanza para ver la cadena entera y es lo que permite
 * correr esto seguido. Lo que ese apuro NO reproduce es el reparto del vivo: el
 * ciclo de señales sigue corriendo cada tres segundos de RELOJ, así que cada pasada
 * se come veinticinco segundos de audio en vez de tres, y las señales caen de otra
 * manera — sobre el mismo WAV salieron 6, 7 y 8 tomas en corridas distintas.
 * `--ritmo=1000` es tiempo real: cuatro minutos de clase tardan cuatro minutos y el
 * ciclo ve lo que vería en una clase. Es la corrida que hay que hacer cuando lo que
 * se quiere saber es dónde caen las tomas, y no si la cadena anda.
 */
async function empujarAudio(wc, raw, alAvanzar, ritmoMs) {
    const pcm = fs.readFileSync(raw);
    const bytesPorPedazo = MUESTRAS_POR_PEDAZO * 2;
    const pedazosPorSegundo = Math.round(TASA / MUESTRAS_POR_PEDAZO);

    let pedazos = 0;
    for (let off = 0; off < pcm.byteLength; off += bytesPorPedazo) {
        const trozo = pcm.subarray(off, Math.min(off + bytesPorPedazo, pcm.byteLength));
        await mirar(wc, `(() => {
            const b = atob(${JSON.stringify(trozo.toString('base64'))});
            const bytes = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
            window.cc.grabarPcm(new Int16Array(bytes.buffer));
            return 1;
        })()`);
        pedazos++;
        if (pedazos % pedazosPorSegundo === 0) {
            // Un respiro por segundo de audio: sin esto el reloj del motor no
            // llega a correr el ciclo y las tomas aparecerían todas al final.
            await dormir(ritmoMs);
            if (pedazos % (pedazosPorSegundo * 15) === 0) await alAvanzar(off / pcm.byteLength);
        }
    }
}

/* ─── El recorrido ───────────────────────────────────────────────────────── */

async function esperarTomas(wc, cuantas, hasta) {
    while (Date.now() < hasta) {
        const e = await delMotor(wc);
        if (e && (e.tomas || []).filter(t => t.outMs != null).length >= cuantas) return e;
        await dormir(500);
    }
    return delMotor(wc);
}

async function correr({ win, arg }) {
    const wc = win.webContents;
    const { ipcMain } = require('electron');
    const rodecaster = require(path.join(RAIZ, 'engine', 'rodecaster-xml'));
    const raw = arg('raw');
    // Cuánto reloj por cada segundo de audio. 1000 es tiempo real; ver `empujarAudio`.
    const ritmo = Number(arg('ritmo') || 120);
    const notas = arg('notas');
    const capturas = arg('capturas');
    const preguntas = atajarCarteles(ipcMain);

    win.setContentSize(1500, 1000);
    const fallos = [];
    const paso = async (que, hacer) => {
        try {
            const mal = await hacer();
            console.log(`${mal ? '  ✗' : '  ✓'} ${que}${mal ? `\n      ${mal}` : ''}`);
            if (mal) fallos.push(`${que}: ${mal}`);
        } catch (err) {
            console.log(`  ✗ ${que}\n      ${err.message}`);
            fallos.push(`${que}: ${err.message}`);
        }
    };
    const capturar = async nombre => {
        if (!capturas) return;
        fs.mkdirSync(capturas, { recursive: true });
        const destino = path.join(capturas, `${nombre}.png`);
        fs.writeFileSync(destino, (await wc.capturePage()).toPNG());
        console.log(`      captura: ${destino}`);
    };

    console.log('\n── Entrar a Grabar ──');

    await paso('el paso abre por la lista, con la carpeta ya elegida y sin clases', async () => {
        await mirar(wc, 'window.dev.abrirGrabar()');
        await dormir(1200);
        const p = await enPantalla(wc);
        if (p.pantalla !== 'lista') return `abrió en «${p.pantalla}»`;
        if (p.clases.length) return `la carpeta temporal ya tenía ${p.clases.length} clases`;
        return null;
    });
    await capturar('01-lista-vacia');

    await paso('«Comenzar clase» entra a la toma de notas sin arrancar nada', async () => {
        await clic(wc, '#grabar-comenzar');
        await dormir(900);
        const p = await enPantalla(wc);
        if (p.pantalla !== 'toma') return `quedó en «${p.pantalla}»`;
        const e = await delMotor(wc);
        if (e && e.grabando) return 'entrar dejó una grabación en curso';
        return null;
    });

    console.log('\n── Grabar, con el Live-Mix de la clase 02 ──');

    let arranque = null;
    await paso('la sesión arranca por el canal de «Iniciar grabación»', async () => {
        const r = await mirar(wc, `window.cc.grabarIniciar(${JSON.stringify({
            dir: notas, clase: 2, curso: 'spec-driven-dev',
            sampleRate: TASA, canales: 1, dispositivo: 'arnés probar-vivo'
        })})`);
        if (!r || !r.ok) return `no arrancó: ${r && r.error}`;
        arranque = r.estado;
        // La respuesta del canal se le pasa a la pantalla por el mismo sitio por
        // el que se la pasa el botón (`pintarEstado`): de acá en adelante la
        // ventana sabe que está grabando, así que los gestos del recorrido son
        // los botones y las teclas de la app y no llamadas al puente.
        await mirar(wc, `window.dev.grabarEstado(${JSON.stringify(arranque)})`);
        await dormir(600);
        return null;
    });

    await paso('el audio entra por el puente y Whisper abre las tomas solo', async () => {
        if (!arranque) return 'no hubo sesión que alimentar';
        await empujarAudio(wc, raw, async hecho => {
            const e = await delMotor(wc);
            process.stdout.write(`\r      ${(hecho * 100).toFixed(0)}% · ` +
                `${(e && e.tomas || []).length} tomas · ${e && e.segundos}s de audio    `);
        }, ritmo);
        process.stdout.write('\n');
        const e = await esperarTomas(wc, 2, Date.now() + 120000);
        const cerradas = (e.tomas || []).filter(t => t.outMs != null).length;
        if (cerradas < 2) return `solo se cerraron ${cerradas} tomas en todo el audio`;
        return null;
    });

    await paso('la claqueta se detectó sola, sin apretar «La claqueta es ahora»', async () => {
        const e = await delMotor(wc);
        if (!e.claqueta) return 'no se encontró ninguna claqueta';
        return null;
    });

    await paso('lo que dibuja la pantalla es lo que dice el motor', async () => {
        const e = await delMotor(wc);
        const p = await enPantalla(wc);
        const delMotorIds = (e.tomas || []).map(t => t.id).sort((a, b) => a - b).join(',');
        const enPantallaIds = p.tomas.map(t => t.id).sort((a, b) => a - b).join(',');
        if (delMotorIds !== enPantallaIds) {
            return `el motor tiene [${delMotorIds}] y la pantalla [${enPantallaIds}]`;
        }
        for (const t of p.tomas) {
            const suya = e.tomas.find(x => x.id === t.id);
            if (suya && t.vista && t.vista !== suya.vista) {
                return `la toma ${t.id} se dibuja «${t.vista}» y el motor dice «${suya.vista}»`;
            }
        }
        return null;
    });
    /**
     * La abstención por GPU ocupada, que hasta acá solo existía en las pruebas.
     *
     * El motivo por el que estaba sin ejercitar es una casualidad de esta Mac: el
     * proveedor configurado es el Cursor CLI, o sea una consulta que viaja por red,
     * y con eso la rama de `gpu.sePuedeConsultar` que se abstiene no se pisa nunca.
     * Acá se pisa sin trampa y sin tocar los ajustes del editor: la app arranca con
     * `HOME` en la carpeta temporal, así que sus ajustes son unos recién nacidos y
     * el proveedor es el que viene por omisión, que es el modelo local.
     *
     * Lo que se comprueba es la decisión, no un log: cada medida de cada toma queda
     * en `abstenido` con el motivo escrito, y ese motivo es el que el panel muestra.
     * Que la deuda se pague se comprueba al final, con el XML ya escrito.
     */
    await paso('con el modelo local, medir se abstiene mientras Whisper tiene la GPU', async () => {
        const ajustes = await mirar(wc, 'window.cc.ajustesLeer()');
        const cual = ajustes && ajustes.ia && ajustes.ia.proveedor;
        if (cual !== 'local') return `el proveedor de esta corrida es «${cual}», no el local`;
        const e = await delMotor(wc);
        const medidas = medidasDe(e.tomas);
        if (!medidas.length) return 'ninguna toma llegó a tener medidas que mirar';
        const consultadas = medidas.filter(m => m.estado !== 'abstenido');
        if (consultadas.length) {
            const cuales = consultadas.map(m => `toma ${m.toma}: ${m.clave} en «${m.estado}»`);
            return `se consultó al modelo local grabando — ${cuales.join(', ')}`;
        }
        const porque = medidas[0].porque || '';
        if (!/GPU/.test(porque)) return `el motivo no nombra la GPU: «${porque}»`;
        console.log(`      ${medidas.length} medidas abstenidas · «${porque}»`);
        return null;
    });
    await capturar('02-grabando');

    console.log('\n── Los gestos sobre una toma real ──');

    let cual = null;
    /**
     * El foco, que en esta pantalla decide si una tecla es un atajo o una letra.
     *
     * Va antes de cada tecla y no una vez al principio: `estaEscribiendo` apaga los
     * atajos mientras el foco está en un campo —que es la regla correcta, y está
     * probada en `tests/teclas.test.js`—, así que un recorrido que escribe una nota
     * y después aprieta S le estaría mandando la S al campo. Las dos primeras
     * versiones de este arnés acusaron a la pantalla de no recibir la tecla cuando
     * lo que pasaba era esto.
     */
    const soltarElFoco = async () => {
        await mirar(wc, '(() => { if (document.activeElement) document.activeElement.blur(); return 1; })()');
        await dormir(120);
        return mirar(wc, '(document.activeElement && document.activeElement.tagName) || ""');
    };

    await paso('la tecla de vista cae sobre la toma que se está mirando, y la tarjeta la sigue', async () => {
        const e = await delMotor(wc);
        // La última cerrada: es la que la pantalla tiene arriba (`pintar` dibuja de
        // la última a la primera) y la que no se va a mover por debajo.
        cual = (e.tomas || []).filter(t => t.outMs != null).slice(-1)[0];
        if (!cual) return 'no hay ninguna toma cerrada sobre la que actuar';
        const suyaAntes = e.tomas.find(t => t.id === cual.id);
        // En una palabra del cuerpo y no en el cabezal, que es lo que este paso
        // hacía: un clic en el cabezal PLIEGA la toma además de elegirla, y los
        // dos pasos que vienen detrás necesitan su nota y sus palabras dibujadas.
        // Elegir con un clic sigue valiendo en cualquier parte de la tarjeta.
        await clic(wc, `#grabar-tomas .toma[data-toma="${cual.id}"] .toma-palabra:not(.es-orilla):not(.es-comentada)`);
        const donde = await soltarElFoco();
        // En minúscula: `queHace` compara contra `e.key`, y mandar 'S' es mandar
        // Shift+S, que no es ninguna vista.
        await tecla(wc, 's');
        await dormir(500);
        const suya = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        if (!suya) return 'la toma desapareció';
        if (suya.vista === suyaAntes.vista) {
            return `la vista quedó en «${suya.vista}»: la tecla no llegó (el foco estaba en ${donde || 'nada'})`;
        }
        const dibujada = (await enPantalla(wc)).tomas.find(t => t.id === cual.id);
        if (dibujada && dibujada.vista && dibujada.vista !== suya.vista) {
            return `el motor dice «${suya.vista}» y la tarjeta sigue en «${dibujada.vista}»`;
        }
        return null;
    });

    await paso('escribir la nota de una toma con el teclado llega al motor', async () => {
        if (!cual) return 'sin toma';
        await clic(wc, `#grabar-tomas .toma[data-toma="${cual.id}"] .toma-nota`);
        await escribir(wc, 'Repite el arranque');
        // La nota se manda al salir del campo, no letra por letra.
        await soltarElFoco();
        await dormir(500);
        const suya = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        if (!suya) return 'la toma desapareció';
        if (suya.comentario !== 'Repite el arranque') {
            return `el motor guardó «${suya.comentario}»`;
        }
        return null;
    });

    await paso('arrastrar la línea del OUT deja la toma más corta', async () => {
        if (!cual) return 'sin toma';
        const suyaAntes = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        // El gesto es agarrar la BARRA del OUT y soltarla sobre una palabra de más
        // atrás. Tiene que empezar en la barra y no en el texto: el arrastre lo
        // engancha `barra.onpointerdown` (`palabras.js`), así que apretar sobre una
        // palabra no mueve nada — fue el primer error de este paso.
        const dentro = `#grabar-tomas .toma[data-toma="${cual.id}"]`;
        // Los dos puntos se leen en una sola vuelta a la ventana, y no marcando la
        // palabra y midiéndola después: mientras se graba el motor empuja el estado
        // cada tres segundos, la tarjeta se rehace, y la marca puesta en la vuelta
        // anterior se va con el nodo viejo. Así estaba fallando una corrida de cada
        // tres, y por un defecto del arnés, no de la pantalla.
        const puntos = await mirar(wc, `(() => {
            const caja = document.querySelector(${JSON.stringify(dentro)});
            if (!caja) return 'la toma no está dibujada';
            const barra = caja.querySelector('.toma-borde.es-out');
            if (!barra) return 'la toma se dibujó sin la línea del OUT';
            const palabras = [...caja.querySelectorAll('.toma-palabra:not(.es-orilla)')];
            if (palabras.length < 4) return 'la toma se dibujó sin palabras suficientes que arrastrar';
            barra.scrollIntoView({ block: 'center' });
            const punto = e => {
                const r = e.getBoundingClientRect();
                const x = Math.round(r.left + r.width / 2);
                const y = Math.round(Math.min(Math.max(r.top + 12, r.top + r.height / 2), r.bottom - 4));
                return { x, y, dentro: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight };
            };
            return {
                desde: punto(barra),
                hasta: punto(palabras[Math.floor(palabras.length * 0.6)])
            };
        })()`);
        if (typeof puntos === 'string') return puntos;
        const { desde, hasta } = puntos;
        if (!desde.dentro || !hasta.dentro) return 'el gesto caía fuera de la ventana: agrandá --size';
        wc.sendInputEvent({ type: 'mouseDown', x: desde.x, y: desde.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 12; i++) {
            wc.sendInputEvent({
                type: 'mouseMove',
                x: Math.round(desde.x + (hasta.x - desde.x) * (i / 12)),
                y: Math.round(desde.y + (hasta.y - desde.y) * (i / 12))
            });
            await dormir(16);
        }
        wc.sendInputEvent({ type: 'mouseUp', x: hasta.x, y: hasta.y, button: 'left', clickCount: 1 });
        await dormir(700);
        const suya = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        if (suya.outMs === suyaAntes.outMs) {
            return 'el OUT no se movió: el arrastre no llegó al motor';
        }
        return null;
    });

    await paso('deshacer con el botón revierte el último paso y dice cuál', async () => {
        const b = (await enPantalla(wc)).deshacer;
        if (!b) return 'no está el botón de deshacer';
        if (b.apagado) return 'el botón quedó apagado con cambios hechos a mano';
        const estadoAntes = await delMotor(wc);
        const antes = estadoAntes.tomas.find(t => t.id === cual.id);
        const ofrecia = (estadoAntes.historia || {}).queAtras || '';
        await clic(wc, '#grabar-deshacer');
        await dormir(800);
        const despues = await delMotor(wc);
        const suya = despues.tomas.find(t => t.id === cual.id);
        if (suya.outMs === antes.outMs) {
            // Con la pila de los dos lados: si lo que volvió no es lo que el botón
            // prometía, el número lo dice y no hay que adivinarlo.
            return `el borde no volvió a donde estaba (el botón ofrecía «${ofrecia}»; ` +
                `atrás ${estadoAntes.historia.atras}→${despues.historia.atras}, ` +
                `adelante ${estadoAntes.historia.adelante}→${despues.historia.adelante}, ` +
                `y lo que quedó para rehacer es «${despues.historia.queAdelante}»)`;
        }
        return null;
    });

    await paso('rehacer con el botón vuelve a aplicarlo', async () => {
        const b = (await enPantalla(wc)).rehacer;
        if (!b) return 'no está el botón de rehacer';
        if (b.apagado) return 'el botón de rehacer quedó apagado después de deshacer';
        const antes = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        await clic(wc, '#grabar-rehacer');
        await dormir(600);
        const suya = (await delMotor(wc)).tomas.find(t => t.id === cual.id);
        if (suya.outMs === antes.outMs) return 'el borde no se volvió a mover';
        return null;
    });

    await paso('al historial solo entra lo que se ve: deshacer todo apaga el botón', async () => {
        for (let n = 0; n < 15; n++) {
            const b = (await enPantalla(wc)).deshacer;
            if (!b || b.apagado) break;
            await clic(wc, '#grabar-deshacer');
            await dormir(250);
        }
        const p = await enPantalla(wc);
        if (!p.deshacer.apagado) {
            return `quedó habilitado y ofrece «${p.deshacer.titulo}»`;
        }
        return null;
    });

    await paso('volver a la lista está cerrado mientras se graba, y lo explica', async () => {
        const b = await mirar(wc, `(() => {
            const e = document.getElementById('grabar-volver');
            return e ? { apagado: e.disabled, titulo: e.title } : null;
        })()`);
        if (!b) return 'no está el botón';
        if (!b.apagado && !/Terminá/.test(b.titulo || '')) {
            return `se puede volver grabando, y el título dice «${b.titulo}»`;
        }
        return null;
    });

    console.log('\n── Terminar y volver ──');

    let xml = null;
    await paso('«Terminar» pregunta antes de cerrar el audio', async () => {
        const cuantasAntes = preguntas.length;
        await clic(wc, '#grabar-terminar');
        await dormir(400);
        if (preguntas.length === cuantasAntes) return 'cerró sin preguntar nada';
        const ultima = preguntas[preguntas.length - 1];
        if (!/Terminar/.test(ultima.titulo)) return `preguntó «${ultima.titulo}»`;
        return null;
    });

    await paso('y al terminar el XML queda escrito, con el audio cerrado', async () => {
        // Tarda lo que tarde releer las últimas tomas con el modelo grande.
        for (let n = 0; n < 240; n++) {
            const e = await delMotor(wc);
            if (!e) break;
            await dormir(1000);
        }
        if (await delMotor(wc)) return 'el motor sigue con la sesión abierta';
        // El XML no cae en la raíz de la carpeta de notas sino en el piso que le
        // arma `workspace` (`<notas>/xml/`), que es de donde lo lee la lista.
        const encontrados = [];
        const buscar = donde => {
            for (const nombre of fs.readdirSync(donde)) {
                const suyo = path.join(donde, nombre);
                if (fs.statSync(suyo).isDirectory()) buscar(suyo);
                else if (nombre.toLowerCase().endsWith('.xml')) encontrados.push(suyo);
            }
        };
        buscar(notas);
        if (!encontrados.length) return `no quedó ningún XML bajo ${notas}`;
        xml = encontrados[0];
        return null;
    });

    await paso('el botón de volver se enciende al terminar, y la clase está en la lista', async () => {
        // Se le da tiempo, y no se mira una sola vez. El motor suelta la sesión un
        // instante antes de que la ventana se entere: quien apaga el botón es
        // `vista.terminando`, que se baja recién cuando la respuesta del canal
        // vuelve al `await` de la pantalla. Mirar en ese hueco daba rojo una vez de
        // cada tres, que es la peor clase de prueba que se puede dejar.
        const leerBoton = () => mirar(wc, `(() => {
            const e = document.getElementById('grabar-volver');
            return e ? { apagado: e.disabled, titulo: e.title } : null;
        })()`);
        let b = await leerBoton();
        for (let n = 0; n < 40 && b && b.apagado; n++) {
            await dormir(250);
            b = await leerBoton();
        }
        if (!b) return 'no está el botón';
        if (b.apagado) return `siguió apagado diez segundos después de terminar: «${b.titulo}»`;
        await clic(wc, '#grabar-volver');
        await dormir(1500);
        const p = await enPantalla(wc);
        if (p.pantalla !== 'lista') return `quedó en «${p.pantalla}»`;
        if (!p.clases.length) return 'la lista volvió vacía después de grabar';
        console.log(`      la lista muestra: ${p.clases.join(' · ')}`);
        return null;
    });
    await capturar('03-lista-con-la-clase');

    /**
     * Y la otra mitad de la abstención: abstenerse era medir después, no no medir.
     *
     * Se mira el archivo de datos y no el estado en memoria porque la sesión ya se
     * cerró: lo que quedó escrito es lo único que el panel va a poder leer mañana.
     * Un panel que se callara para siempre pasaría la prueba de arriba y sería
     * justamente el defecto que la abstención no quiere tener.
     */
    await paso('y al cerrar la clase la deuda se paga: lo abstenido se midió', async () => {
        const datos = path.join(path.dirname(xml || ''), 'Datos');
        if (!fs.existsSync(datos)) return `no quedó carpeta de datos en ${datos}`;
        const cual = fs.readdirSync(datos).find(n => n.endsWith('.json'));
        if (!cual) return 'no quedó archivo de datos';
        const clase = JSON.parse(fs.readFileSync(path.join(datos, cual), 'utf8'));
        const medidas = medidasDe(clase.tomas);
        if (!medidas.length) return 'el archivo de datos no guardó ninguna medida';
        const quedaron = medidas.filter(m => m.estado === 'abstenido');
        if (quedaron.length) {
            return `${quedaron.length} de ${medidas.length} medidas quedaron abstenidas para siempre`;
        }
        const modelos = [...new Set(medidas.map(m => m.modelo).filter(Boolean))];
        console.log(`      ${medidas.length} medidas al cierre · con ${modelos.join(', ') || 'sin modelo'}`);
        return null;
    });

    console.log('\n── El XML que quedó ──');

    await paso('lo lee `rodecaster.parseFile`, con la claqueta y los bloques', async () => {
        if (!xml) return 'no hubo XML';
        const leido = rodecaster.parseFile(xml);
        if (!leido.ok) return `no se pudo leer: ${leido.error}`;
        if (!leido.clap) return 'el XML salió sin marcador de claqueta';
        const completos = leido.blocks.filter(b => b.complete).length;
        if (!completos) return 'ningún bloque quedó completo';
        console.log(`      ${path.basename(xml)}: ${completos} bloques completos, ` +
            `claqueta en ${leido.clap.seconds}s`);
        return null;
    });

    /**
     * El color de cada marcador, contra la tabla de vistas.
     *
     * Se lee del archivo y no de lo que devuelve el parser: el color es lo que
     * Premiere va a pintar, así que lo que hay que comprobar es el número que
     * quedó escrito al lado de cada bloque. Y se cruza con `VISTAS`, que es de
     * donde sale, para que una vista nueva entre sola en la comprobación.
     */
    await paso('cada bloque lleva la vista y el color que le toca', async () => {
        if (!xml) return 'no hubo XML';
        const leido = rodecaster.parseFile(xml);
        const vivo = require(path.join(RAIZ, 'engine', 'notas-vivo'));
        const notasXml = require(path.join(RAIZ, 'engine', 'notas-xml'));
        const porNombre = new Map(vivo.VISTAS.map(v => [v.nombre, v]));
        for (const b of leido.blocks) {
            if (!porNombre.has(b.view)) return `el bloque ${b.index} salió con vista «${b.view}»`;
        }

        const crudo = fs.readFileSync(xml, 'utf8');
        const marcadores = [...crudo.matchAll(
            /<marker>\s*<comment>([^<]*)<\/comment>\s*<name>([^<]*)<\/name>[\s\S]*?<pproColor>(\d+)<\/pproColor>/g)];
        if (!marcadores.length) return 'el XML no tiene marcadores con color';

        for (const [, , nombre, color] of marcadores) {
            const vista = nombre.trim();
            if (vista === 'K') continue; // la claqueta va en blanco, no es una vista
            if (!porNombre.has(vista)) continue;
            const debe = String(notasXml.colorDeVista(vista));
            if (color !== debe) {
                return `el marcador de «${vista}» quedó en ${color} y la vista pide ${debe}`;
            }
        }
        const usadas = [...new Set(leido.blocks.map(b => b.view))];
        console.log(`      ${marcadores.length} marcadores · vistas usadas: ${usadas.join(', ')} · ` +
            `todos con el color de su vista`);
        return null;
    });

    console.log('');
    if (fallos.length) {
        console.log(`${fallos.length} en rojo:`);
        for (const f of fallos) console.log(`  · ${f}`);
    } else {
        console.log('Todo en verde.');
    }
    if (notas) console.log(`\nLa carpeta de la clase: ${notas}`);
    require('electron').app.exit(fallos.length ? 1 : 0);
}

module.exports = { correr };

if (require.main === module) {
    enNode().catch(err => {
        console.error(err.stack);
        process.exit(1);
    });
}
