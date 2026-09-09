'use strict';
/**
 * probar-temario.js — La lista del CD, contra la app de verdad y contra el disco.
 *
 *   node tools/probar-temario.js
 *   node tools/probar-temario.js --dejar
 *
 * Qué prueba, y por qué no alcanzaba con lo que ya había. Que la caja del temario
 * esté, se pliegue al guardar y se vuelva a abrir con lo pegado adentro ya lo
 * cuidan `tools/probar-lista.js` y `tools/probar-repintado.js` con gestos de
 * verdad — pero contra la MAQUETA, que guarda la lista en una variable de su
 * `window.cc` de mentira. Ahí una lista "guardada" es una lista que sobrevive a
 * un repintado, y lo que el usuario pidió es que sobreviva a cerrar la app.
 *
 * Acá se abre `electron .` —`main.js` con su `preload.js` y sus manejadores— la
 * lista se pega con un clic del mouse de verdad, y después se mira **el archivo
 * en el disco**: `Datos/temario.json` de la carpeta del curso. La ventana corre
 * con `sandbox`, sin Node y con aislamiento de contexto, así que un archivo que
 * aparece después de un clic es, por construcción, prueba de que el viaje se hizo
 * entero: `window.cc.grabarTemario` → `ipcRenderer.invoke` → `ipc/grabar.js` →
 * `engine/grabacion.js` → `engine/temario-sesion.js` → `fs`.
 *
 * Y después la app se cierra y se vuelve a abrir. Es el único de los arneses que
 * puede contestar la pregunta del usuario —"pego la lista, cierro la app, ¿sigue
 * ahí?"— porque es el único donde cerrar la app significa que un proceso se muere
 * y otro arranca leyendo lo que quedó escrito.
 *
 * **Contra material de mentira, en una carpeta temporal.** La app arranca con
 * `HOME` apuntando a un temporal, así que hasta sus ajustes son otros
 * (`engine/ajustes.js` los guarda en `~/Library/Application Support`): un arnés
 * que ESCRIBE en la carpeta de notas no tiene forma de escribir en la de nadie.
 *
 * Lo que no prueba, y no puede: que la cobertura se mida de verdad. Medir es una
 * consulta a un modelo, y con el modelo de esta máquina no se consulta mientras
 * se graba a propósito (`engine/gpu.js`). Que al cerrar una toma se dispare la
 * medición está en `tests/temario.test.js` con un proveedor de mentira, y que el
 * panel deje el guion cuando la medida llega, en `tools/probar-repintado.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron');

const cli = require('./lib/cli');
const workspace = require('../engine/workspace');

const RAIZ = path.join(__dirname, '..');
const DEJAR = process.argv.includes('--dejar');
const MEDIDA = String(cli.arg('size', '1400x1000'));

/** La lista del CD, como llega: con viñetas y con una línea vacía en el medio. */
const LISTA = [
    '- Qué es un contrato de datos',
    '- Cómo se escribe una spec ejecutable',
    '',
    '- Errores típicos al validar'
].join('\n');

/** Lo que se le agrega después, para probar que se edita sin borrar todo. */
const AGREGADO = '- Preguntas del alumno';

const fallas = [];

function comprobar(que, bien, detalle) {
    console.log(bien ? `  ✓ ${que}` : `  ✗ ${que}\n      ${detalle}`);
    if (!bien) fallas.push(que);
}

/* ─── Adentro de la ventana ───────────────────────────────────────────────── */

/**
 * Lo que todos los pasos necesitan tener a mano en la página.
 *
 * Va como texto porque viaja en `--js=` y se evalúa allá. `cableada()` espera
 * porque `init()` de `app.js` es asíncrona: un clic sobre un botón todavía sin
 * cablear no falla, no hace nada — que es la peor forma de que una prueba pase.
 */
const PRELUDIO = `
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    async function cableada() {
        for (let i = 0; i < 200; i++) {
            const comenzar = document.getElementById('grabar-comenzar');
            if (window.dev && window.dev.abrirGrabar && comenzar && comenzar.onclick) return;
            await pausa(100);
        }
        throw new Error('la ventana no terminó de cablearse');
    }
    /** El bloque del temario, ya dibujado. */
    const elBloque = () => document.querySelector('[data-bloque="temario"]');
    /**
     * Entrar a la toma de notas, que es donde vive el panel, sin grabar nada:
     * «Comenzar clase» abre el micrófono y propone el número, y no compromete
     * ningún archivo (ver \`comenzar\` en \`src/js/grabar/index.js\`).
     */
    async function entrarALaTomaDeNotas() {
        await cableada();
        await window.dev.abrirGrabar();
        document.getElementById('grabar-comenzar').click();
        for (let i = 0; i < 100; i++) {
            if (elBloque()) break;
            await pausa(150);
        }
        await pausa(400);
        if (!elBloque()) throw new Error('no se dibujó el bloque de cobertura');
    }
    /** Todo lo que el panel dice del temario, en un objeto. */
    function comoEstaElTemario() {
        const b = elBloque();
        if (!b) return { hayBloque: false };
        const caja = b.querySelector('.temario-caja');
        const campo = b.querySelector('.temario-campo');
        const origen = b.querySelector('.temario-origen');
        return {
            hayBloque: true,
            hayCaja: Boolean(caja),
            abierta: caja ? caja.open : null,
            // Solo el texto propio del resumen: el rótulo del origen es un \`span\`
            // adentro, y se mira aparte.
            resumen: caja ? caja.querySelector('.temario-summary').firstChild.textContent : null,
            origen: origen ? origen.textContent : null,
            campo: campo ? campo.value : null,
            filas: [...b.querySelectorAll('.analisis-filas dd')].map(d => d.textContent),
            mensaje: [...b.querySelectorAll('.analisis-pendiente')].map(p => p.textContent).join(' · ')
        };
    }
    function elBotonDeGuardar() {
        const b = elBloque();
        const todos = [...b.querySelectorAll('.temario-acciones button')];
        if (!todos.length) throw new Error('la caja del temario no tiene ningún botón');
        return todos[0];
    }
    /**
     * Dónde queda el botón cuando la pantalla dejó de acomodarse.
     *
     * Se espera a que el punto no se mueva y no se lo mide y listo: entrar a la
     * toma de notas dispara cosas que tardan —la lista de entradas de audio, las
     * cámaras— y cada una repinta el panel unos milisegundos después. Medido
     * apenas se dibuja el bloque, el botón daba 54 píxeles más arriba de donde
     * iba a estar cuando llegara el clic, y el clic caía en el campo de texto.
     */
    async function dondeQuedaElBoton() {
        let previo = null;
        let quieto = 0;
        for (let i = 0; i < 60; i++) {
            const r = elBotonDeGuardar().getBoundingClientRect();
            const punto = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), alto: innerHeight };
            quieto = previo && previo.x === punto.x && previo.y === punto.y ? quieto + 1 : 0;
            previo = punto;
            if (quieto >= 4) return punto;
            await pausa(250);
        }
        return previo;
    }
`;

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
 * Abre la app, corre el guion adentro de la ventana y la cierra.
 *
 * `--shot` no es por la captura: es lo que hace que `dev-shot.correr` llame a
 * `app.quit()` al terminar. Sin él la ventana se queda abierta esperando a
 * alguien, y un arnés que deja Electron colgado no se puede correr dos veces.
 *
 * Cada llamada a esto es una app que arranca y una app que se muere: es lo que
 * convierte "sobrevive al reinicio" en algo que se puede mirar.
 */
function enLaApp(paso, casa, capturas) {
    const args = [
        '.', `--size=${MEDIDA}`,
        `--shot=${path.join(capturas, `${paso.nombre}.png`)}`,
        '--wait=600',
        `--js=${paso.js}`
    ];
    if (paso.clic) args.push(`--click=${paso.clic}`);
    if (paso.jsDespues) args.push(`--js-despues=${paso.jsDespues}`);

    const env = { ...process.env, HOME: casa };
    // El proceso que corre este archivo es Node, y en él `require('electron')` es
    // la ruta al binario. Heredar la variable haría que el hijo también arranque
    // como Node y la app no abra nunca.
    delete env.ELECTRON_RUN_AS_NODE;

    const r = spawnSync(electron, args, { cwd: RAIZ, env, encoding: 'utf8', timeout: 180000 });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;
    const lineas = salida.split('\n').filter(l => l.trim().startsWith('CC-JSON '))
        .map(l => JSON.parse(l.trim().slice('CC-JSON '.length)));
    // Las dos si hubo `--js-despues`, y de ellas manda la última: la primera solo
    // dejó la pantalla en posición.
    return { salida, primera: lineas[0] || null, respuesta: lineas[lineas.length - 1] || null };
}

function exigir(r, paso) {
    if (!r.respuesta || !r.respuesta.ok) {
        console.error(`\nEl paso «${paso}» no llegó a contestar:`);
        console.error((r.respuesta && (r.respuesta.pila || r.respuesta.error)) || r.salida.slice(-3000));
        process.exit(1);
    }
    return r.respuesta;
}

/* ─── El recorrido ────────────────────────────────────────────────────────── */

async function main() {
    const raizTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-temario-real-'));
    const casa = path.join(raizTmp, 'casa');
    const curso = path.join(raizTmp, 'curso');
    const capturas = path.join(raizTmp, 'capturas');
    for (const d of [casa, curso, capturas]) fs.mkdirSync(d, { recursive: true });

    console.log(`Carpeta de trabajo: ${raizTmp}`);
    console.log(`  la app va a creer que ${casa} es la casa del editor`);
    console.log(`  y que ${curso} es su carpeta de notas\n`);

    // Los ajustes que la app lee al abrir. Se escriben a mano porque son el punto
    // de partida, no lo que se está probando.
    const ajustes = path.join(casa, 'Library', 'Application Support', 'Class Cut');
    fs.mkdirSync(ajustes, { recursive: true });
    fs.writeFileSync(path.join(ajustes, 'ajustes.json'), `${JSON.stringify({
        version: 1, notasDir: curso, notasDirs: [curso], ia: { proveedor: 'local' }
    }, null, 2)}\n`);

    const archivo = path.join(workspace.notasDatosDir(curso), 'temario.json');
    const enElDisco = () => {
        try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (e) { return null; }
    };

    /* 1. La caja está antes de grabar, que es cuando la lista está en la mano. */
    console.log('1. La app recién abierta, en la toma de notas');
    const medir = exigir(enLaApp({
        nombre: '1-sin-lista',
        js: guion(`
            await entrarALaTomaDeNotas();
            const caja = comoEstaElTemario();
            // Dónde cae el botón, para poder apretarlo con el mouse en la pasada
            // siguiente: \`--click\` se decide antes de abrir la ventana, así que el
            // punto hay que medirlo en una corrida y usarlo en la otra. Entre las
            // dos no cambia nada en el disco, así que la pantalla se dibuja igual.
            //
            // Y se mide sin mover nada —ni un \`scrollIntoView\`— porque el punto
            // tiene que valer en la ventana de la pasada siguiente, que no va a
            // estar scrolleada: medirlo después de acomodar la columna daba un
            // punto correcto acá y un clic al aire allá.
            const punto = await dondeQuedaElBoton();
            return {
                caja,
                dice: elBotonDeGuardar().textContent,
                x: punto.x, y: punto.y,
                dentro: punto.y > 0 && punto.y < punto.alto
            };
        `)
    }, casa, capturas), 'mirar la caja vacía');

    comprobar('sin lista, el panel tiene dónde pegarla', medir.caja.hayCaja,
        `el bloque dibujó: ${JSON.stringify(medir.caja)}`);
    comprobar('y arranca abierta, que es lo primero que hay que hacer con el bloque vacío',
        medir.caja.abierta === true, `abierta: ${medir.caja.abierta}`);
    comprobar('el mensaje no promete medir sobre una clase que todavía no arrancó',
        !/cada vez que se cierra una toma\.$/.test(medir.caja.mensaje)
        && /guardada para esta carpeta/.test(medir.caja.mensaje),
        `decía: «${medir.caja.mensaje}»`);
    comprobar('el botón dice contra qué se va a medir', medir.dice === 'Medir contra esta lista',
        `decía: «${medir.dice}»`);
    comprobar('y cae dentro de la ventana, o sea que se lo puede apretar', medir.dentro,
        `en ${medir.x},${medir.y} con la ventana de ${MEDIDA}`);
    comprobar('el disco todavía no tiene ninguna lista para esta carpeta', enElDisco() === null,
        `ya había: ${JSON.stringify(enElDisco())}`);

    /* 2. Pegar y apretar el botón con el mouse. */
    console.log('\n2. Se pega la lista y se aprieta «Medir contra esta lista»');
    const corrida2 = enLaApp({
        nombre: '2-pegada',
        js: guion(`
            await entrarALaTomaDeNotas();
            window.__clics = [];
            for (const cual of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
                document.addEventListener(cual, e => window.__clics.push([cual, e.clientX, e.clientY, (e.target && e.target.className) || '']), true);
            }
            // Antes de tocar nada: que la pantalla termine de acomodarse, para que
            // el punto que se midió en la pasada anterior siga valiendo cuando el
            // clic llegue.
            const donde = await dondeQuedaElBoton();
            const campo = elBloque().querySelector('.temario-campo');
            // El foco y el evento a mano: pegar con el mouse deja el foco adentro y
            // dispara \`input\`, y de eso vive \`ocupado\` — sin el foco se estaría
            // probando un campo que nadie tocó. El clic que guarda sí es de verdad.
            campo.focus();
            campo.value = ${JSON.stringify(LISTA)};
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            await pausa(200);
            return { escrito: campo.value.length, donde };
        `),
        clic: `${medir.x},${medir.y}`,
        jsDespues: guion(`
            await pausa(1200);
            return { despues: comoEstaElTemario(), clics: window.__clics };
        `)
    }, casa, capturas);
    const pegado = exigir(corrida2, 'pegar la lista');

    // Dónde cayó el clic, en la línea de siempre: si el punto se corre —la
    // pantalla tarda en acomodarse— lo que falla son las cuatro de abajo y no se
    // ve por qué.
    const cayoEn = (pegado.clics.find(c => c[0] === 'click') || [])[3];
    console.log(`    el clic cayó en «${cayoEn}»`);

    const guardado = enElDisco();
    comprobar('el clic dejó el archivo escrito en el disco de la carpeta', Boolean(guardado),
        `no apareció ${archivo}; se apretó en ${medir.x},${medir.y} y el botón estaba ` +
        `en ${JSON.stringify(corrida2.primera && corrida2.primera.donde)}`);
    comprobar('y adentro está el texto tal como se pegó, sin recortar',
        Boolean(guardado) && guardado.texto === LISTA,
        `quedó: ${JSON.stringify(guardado && guardado.texto)}`);
    comprobar('la caja se plegó en el mismo gesto, que es lo que se había pedido',
        pegado.despues.abierta === false, `abierta: ${pegado.despues.abierta}`);
    comprobar('y plegada dice cuántos temas quedaron, para que plegar no parezca perderlos',
        pegado.despues.resumen === '3 temas cargados', `decía: «${pegado.despues.resumen}»`);
    comprobar('recién pegada no dice que apareció sola, porque la acaban de pegar',
        pegado.despues.origen === null, `decía: ${JSON.stringify(pegado.despues.origen)}`);

    /* 3. Cerrar la app y volver a abrirla. */
    console.log('\n3. La app se cerró; se abre de nuevo');
    const reabierta = exigir(enLaApp({
        nombre: '3-reabierta',
        js: guion(`
            await entrarALaTomaDeNotas();
            const antes = comoEstaElTemario();
            // Editarla sin borrar todo: se le agrega un renglón y se sale del campo,
            // que es la otra forma de guardar que la caja ofrece (\`onchange\`).
            const campo = elBloque().querySelector('.temario-campo');
            campo.focus();
            campo.value = campo.value + '\\n' + ${JSON.stringify(AGREGADO)};
            campo.dispatchEvent(new Event('input', { bubbles: true }));
            campo.dispatchEvent(new Event('change', { bubbles: true }));
            campo.blur();
            await pausa(1200);
            return { antes, despues: comoEstaElTemario() };
        `)
    }, casa, capturas), 'reabrir la app');

    comprobar('la lista sobrevivió a cerrar la app', reabierta.antes.resumen === '3 temas cargados',
        `el resumen decía: «${reabierta.antes.resumen}»`);
    comprobar('y viene plegada, porque lo que se mira con lista puesta son los resultados',
        reabierta.antes.abierta === false, `abierta: ${reabierta.antes.abierta}`);
    comprobar('el campo trae lo pegado, así se corrige sin volver a escribirlo',
        reabierta.antes.campo === LISTA, `traía: ${JSON.stringify(reabierta.antes.campo)}`);
    comprobar('y dice que la lista no la pegó nadie en esta clase',
        reabierta.antes.origen === 'guardada para esta carpeta',
        `decía: ${JSON.stringify(reabierta.antes.origen)}`);

    const editado = enElDisco();
    comprobar('agregarle un renglón y salir del campo guarda los cuatro temas',
        Boolean(editado) && editado.texto === `${LISTA}\n${AGREGADO}`,
        `en el disco quedó: ${JSON.stringify(editado && editado.texto)}`);
    comprobar('y la pantalla lo cuenta igual que el disco',
        reabierta.despues.resumen === '4 temas cargados',
        `decía: «${reabierta.despues.resumen}»`);

    /* 4. La clase que arranca después nace con la lista puesta. */
    console.log('\n4. Se cierra otra vez, y la clase que arranca hereda la lista');
    const sesion = exigir(enLaApp({
        nombre: '4-heredada',
        js: guion(`
            await entrarALaTomaDeNotas();
            // Por el canal que abre «Iniciar grabación», que es lo mismo que aprieta
            // el botón: el micrófono es lo único que no se puede tener acá.
            const arranque = await window.cc.grabarIniciar({
                dir: ${JSON.stringify(curso)}, clase: 3, curso: 'Prueba',
                sampleRate: 44100, canales: 1, dispositivo: 'arnés probar-temario'
            });
            await pausa(500);
            const estado = await window.cc.grabarEstado();
            const t = estado && estado.temario;
            return {
                secuencia: estado && estado.secuencia,
                arranco: Boolean(arranque),
                temario: t ? { origen: t.origen, cuantos: t.objetivos.length, texto: t.texto } : null
            };
        `)
    }, casa, capturas), 'arrancar la clase');

    comprobar('la sesión nueva nace con la lista de la carpeta', Boolean(sesion.temario),
        `arrancó sin temario: ${JSON.stringify(sesion)}`);
    comprobar('con los cuatro temas y el texto completo',
        Boolean(sesion.temario) && sesion.temario.cuantos === 4
        && sesion.temario.texto === `${LISTA}\n${AGREGADO}`,
        `trajo: ${JSON.stringify(sesion.temario)}`);
    comprobar('y marcada como guardada, no como pegada en esta clase',
        Boolean(sesion.temario) && sesion.temario.origen === 'guardado',
        `origen: ${sesion.temario && sesion.temario.origen}`);

    // Y en el sidecar de la clase, que es el archivo con el que se abre mañana.
    const sidecar = sesion.secuencia
        ? (() => {
            try { return JSON.parse(fs.readFileSync(workspace.notasArchivos(curso, sesion.secuencia).json, 'utf8')); } catch (e) { return null; }
        })()
        : null;
    comprobar('y queda escrita en el sidecar de esa clase, en el disco',
        Boolean(sidecar && sidecar.temario && (sidecar.temario.objetivos || []).length === 4),
        `el sidecar tenía: ${JSON.stringify(sidecar && sidecar.temario)}`);

    console.log(`\nLo que quedó en el disco: ${archivo}`);
    console.log(`  ${JSON.stringify(enElDisco())}`);

    if (!DEJAR) fs.rmSync(raizTmp, { recursive: true, force: true });
    else console.log(`\nSe deja todo en ${raizTmp}`);

    console.log(fallas.length ? `\n${fallas.length} fallaron` : '\nTodo en verde.');
    process.exit(fallas.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
