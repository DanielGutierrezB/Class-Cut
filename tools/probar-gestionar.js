'use strict';
/**
 * probar-gestionar.js — Renombrar y borrar una clase grabada, por el puente de
 * verdad y contra la app de verdad.
 *
 *   node tools/probar-gestionar.js
 *   node tools/probar-gestionar.js --dejar --diario
 *
 * Por qué existe, que es lo único que lo distingue de lo que ya hay. Renombrar y
 * borrar están probados de punta a punta del lado del motor
 * (`tests/gestionar-clases.test.js`: carpeta temporal, archivos de verdad, tres
 * archivos comprobados en el disco) y del lado de las promesas de la pantalla
 * (`tests/renombrar-vista.test.js`). Lo que no estaba probado —ni una vez— era el
 * tramo del medio: los canales `grabar-renombrar` y `grabar-borrar` de
 * `ipc/grabar.js`, que se escribieron copiando al vecino y se dieron por buenos
 * leyéndolos. Un manejador que nunca corrió puede estar mal escrito de las
 * maneras más aburridas —un argumento de más, una respuesta que el
 * `structuredClone` del puente no sabe copiar, un `anotar` que explota antes que
 * el gesto— y ninguna de esas se ve leyendo.
 *
 * **Contra la app real y no contra la maqueta.** `tools/probar-lista.js` y
 * `tools/probar-repintado.js` abren una ventana sobre `tools/maqueta.js`, que
 * tiene su propio `window.cc` de mentira: ahí no hay `ipcRenderer`, no hay
 * proceso principal y no hay disco. Sirven para lo suyo —el repintado, los
 * gestos, lo que la pantalla promete— y no pueden servir para esto. Acá se abre
 * `electron .`, o sea `main.js` con su `preload.js` y sus manejadores puestos, y
 * el gesto sale del renderer por `window.cc.grabarRenombrar` / `grabarBorrar`,
 * viaja por `ipcRenderer.invoke` y vuelve. Lo único que la ventana puede hacer
 * con el disco es pedirlo por el puente: corre con `sandbox`, sin Node y con
 * aislamiento de contexto, así que un archivo que cambia de nombre después de un
 * clic es, por construcción, prueba de que el viaje se hizo entero.
 *
 * **Y contra material de mentira, en una carpeta temporal.** Las clases las graba
 * el motor mismo —`grabacion.iniciar` + PCM + `apagar` dejan el XML, el sidecar y
 * el WAV como los deja una clase de verdad— con unos segundos del audio de la
 * maqueta adentro. Nada de esto toca ninguna carpeta del editor: la app arranca
 * con `HOME` apuntando a la carpeta temporal, así que hasta sus ajustes son otros
 * (`engine/ajustes.js` los guarda en `~/Library/Application Support`). Es lo que
 * permite que un arnés que BORRA archivos no tenga forma de borrar los de nadie.
 *
 * **La única hoja del sistema que queda en el camino se contesta con
 * `--responder`** (ver `dev-shot.js`): "Borrar" pregunta por `window.cc.confirmar`
 * y esa hoja no se puede tocar desde afuera. Lo que se comprueba es lo que se
 * puede comprobar: que se preguntó, qué decía el cartel, y qué pasó con cada una
 * de las dos respuestas. Que la hoja se DIBUJE bien sigue necesitando ojos.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron');

const cli = require('./lib/cli');
const grabacion = require('../engine/grabacion');
const clasesGrabadas = require('../engine/clases-grabadas');
const nombreDeClase = require('../engine/nombre-de-clase');
const workspace = require('../engine/workspace');

const RAIZ = path.join(__dirname, '..');
const AUDIO = cli.arg('audio', path.join(RAIZ, '.maqueta', 'live-mix.wav'));
const SEGUNDOS = Number(cli.arg('segundos', 3));
const DEJAR = process.argv.includes('--dejar');
const DIARIO = process.argv.includes('--diario');

const fallas = [];

/** Una comprobación, con su motivo escrito para cuando falle dentro de un mes. */
function comprobar(que, bien, detalle) {
    console.log(bien ? `    ✓ ${que}` : `    ✗ ${que}\n        ${detalle}`);
    if (!bien) fallas.push(`${que}: ${detalle}`);
}

/* ─── El material: clases grabadas por el motor, en una carpeta temporal ──── */

/**
 * El PCM crudo de un WAV, con lo que declara su cabecera.
 *
 * A mano y no con ffmpeg porque acá el audio no importa: lo que hace falta es que
 * el WAV de cada clase pese algo y exista, para poder mirar si el renombrado se
 * lo lleva y si el borrado se lo come. Saltar los trozos hasta `data` en vez de
 * asumir 44 bytes es porque el archivo de la maqueta trae un `LIST` en el medio,
 * que es justo el caso en que un offset fijo entrega ruido.
 */
function audioDePrueba(archivo, segundos) {
    const buf = fs.readFileSync(archivo);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error(`${archivo} no es un WAV`);
    }
    let sampleRate = 44100;
    let canales = 1;
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const tam = buf.readUInt32LE(off + 4);
        const cuerpo = off + 8;
        if (id === 'fmt ') {
            canales = buf.readUInt16LE(cuerpo + 2);
            sampleRate = buf.readUInt32LE(cuerpo + 4);
        }
        if (id === 'data') {
            const bytes = Math.min(tam, sampleRate * canales * 2 * segundos);
            return { pcm: buf.subarray(cuerpo, cuerpo + bytes), sampleRate, canales };
        }
        off = cuerpo + tam + (tam % 2);
    }
    throw new Error(`${archivo} no tiene datos de audio`);
}

/**
 * Deja una clase grabada y cerrada en la carpeta, con sus tres archivos.
 *
 * Se cierra con `apagar` y no con `terminar` por lo mismo que en
 * `tests/gestionar-clases.test.js`: los dos escriben el XML y el sidecar y
 * cierran el WAV, pero `terminar` además sale a medir cada toma con un proveedor,
 * y acá lo único que se quiere es material en el disco. Y no se llama nunca a
 * `buscarSenales`, así que no se levanta ningún Whisper: la clase queda sin tomas,
 * que para renombrarla y borrarla da exactamente igual.
 */
function grabarClase(dir, clase, curso, audio) {
    grabacion.iniciar({
        dir, clase, curso,
        sampleRate: audio.sampleRate,
        canales: audio.canales,
        sinReloj: true
    });
    grabacion.pcm(audio.pcm);
    const secuencia = grabacion.resumen().secuencia;
    grabacion.apagar();
    return secuencia;
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

/**
 * La foto del disco: cada archivo de la carpeta de notas con lo que pesa.
 *
 * Es contra esto que se mira si un gesto hizo lo que dijo. Los tamaños y no solo
 * los nombres porque un renombrado que copiara en vez de mover, o que dejara el
 * XML a medio escribir, se vería igual en una lista de nombres.
 */
function foto(dir) {
    const salida = {};
    const caminar = donde => {
        let entradas = [];
        try { entradas = fs.readdirSync(donde, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entradas) {
            const completa = path.join(donde, e.name);
            if (e.isDirectory()) caminar(completa);
            else salida[path.relative(dir, completa)] = fs.statSync(completa).size;
        }
    };
    caminar(dir);
    return salida;
}

/** Qué apareció y qué se fue entre dos fotos. */
function diferencia(antes, despues) {
    const nuevos = Object.keys(despues).filter(k => !(k in antes));
    const idos = Object.keys(antes).filter(k => !(k in despues));
    return { nuevos, idos };
}

function mostrarDiferencia(d) {
    for (const n of d.idos) console.log(`      − ${n}`);
    for (const n of d.nuevos) console.log(`      + ${n}`);
    if (!d.idos.length && !d.nuevos.length) console.log('      (el disco quedó igual)');
}

/* ─── Adentro de la ventana ───────────────────────────────────────────────── */

/**
 * Lo que todos los pasos necesitan tener a mano en la página.
 *
 * Va como texto porque viaja en `--js=` y se evalúa allá. `cableada()` espera
 * porque `init()` de `app.js` es asíncrona: `did-finish-load` puede llegar antes
 * de que la lista tenga sus manejadores, y un clic sobre un botón sin cablear no
 * falla, no hace nada — que es la peor forma de que una prueba pase.
 */
const PRELUDIO = `
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    async function cableada() {
        for (let i = 0; i < 200; i++) {
            const carpeta = document.getElementById('grabar-carpeta');
            if (window.dev && window.dev.abrirGrabar && carpeta && carpeta.onclick) return;
            await pausa(100);
        }
        throw new Error('la ventana no terminó de cablearse');
    }
    const tarjetas = () => [...document.querySelectorAll('#grabar-grabadas .clase')];
    const deQuien = json => tarjetas().find(c => c.dataset.json === json);
    const enLaLista = () => tarjetas().map(c => ({
        json: c.dataset.json,
        titulo: (c.querySelector('.clase-titulo') || {}).textContent
    }));
    function boton(dentro, dice) {
        const todos = [...dentro.querySelectorAll('button')];
        const cual = todos.find(b => b.textContent.trim() === dice);
        if (!cual) throw new Error('no hay ningún botón que diga «' + dice +
            '» (hay: ' + todos.map(b => b.textContent.trim()).join(', ') + ')');
        return cual;
    }
    async function abrirLaLista() {
        await cableada();
        await window.dev.abrirGrabar();
        for (let i = 0; i < 80; i++) {
            if (tarjetas().length) break;
            await pausa(150);
        }
        return enLaLista();
    }
    const elAviso = () => {
        const t = document.getElementById('toast');
        return t && !t.hidden ? t.textContent : null;
    };
    const elDiario = ${DIARIO} ? () => window.cc.registroDescargar() : async () => null;
`;

/**
 * Se lleva el diario que la app acaba de escribir a la carpeta de la corrida.
 *
 * Hace falta mudarlo porque `registro-descargar` no cae en el `HOME` de mentira:
 * `app.getPath('downloads')` de Electron sale del sistema y no de la variable de
 * entorno, así que el archivo aparece en las Descargas DE VERDAD del editor. Se
 * mueve por la ruta que la propia respuesta trae, que es la única que no hay que
 * adivinar, y así una prueba no le deja basura a nadie en una carpeta que usa.
 *
 * (Lo que no se puede evitar desde acá es el Finder: `main.js` revela el archivo
 * al escribirlo, así que cada `--diario` abre una ventana. Por eso está apagado
 * salvo que se lo pida.)
 */
function guardarDiario(respuesta, destino) {
    const dicho = respuesta && respuesta.diario;
    if (!dicho || !dicho.ok || !dicho.archivo) return null;
    fs.mkdirSync(destino, { recursive: true });
    const aca = path.join(destino, path.basename(dicho.archivo));
    try {
        fs.renameSync(dicho.archivo, aca);
        return aca;
    } catch (e) {
        return null;
    }
}

/** El paso entero, con su respuesta impresa en una línea que Node sabe leer. */
function guion(cuerpo) {
    return `(async () => {
        ${PRELUDIO}
        try {
            const salida = await (async () => { ${cuerpo} })();
            return 'CC-JSON ' + JSON.stringify({ ok: true, ...salida });
        } catch (e) {
            return 'CC-JSON ' + JSON.stringify({ ok: false, error: e && e.message, pila: e && e.stack });
        }
    })()`;
}

/**
 * Abrir el formulario de renombre de una clase y dejarlo lleno, como lo deja una
 * persona: el botón «Renombrar», y los dos campos escritos.
 *
 * Los `input` a mano y no solo `value = …` porque de eso vive la mitad de esta
 * pantalla: `oninput` es lo que guarda lo escrito en el estado de la vista y lo
 * que recalcula la marca de la parte. Sin el evento se estaría probando un
 * formulario que nadie tocó.
 *
 * Guardar NO se hace acá, y esa separación es el hallazgo de esta tanda: hay dos
 * formas de guardar el mismo formulario —el botón y la tecla Enter— y no hacen lo
 * mismo. Cada una tiene su guion, y las dos se corren.
 */
const ABRIR_Y_LLENAR = (json, clase, curso) => `
    const antes = await abrirLaLista();
    const tarjeta = deQuien(${JSON.stringify(json)});
    if (!tarjeta) throw new Error('esa clase no está en la lista: ' + JSON.stringify(antes));
    boton(tarjeta, 'Renombrar').click();
    await pausa(300);

    const forma = document.querySelector('#grabar-grabadas .clase-renombre');
    if (!forma) throw new Error('el botón «Renombrar» no abrió ningún formulario');
    const num = forma.querySelector('.grabar-num');
    const cur = forma.querySelector('.clase-renombre-curso');
    num.value = ${JSON.stringify(String(clase))};
    num.dispatchEvent(new Event('input', { bubbles: true }));
    cur.value = ${JSON.stringify(curso)};
    cur.dispatchEvent(new Event('input', { bubbles: true }));
    await pausa(200);

    const marca = forma.querySelector('.grabar-parte');
    const prometido = {
        parte: marca.textContent, escondida: marca.hidden, porque: marca.title,
        hora: (forma.querySelector('.clase-renombre-hora') || {}).textContent
    };
`;

/**
 * Cómo queda todo después de guardar: se espera a que el formulario se cierre
 * —que es lo que hace la vista al salir bien— o a que muestre el motivo por el
 * que el motor se negó.
 */
const esperarYContar = (conQue, despues) => `
    let mal = null;
    for (let i = 0; i < 60; i++) {
        const f = document.querySelector('#grabar-grabadas .clase-renombre');
        if (!f) break;
        const m = f.querySelector('.clase-renombre-mal');
        if (m && !m.hidden) { mal = m.textContent; break; }
        await pausa(150);
    }
    await pausa(600);
    const resultado = {
        conQue: ${JSON.stringify(conQue)},
        mal,
        aviso: elAviso(),
        despues: enLaLista(),
        formularioAbierto: Boolean(document.querySelector('.clase-renombre')),
        // Quién tenía el foco al guardar. Es el dato que explica por qué las dos
        // formas de guardar el mismo formulario no terminan igual.
        foco: document.activeElement ? document.activeElement.className : null,
        diario: await elDiario()
    };
    ${despues || ''}
    return resultado;
`;

/** Guardar con el botón, que es lo que hace un clic del mouse: el foco se va al botón. */
function guionDeRenombrePorBoton(json, clase, curso) {
    return guion(`
        ${ABRIR_Y_LLENAR(json, clase, curso)}
        const guardar = boton(forma, 'Guardar');
        // El foco a mano porque un click() de código no lo mueve y un clic del
        // mouse sí: en Chromium apretar un botón lo enfoca, y de eso depende lo
        // que pasa después (ver el guion de la tecla Enter).
        guardar.focus();
        guardar.click();
        ${esperarYContar('el botón Guardar', 'resultado.antes = antes; resultado.prometido = prometido;')}
    `);
}

/**
 * Guardar con la tecla Enter desde el campo, que es la otra forma que la pantalla
 * ofrece: el formulario se manda solo y el foco se queda donde estaba.
 *
 * El `--js` deja el formulario lleno y con el foco en el número —que es donde lo
 * deja la pantalla sola: `empezarRenombre` hace `select()` sobre ese campo— y la
 * tecla la manda `dev-shot` con `--key=Return`, o sea una tecla de verdad con la
 * acción que el navegador le da. Un `KeyboardEvent` fabricado no manda ningún
 * formulario, así que este camino no se puede probar de otra manera.
 */
function guionDeRenombrePorTecla(json, clase, curso) {
    return {
        js: guion(`
            ${ABRIR_Y_LLENAR(json, clase, curso)}
            num.focus();
            num.setSelectionRange(num.value.length, num.value.length);
            return { antes, prometido, foco: document.activeElement.className };
        `),
        jsDespues: guion(esperarYContar('la tecla Enter', `
            // Con la lista ya mirada, se prueba lo único que este camino tiene
            // distinto del otro: quién quedó con el foco. Sacarlo del campo y pedir
            // exactamente el mismo repintado es lo que convierte la sospecha en algo
            // observado — si con el foco afuera la lista se actualiza, el que la
            // frenaba era el foco.
            if (document.activeElement) document.activeElement.blur();
            await window.dev.abrirGrabar();
            await pausa(800);
            resultado.alSacarElFoco = enLaLista().map(c => c.titulo);
            resultado.formularioAlSacarElFoco = Boolean(document.querySelector('.clase-renombre'));
        `))
    };
}

/** Apretar "Borrar" en una tarjeta. El cartel lo contesta `--responder`. */
function guionDeBorrado(json) {
    return guion(`
        const antes = await abrirLaLista();
        const tarjeta = deQuien(${JSON.stringify(json)});
        if (!tarjeta) throw new Error('esa clase no está en la lista: ' + JSON.stringify(antes));
        boton(tarjeta, 'Borrar').click();
        await pausa(2000);
        return {
            antes, aviso: elAviso(), despues: enLaLista(), diario: await elDiario()
        };
    `);
}

/**
 * Dónde cae en la ventana el botón «Borrar» de una clase.
 *
 * Es la primera mitad de un clic del mouse de verdad, que hay que hacer en dos
 * pasadas: `dev-shot` recibe las coordenadas en `--click=x,y` y eso se decide
 * antes de abrir la ventana, así que primero se abre para medir y después se abre
 * para apretar. Entre las dos no cambia nada en el disco, así que la lista se
 * dibuja idéntica y el punto sigue valiendo.
 */
function guionDeMedirBorrar(json) {
    return guion(`
        const antes = await abrirLaLista();
        const tarjeta = deQuien(${JSON.stringify(json)});
        if (!tarjeta) throw new Error('esa clase no está en la lista: ' + JSON.stringify(antes));
        const b = boton(tarjeta, 'Borrar');
        b.scrollIntoView({ block: 'center' });
        await pausa(150);
        const caja = b.getBoundingClientRect();
        return {
            x: Math.round(caja.left + caja.width / 2),
            y: Math.round(caja.top + caja.height / 2),
            dentro: caja.top >= 0 && caja.bottom <= innerHeight
                && caja.left >= 0 && caja.right <= innerWidth,
            antes
        };
    `);
}

/** La segunda mitad: la ventana abierta en la lista, y el clic lo manda el arnés. */
const GUION_TRAS_EL_CLIC = guion(`
    await pausa(1500);
    return { aviso: elAviso(), despues: enLaLista(), diario: await elDiario() };
`);

/* ─── Levantar la app ─────────────────────────────────────────────────────── */

/**
 * Abre `electron .` —la app, con su `main.js` y su `preload.js`— corre el guion
 * adentro de la ventana y la cierra.
 *
 * `--shot` no es por la captura: es lo que hace que `dev-shot.correr` llame a
 * `app.quit()` al terminar. Sin él la ventana se queda abierta esperando a
 * alguien, y un arnés que deja procesos de Electron colgados no se puede correr
 * dos veces seguidas. Que además quede el PNG es gratis y sirve para mirar en qué
 * estado terminó la pantalla cuando algo falla.
 *
 * `HOME` apunta a la carpeta temporal: de ahí salen los ajustes de la app, o sea
 * la carpeta de notas que va a listar. Es lo único que hace falta para que la app
 * real trabaje sobre material de mentira sin enterarse.
 */
function enLaApp(paso, casa, capturas) {
    const args = [
        '.',
        '--size=1400x1000',
        `--shot=${path.join(capturas, `${paso.nombre}.png`)}`,
        '--wait=600',
        `--js=${paso.js}`
    ];
    if (paso.responder != null) args.push(`--responder=${paso.responder}`);
    // El orden de `dev-shot.pase` es el que hace falta: primero el `--js` que deja
    // la pantalla lista, después el gesto de verdad —el clic o la tecla— y al final
    // el `--js-despues` que mira cómo quedó.
    if (paso.clic) args.push(`--click=${paso.clic}`);
    if (paso.tecla) args.push(`--key=${paso.tecla}`);
    if (paso.jsDespues) args.push(`--js-despues=${paso.jsDespues}`);

    const env = { ...process.env, HOME: casa };
    // El proceso que corre este archivo es Node, y en él `require('electron')` es
    // la ruta al binario. Heredar la variable haría que el hijo también arranque
    // como Node y la app no abra nunca.
    delete env.ELECTRON_RUN_AS_NODE;

    const r = spawnSync(electron, args, {
        cwd: RAIZ, env, encoding: 'utf8', timeout: 240000
    });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    // Las dos si hubo `--js-despues`, y de ellas manda la última: la primera solo
    // dejó la pantalla en posición.
    const lineas = salida.split('\n').filter(l => l.trim().startsWith('CC-JSON '))
        .map(l => JSON.parse(l.trim().slice('CC-JSON '.length)));
    const paseado = {
        salida,
        // Lo que el arnés de la ventana contestó al diálogo, con el cartel entero:
        // es la única forma de leer desde afuera lo que el cartel prometía.
        carteles: salida.split('\n').filter(l => /^(confirmar|preguntar):/.test(l.trim())),
        primera: lineas[0] || null,
        respuesta: lineas[lineas.length - 1] || null
    };
    const diario = guardarDiario(paseado.respuesta, path.join(path.dirname(capturas), 'diarios'));
    if (diario) console.log(`    diario de la sesión: ${diario}`);
    return paseado;
}

/* ─── El recorrido ────────────────────────────────────────────────────────── */

async function main() {
    if (!fs.existsSync(AUDIO)) {
        console.error(`No está el audio de prueba: ${AUDIO}`);
        process.exit(1);
    }

    const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gestionar-real-'));
    const casa = path.join(raizTmp, 'casa');
    const curso = path.join(raizTmp, 'curso');
    const capturas = path.join(raizTmp, 'capturas');
    for (const d of [casa, curso, capturas]) fs.mkdirSync(d, { recursive: true });

    console.log(`Carpeta de trabajo: ${raizTmp}`);
    console.log(`  la app va a creer que ${casa} es la casa del editor`);
    console.log(`  y que ${curso} es su carpeta de notas\n`);

    console.log('Grabando el material con el motor…');
    const audio = audioDePrueba(AUDIO, SEGUNDOS);
    const puestas = {};
    for (const [nombre, numero, comoSeLlamaba] of [
        ['a', 3, 'Curso Viejo'],
        ['b', 4, 'Curso Viejo'],
        ['c', 7, 'Curso Viejo'],
        ['d', 9, 'Curso Viejo'],
        ['e', 11, 'Curso Viejo']
    ]) {
        puestas[nombre] = grabarClase(curso, numero, comoSeLlamaba, audio);
        console.log(`  ${puestas[nombre]}`);
        // Dos clases seguidas caen en el mismo segundo y comparten nombre: una
        // clase de verdad tarda una hora, y acá la hora es parte de la identidad.
        await dormir(1100);
    }

    // Los ajustes que la app va a leer al abrir. Se escriben a mano y no por el
    // puente porque son el punto de partida, no lo que se está probando.
    const ajustes = path.join(casa, 'Library', 'Application Support', 'Class Cut');
    fs.mkdirSync(ajustes, { recursive: true });
    fs.writeFileSync(path.join(ajustes, 'ajustes.json'), `${JSON.stringify({
        version: 1, notasDir: curso, notasDirs: [curso], ia: { proveedor: 'local' }
    }, null, 2)}\n`);

    const json = nombre => workspace.notasArchivos(curso, puestas[nombre]).json;
    /** El `_fecha_hora` del final de un nombre, que es lo que no se toca nunca. */
    const cuando = secuencia => nombreDeClase.leer(secuencia).cuandoMs;
    const sidecarDe = secuencia =>
        JSON.parse(fs.readFileSync(workspace.notasArchivos(curso, secuencia).json, 'utf8'));
    /**
     * La hora de captura antes y después, al milisegundo.
     *
     * Se compara contra el `ceroMs` de ANTES y no contra la hora que se lee del
     * nombre: el nombre la lleva al segundo y el sidecar al milisegundo, así que
     * pedirles que coincidan es pedir que la clase se haya grabado en un
     * milisegundo redondo. Lo que tiene que valer es que ninguno de los dos se
     * haya movido, cada uno con su resolución.
     */
    const ceroDe = {};
    for (const [nombre, secuencia] of Object.entries(puestas)) {
        ceroDe[nombre] = sidecarDe(secuencia).ceroMs;
    }

    let antes = foto(curso);
    console.log(`\n${Object.keys(antes).length} archivos en la carpeta de notas\n`);

    /* ── 1. Renombrar por el puente, y mirar la respuesta cruda ───────────── */

    console.log('1. renombrar por el puente (window.cc.grabarRenombrar)');
    let paso = enLaApp({
        nombre: '1-puente-renombrar',
        js: guion(`
            await cableada();
            const r = await window.cc.grabarRenombrar(${JSON.stringify(json('a'))},
                { clase: 5, curso: 'Curso Nuevo' });
            return { r, diario: await elDiario() };
        `)
    }, casa, capturas);
    let r = paso.respuesta;
    comprobar('la ventana contestó algo', Boolean(r), paso.salida.slice(-1500));
    if (r && r.ok) {
        console.log(`    respuesta del puente: ${JSON.stringify(r.r)}`);
        comprobar('el canal contestó {ok:true}', r.r && r.r.ok === true, JSON.stringify(r.r));
        comprobar('con el nombre nuevo, el mismo _fecha_hora y la parte 1',
            r.r.secuencia === `05_curso-nuevo_${puestas.a.slice(-19)}`,
            `${r.r.secuencia}, y esperaba 05_curso-nuevo_${puestas.a.slice(-19)}`);
        comprobar('y dice que movió un audio', r.r.audios === 1, JSON.stringify(r.r));
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }
    let despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));
    const renombrada = r && r.ok && r.r.ok ? r.r.secuencia : null;
    if (renombrada) {
        const suyos = workspace.notasArchivos(curso, renombrada);
        comprobar('el XML nuevo está en el disco', fs.existsSync(suyos.xml), suyos.xml);
        comprobar('y el sidecar también', fs.existsSync(suyos.json), suyos.json);
        comprobar('el par viejo ya no está',
            !fs.existsSync(workspace.notasArchivos(curso, puestas.a).xml)
            && !fs.existsSync(workspace.notasArchivos(curso, puestas.a).json),
            'quedó algo del nombre viejo');
        const leido = JSON.parse(fs.readFileSync(suyos.json, 'utf8'));
        comprobar('el WAV se llama como la clase y está donde el sidecar dice',
            fs.existsSync(leido.sesiones[0].archivo)
            && path.basename(leido.sesiones[0].archivo).startsWith(renombrada),
            leido.sesiones[0].archivo);
        comprobar('la hora de captura no se movió, ni en el nombre ni en el sidecar',
            cuando(renombrada) === cuando(puestas.a) && leido.ceroMs === ceroDe.a,
            `nombre ${new Date(cuando(renombrada)).toISOString()} · sidecar ${leido.ceroMs} contra ${ceroDe.a}`);
    }
    antes = despues;

    /* ── 2. Renombrar al número ya usado, por el formulario ───────────────── */

    console.log('\n2. renombrar al número ya usado, por el formulario (botón «Guardar»)');
    paso = enLaApp({
        nombre: '2-formulario-numero-usado',
        js: guionDeRenombrePorBoton(json('c'), 4, 'Curso Viejo')
    }, casa, capturas);
    r = paso.respuesta;
    if (r && r.ok) {
        console.log(`    la pantalla prometió: ${JSON.stringify(r.prometido)}`);
        console.log(`    guardó con ${r.conQue}, y avisó: ${JSON.stringify(r.aviso)}`);
        comprobar('la marca de la parte avisó que iba a quedar como la parte 2',
            /parte 2/.test(r.prometido.parte) && !r.prometido.escondida,
            JSON.stringify(r.prometido));
        comprobar('el motor no se negó', !r.mal, r.mal);
        comprobar('y el formulario se cerró solo', !r.formularioAbierto,
            'quedó abierto después de guardar bien');
        comprobar('la lista muestra la clase con su parte nueva',
            r.despues.some(c => /Clase 4 · parte 2/.test(c.titulo)),
            r.despues.map(c => c.titulo).join(' | '));
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }
    despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));
    const parteDos = `04_p2_curso-viejo_${puestas.c.slice(-19)}`;
    comprobar('en el disco quedó el nombre con "_p2_"',
        fs.existsSync(workspace.notasArchivos(curso, parteDos).json),
        `no está ${parteDos}`);
    comprobar('y la parte 1 de esa clase sigue entera',
        fs.existsSync(workspace.notasArchivos(curso, puestas.b).json)
        && fs.existsSync(workspace.notasArchivos(curso, puestas.b).xml),
        'la clase con la que se juntó perdió algo');
    if (fs.existsSync(workspace.notasArchivos(curso, parteDos).json)) {
        const leido = sidecarDe(parteDos);
        comprobar('el sidecar dice parte 2 y clase 4',
            leido.parte === 2 && leido.clase === 4, JSON.stringify({ parte: leido.parte, clase: leido.clase }));
        comprobar('el audio se fue con ella', fs.existsSync(leido.sesiones[0].archivo),
            leido.sesiones[0].archivo);
        comprobar('y la hora de captura sigue siendo la de la grabación',
            leido.ceroMs === ceroDe.c && cuando(parteDos) === cuando(puestas.c),
            `${leido.ceroMs} contra ${ceroDe.c}`);
    }
    antes = despues;

    /* ── 2b. El mismo formulario, guardado con Enter ──────────────────────── */

    console.log('\n2b. el mismo formulario, guardado con la tecla Enter de verdad');
    const porTecla = guionDeRenombrePorTecla(json('e'), 6, 'Curso Viejo');
    paso = enLaApp({
        nombre: '2b-formulario-con-enter',
        js: porTecla.js,
        tecla: 'Return',
        jsDespues: porTecla.jsDespues
    }, casa, capturas);
    r = paso.respuesta;
    if (paso.primera && paso.primera.ok) {
        console.log(`    al mandar la tecla, el foco estaba en «${paso.primera.foco}»`);
    }
    if (r && r.ok) {
        console.log(`    guardó con ${r.conQue}, y avisó: ${JSON.stringify(r.aviso)}`);
        comprobar('el motor no se negó', !r.mal, r.mal);
    }
    despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));
    const porEnter = `06_curso-viejo_${puestas.e.slice(-19)}`;
    comprobar('el renombrado llegó al disco igual que por el botón',
        fs.existsSync(workspace.notasArchivos(curso, porEnter).json)
        && !fs.existsSync(workspace.notasArchivos(curso, puestas.e).json),
        `no está ${porEnter}`);
    if (r && r.ok) {
        // Acá es donde las dos formas de guardar dejan de coincidir. Ver el informe:
        // `pintar` no repinta si el foco está adentro del formulario, y guardando
        // con Enter el foco se quedó en el campo del número.
        comprobar('y el formulario se cerró, igual que con el botón', !r.formularioAbierto,
            `quedó abierto con el foco en «${r.foco}»`);
        comprobar('y la lista se enteró del nombre nuevo',
            r.despues.some(c => /Clase 6/.test(c.titulo)),
            `la lista sigue mostrando: ${r.despues.map(c => c.titulo).join(' | ')}`);
        console.log(`    con el foco adentro del formulario: ${r.despues.map(c => c.titulo).join(' | ')}`);
        console.log(`    sacando el foco y repintando:       ${(r.alSacarElFoco || []).join(' | ')}`);
    }
    antes = despues;

    /* ── 3. Borrar diciendo que no ────────────────────────────────────────── */

    console.log('\n3. borrar, contestando que no');
    paso = enLaApp({
        nombre: '3-borrar-que-no',
        js: guionDeBorrado(json('d')),
        responder: -1
    }, casa, capturas);
    r = paso.respuesta;
    for (const c of paso.carteles) console.log(`    ${c}`);
    comprobar('el cartel se preguntó', paso.carteles.length === 1, paso.carteles.join(' | ') || 'no preguntó nada');
    const cartel = paso.carteles[0] || '';
    for (const cosa of ['XML', 'archivo de datos', 'audio', 'papelera', 'no se puede deshacer']) {
        comprobar(`el cartel nombra «${cosa}»`, cartel.includes(cosa), cartel);
    }
    despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));
    comprobar('diciendo que no, el disco quedó exactamente igual',
        JSON.stringify(antes) === JSON.stringify(despues),
        JSON.stringify(diferencia(antes, despues)));
    if (r && r.ok) {
        comprobar('y la clase sigue en la lista',
            r.despues.some(c => c.json === json('d')), r.despues.map(c => c.titulo).join(' | '));
    }

    /* ── 4. Borrar diciendo que sí ────────────────────────────────────────── */

    console.log('\n4. borrar, contestando que sí');
    const suyosD = workspace.notasArchivos(curso, puestas.d);
    const wavD = JSON.parse(fs.readFileSync(suyosD.json, 'utf8')).sesiones[0].archivo;
    comprobar('antes de borrar están los tres archivos',
        fs.existsSync(suyosD.xml) && fs.existsSync(suyosD.json) && fs.existsSync(wavD),
        `${suyosD.xml} · ${suyosD.json} · ${wavD}`);

    // Con un clic del mouse de verdad, en dos pasadas. Es el único gesto de toda
    // la app que no se puede deshacer, así que es el que menos puede probarse con
    // un `elemento.click()`: ese llama al manejador y no comprueba que el botón
    // esté donde se ve ni que nada lo tape.
    const donde = enLaApp({
        nombre: '4-medir-el-boton',
        js: guionDeMedirBorrar(json('d'))
    }, casa, capturas);
    comprobar('el botón «Borrar» se puede apuntar dentro de la ventana',
        Boolean(donde.respuesta && donde.respuesta.ok && donde.respuesta.dentro),
        JSON.stringify(donde.respuesta));
    const punto = donde.respuesta && donde.respuesta.ok
        ? `${donde.respuesta.x},${donde.respuesta.y}` : null;
    console.log(`    el botón está en ${punto}`);

    paso = enLaApp({
        nombre: '4-borrar-que-si',
        js: guion('await abrirLaLista(); return { listo: true };'),
        clic: punto,
        jsDespues: GUION_TRAS_EL_CLIC,
        responder: 0
    }, casa, capturas);
    r = paso.respuesta;
    for (const c of paso.carteles) console.log(`    ${c}`);
    if (r && r.ok) console.log(`    y avisó: ${JSON.stringify(r.aviso)}`);
    despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));
    comprobar('se fue el XML', !fs.existsSync(suyosD.xml), suyosD.xml);
    comprobar('se fue el archivo de datos', !fs.existsSync(suyosD.json), suyosD.json);
    comprobar('y se fue el audio, que es el que ocupa el disco', !fs.existsSync(wavD), wavD);
    comprobar('se fueron esos tres y nada más', diferencia(antes, despues).idos.length === 3
        && !diferencia(antes, despues).nuevos.length,
        JSON.stringify(diferencia(antes, despues)));
    if (r && r.ok) {
        comprobar('el aviso cuenta lo que se fue', /Borrada/.test(r.aviso || ''), r.aviso);
        comprobar('y la clase ya no está en la lista',
            !r.despues.some(c => c.json === json('d')), r.despues.map(c => c.titulo).join(' | '));
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }
    antes = despues;

    /* ── 5. Las negativas: la clase que se está grabando ahora ────────────── */

    console.log('\n5. las negativas: renombrar y borrar la clase que se está grabando');
    paso = enLaApp({
        nombre: '5-negativas',
        js: guion(`
            await cableada();
            // Se arranca por el puente, como lo hace el botón de la toma de notas.
            // Sin reloj: sin ese pedido, el ciclo de señales levantaría un Whisper
            // cada tres segundos para escuchar un audio que nadie está mandando.
            const arranque = await window.cc.grabarIniciar({
                dir: ${JSON.stringify(curso)}, clase: 12, curso: 'En Curso',
                sampleRate: 16000, canales: 1, sinReloj: true
            });
            if (!arranque.ok) throw new Error('no arrancó la grabación: ' + arranque.error);
            const suyo = arranque.estado.archivos.json;

            const negadoRenombre = await window.cc.grabarRenombrar(suyo, { clase: 8, curso: 'Otro' });
            const negadoBorrado = await window.cc.grabarBorrar(suyo);
            const mientrasGraba = await window.cc.grabarListar([${JSON.stringify(curso)}]);

            // Terminada la grabación, la clase aparece en la lista con el nombre
            // que tenía: es lo que dice que las dos negativas no le tocaron nada
            // por debajo. Se mira acá adentro y no desde Node porque el renombrado
            // de la línea siguiente le va a cambiar el nombre.
            await window.cc.grabarTerminar();
            const alTerminar = await window.cc.grabarListar([${JSON.stringify(curso)}]);
            const yaSePuede = await window.cc.grabarRenombrar(suyo, { clase: 8, curso: 'Ya Terminada' });
            return {
                secuencia: arranque.estado.secuencia,
                suyo, negadoRenombre, negadoBorrado, yaSePuede,
                escondida: !mientrasGraba.some(c => c.archivos && c.archivos.json === suyo),
                entera: alTerminar.some(c => c.archivos && c.archivos.json === suyo),
                diario: await elDiario()
            };
        `)
    }, casa, capturas);
    r = paso.respuesta;
    if (r && r.ok) {
        console.log(`    renombrar mientras graba: ${JSON.stringify(r.negadoRenombre)}`);
        console.log(`    borrar mientras graba:    ${JSON.stringify(r.negadoBorrado)}`);
        comprobar('renombrar la clase en curso se niega con un motivo legible',
            r.negadoRenombre.ok === false && /se está grabando/.test(r.negadoRenombre.error || ''),
            JSON.stringify(r.negadoRenombre));
        comprobar('borrarla también', r.negadoBorrado.ok === false
            && /se está grabando/.test(r.negadoBorrado.error || ''), JSON.stringify(r.negadoBorrado));
        comprobar('y la lista no la muestra mientras se graba', r.escondida === true,
            'apareció en la lista la clase que se está grabando');
        comprobar('las dos negativas no le tocaron los archivos: al terminar está entera',
            r.entera === true, `${r.secuencia} no apareció en la lista al terminar`);
        comprobar('terminada, esa misma clase ya se puede renombrar',
            r.yaSePuede && r.yaSePuede.ok === true, JSON.stringify(r.yaSePuede));
        if (r.yaSePuede && r.yaSePuede.ok) {
            comprobar('y el renombrado quedó en el disco',
                fs.existsSync(workspace.notasArchivos(curso, r.yaSePuede.secuencia).json),
                r.yaSePuede.secuencia);
        }
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }
    despues = foto(curso);
    mostrarDiferencia(diferencia(antes, despues));

    /* ── 6. Quitar una carpeta de la lista, y que se quede quitada ────────── */

    // Es el otro gesto de esta pantalla que promete algo sobre el disco, y el
    // único cuya promesa dura más que la sesión: quitar una carpeta escribe los
    // ajustes, así que la única forma de saber si se fue de verdad es cerrar la
    // app y volver a abrirla. Un `notasDirs` que se arregla en memoria y no en el
    // archivo se ve idéntico hasta el próximo arranque.
    console.log('\n6. quitar una carpeta de la lista');
    const otro = path.join(raizTmp, 'otro-curso');
    fs.mkdirSync(otro, { recursive: true });
    const enElOtro = grabarClase(otro, 20, 'Otro Curso', audio);
    console.log(`  y una clase suya, para ver si se va con ella: ${enElOtro}`);

    const archivoDeAjustes = path.join(ajustes, 'ajustes.json');
    const guardadasEnDisco = () => JSON.parse(fs.readFileSync(archivoDeAjustes, 'utf8')).notasDirs;

    paso = enLaApp({
        nombre: '6-quitar-carpeta',
        js: guion(`
            await cableada();
            // La segunda carpeta se suma por el puente, como la suma «Elegir
            // carpeta…». Lo que se prueba es sacarla, y eso es un clic.
            await window.cc.ajustesGuardar({
                notasDirs: [${JSON.stringify(curso)}, ${JSON.stringify(otro)}]
            });
            const antes = await abrirLaLista();
            const cabezas = () => [...document.querySelectorAll('#grabar-grabadas .carpeta-cabeza')];
            const rutas = () => cabezas().map(h => (h.querySelector('.mono') || {}).textContent);
            const cual = cabezas().find(h =>
                (h.querySelector('.mono') || {}).textContent === ${JSON.stringify(otro)});
            if (!cual) throw new Error('la segunda carpeta no aparece: ' + rutas().join(' | '));
            boton(cual, 'Quitar de la lista').click();
            await pausa(1500);
            return {
                antes,
                rutas: rutas(),
                guardadas: (await window.cc.ajustesLeer()).notasDirs,
                despues: enLaLista(),
                diario: await elDiario()
            };
        `)
    }, casa, capturas);
    r = paso.respuesta;
    if (r && r.ok) {
        console.log(`    quedaron en la lista: ${r.rutas.join(' | ')}`);
        comprobar('la clase de la otra carpeta estaba antes de quitarla',
            r.antes.some(c => c.json.startsWith(otro)), r.antes.map(c => c.titulo).join(' | '));
        comprobar('la cabecera de la carpeta quitada se fue de la pantalla',
            !r.rutas.includes(otro), r.rutas.join(' | '));
        comprobar('y sus clases se fueron con ella',
            !r.despues.some(c => c.json.startsWith(otro)), r.despues.map(c => c.json).join(' | '));
        comprobar('la carpeta en uso siguió ahí, que es donde va a caer la próxima clase',
            r.rutas.includes(curso) && r.guardadas.includes(curso), r.rutas.join(' | '));
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }
    comprobar('el archivo de ajustes ya no la nombra',
        !guardadasEnDisco().includes(otro), JSON.stringify(guardadasEnDisco()));
    comprobar('quitarla de la lista no borró nada del disco',
        fs.existsSync(workspace.notasArchivos(otro, enElOtro).xml),
        'se llevó archivos de una carpeta que solo se dejó de mostrar');

    console.log('\n7. y sigue quitada después de reiniciar la app');
    paso = enLaApp({
        nombre: '7-tras-reiniciar',
        js: guion(`
            const antes = await abrirLaLista();
            return {
                antes,
                rutas: [...document.querySelectorAll('#grabar-grabadas .carpeta-cabeza .mono')]
                    .map(e => e.textContent),
                guardadas: (await window.cc.ajustesLeer()).notasDirs,
                diario: await elDiario()
            };
        `)
    }, casa, capturas);
    r = paso.respuesta;
    if (r && r.ok) {
        console.log(`    al abrir de nuevo: ${r.rutas.join(' | ')}`);
        comprobar('la carpeta quitada no volvió al arrancar', !r.rutas.includes(otro),
            r.rutas.join(' | '));
        comprobar('ni volvió a los ajustes', !r.guardadas.includes(otro),
            JSON.stringify(r.guardadas));
        comprobar('ni volvieron sus clases', !r.antes.some(c => c.json.startsWith(otro)),
            r.antes.map(c => c.json).join(' | '));
    } else {
        comprobar('el paso corrió', false, r ? r.error : paso.salida.slice(-1500));
    }

    /* ── Cómo quedó la carpeta ────────────────────────────────────────────── */

    console.log('\nLo que quedó en la carpeta, como lo ve la app:');
    for (const c of clasesGrabadas.listar([curso])) {
        console.log(`  ${c.secuencia}  ·  clase ${c.clase} parte ${c.parte} · ${c.curso}`);
    }

    console.log(`\n${fallas.length ? `${fallas.length} comprobaciones fallaron` : 'todo pasó'}`);
    if (DEJAR) {
        console.log(`La carpeta con las capturas y el material queda en ${raizTmp}`);
    } else {
        fs.rmSync(raizTmp, { recursive: true, force: true });
    }
    process.exit(fallas.length ? 1 : 0);
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
