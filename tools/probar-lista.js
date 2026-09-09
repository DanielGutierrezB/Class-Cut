'use strict';
/**
 * probar-lista.js — El recorrido de las dos pantallas de Grabar, con gestos de
 * verdad, y una pregunta después de cada uno.
 *
 *   node tools/probar-lista.js
 *   node tools/probar-lista.js --ver --capturas=/tmp/class-cut
 *
 * Qué prueba, y por qué no lo prueba `tests/run.js`. Lo de acá es entrar, salir y
 * volver: que la lista esté cuando se entra, que la toma de notas NO la muestre,
 * que el botón de arriba traiga de vuelta, y que la clase que se acaba de grabar
 * aparezca en la lista al volver. Nada de eso es una decisión que se pueda mirar
 * sin pantalla —son dos `div` y un `hidden`— y todo es lo primero que se rompe
 * cuando alguien toca el repintado. Lo mismo con gestionar: el formulario de
 * renombrar y el cartel de borrar son promesas que la pantalla hace sobre lo que
 * el motor va a hacer, así que lo que se comprueba es que lo prometido pase.
 *
 * Y por qué no es `probar-repintado.js`. Ese arnés vive dentro de una sesión ya
 * grabando (`?grabando`) y su invariante es de las tomas: para toda toma, la
 * vista que muestra su tarjeta es la que dice el motor. Este empieza en el otro
 * extremo —la app recién abierta, sin nada grabando— y su pregunta es de las
 * pantallas. Son dos rondas distintas sobre la misma maqueta y ninguna sirve para
 * lo de la otra.
 *
 * Cómo. Igual que el otro: levanta la maqueta en un puerto propio (4402, ni el
 * 4321 del que está mirando el diseño ni el 4399 del otro arnés), abre una
 * ventana de Electron y manda clics y teclas con `sendInputEvent`. Los clics del
 * mouse y no `elemento.click()`, por lo de siempre: acá hay campos de texto y
 * `pintar` decide si repinta según dónde está el foco, así que un clic que no
 * mueve el foco probaría otra cosa.
 *
 * Lo único que se sustituye es `window.confirm`, y no por comodidad: la hoja del
 * sistema no se puede manejar desde afuera —`sendInputEvent` va al contenido web,
 * no al diálogo— así que con el de verdad la única rama alcanzable sería la de
 * quedarse esperando. Se reemplaza guardando lo que se preguntó, que además es lo
 * que hace falta comprobar: que el cartel nombre los archivos que se van.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
const cli = require('./lib/cli');

const PUERTO = Number(cli.arg('puerto', 4402));
const MEDIDA = String(cli.arg('size', '1400x1000'));
const CAPTURAS = cli.arg('capturas', null);

const dormir = ms => new Promise(r => setTimeout(r, ms));

/* ─── Del lado de Node: la maqueta y la ventana ──────────────────────────── */

function esperarMaqueta(url, hasta) {
    return new Promise((listo, mal) => {
        const probar = () => {
            http.get(url, res => {
                res.resume();
                if (res.statusCode === 200) return listo();
                reintentar();
            }).on('error', reintentar);
        };
        const reintentar = () => {
            if (Date.now() > hasta) return mal(new Error(`la maqueta no contestó en ${url}`));
            setTimeout(probar, 200);
        };
        probar();
    });
}

async function enNode() {
    const propia = !cli.arg('url');
    const url = cli.arg('url') || `http://localhost:${PUERTO}/`;
    let maqueta = null;

    if (propia) {
        maqueta = spawn(process.execPath, [path.join(__dirname, 'maqueta.js'), `--puerto=${PUERTO}`], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'ignore', 'inherit']
        });
        await esperarMaqueta(url, Date.now() + 90000);
        console.log(`maqueta en ${url}`);
    }

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const ventana = spawn(electron, [__filename, ...process.argv.slice(2), `--url=${url}`], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
        env
    });

    const apagar = () => { if (maqueta) maqueta.kill(); };
    process.on('SIGINT', () => { ventana.kill(); apagar(); process.exit(130); });
    ventana.on('exit', codigo => {
        apagar();
        process.exit(codigo == null ? 1 : codigo);
    });
}

/* ─── Adentro de la ventana: los gestos ──────────────────────────────────── */

const mirar = (wc, js) => wc.executeJavaScript(js);

/** Dónde está un elemento, después de subirlo a la vista. */
async function donde(wc, sel) {
    const caja = await mirar(wc, `(() => {
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            dentro: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
        };
    })()`);
    if (!caja) throw new Error(`no hay ningún «${sel}» en la pantalla`);
    if (!caja.dentro) throw new Error(`«${sel}» quedó fuera de la ventana: agrandá --size`);
    await dormir(60);
    return caja;
}

async function clic(wc, sel) {
    const { x, y } = await donde(wc, sel);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await dormir(150);
}

/**
 * Clic en el botón que DICE tal cosa.
 *
 * Por el texto y no por su sitio en la fila, que es la lección de esta misma
 * tanda: los botones de una toma descartada acaban de cambiar de orden, y un
 * selector que decía "el primer botón" pasó de recuperar una toma a eliminarla
 * sin que nada avisara. Acá hay tres botones por tarjeta y van a seguir
 * moviéndose.
 *
 * Se marca el elegido y se hace el clic sobre la marca, para que el clic siga
 * siendo un clic del mouse en unas coordenadas.
 */
async function clicTexto(wc, dentro, texto) {
    const puesto = await mirar(wc, `(() => {
        for (const e of document.querySelectorAll('[data-arnes]')) e.removeAttribute('data-arnes');
        const caja = document.querySelector(${JSON.stringify(dentro)});
        if (!caja) return 'no está ' + ${JSON.stringify(dentro)};
        const cual = [...caja.querySelectorAll('button')]
            .find(b => b.textContent.trim() === ${JSON.stringify(texto)});
        if (!cual) return 'no hay ningún botón que diga ' + ${JSON.stringify(texto)}
            + ' (hay: ' + [...caja.querySelectorAll('button')].map(b => b.textContent.trim()).join(', ') + ')';
        cual.dataset.arnes = '1';
        return null;
    })()`);
    if (puesto) throw new Error(puesto);
    await clic(wc, '[data-arnes="1"]');
}

/** Una tecla de verdad, con la acción que el navegador le da. */
async function tecla(wc, k) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    await dormir(90);
}

/** Escribir en el campo que tenga el foco, letra por letra. */
async function escribir(wc, texto) {
    for (const letra of texto) await tecla(wc, letra);
}

/**
 * Vaciar el campo que tenga el foco.
 *
 * Con `selectAll` y un Backspace, no con cuarenta Backspaces: un clic del mouse
 * deja el cursor DONDE se hizo clic, o sea en el medio del texto, y borrar para
 * atrás desde ahí deja la cola. Fue exactamente el error de la primera versión de
 * este arnés: el campo terminaba en «eba», el renombrado salía bien porque el
 * curso no estaba vacío, y la prueba acusaba a la pantalla de no mostrar un error
 * que el motor nunca tuvo motivo para dar.
 */
async function vaciarCampo(wc) {
    wc.selectAll();
    await dormir(80);
    await tecla(wc, 'Backspace');
}

async function capturar(wc, archivo) {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, (await wc.capturePage()).toPNG());
    console.log(`      captura: ${archivo}`);
}

/* ─── Lo que se le pregunta a la pantalla ────────────────────────────────── */

/** Qué pantalla se ve, qué hay en la lista, y cómo está el botón de volver. */
const COMO_ESTA = `(() => {
    const visible = e => Boolean(e) && !e.hidden;
    const lista = document.getElementById('grabar-pantalla-lista');
    const toma = document.getElementById('grabar-pantalla-toma');
    const volver = document.getElementById('grabar-volver');
    const clases = [...document.querySelectorAll('#grabar-grabadas .clase')];
    return {
        cual: visible(lista) ? 'lista' : (visible(toma) ? 'toma' : 'ninguna'),
        // Las dos a la vez sería el bug que hay que poder ver: el \`hidden\` de una
        // puesto y el de la otra no.
        dos: visible(lista) && visible(toma),
        cuantas: clases.length,
        nombres: clases.map(c => {
            const t = c.querySelector('.clase-titulo');
            return t ? t.textContent.trim() : '?';
        }),
        volverPuesto: Boolean(volver),
        volverApagado: Boolean(volver && volver.disabled),
        volverPorque: volver ? volver.title : null,
        renombrando: document.querySelectorAll('#grabar-grabadas .clase-renombre').length,
        // Lo que se pidió que NO esté: la lista de "Ya grabados" abajo de la toma
        // de notas. Se mira si la lista está DENTRO de la pantalla de la toma, no
        // si existe: existe siempre, en la otra pantalla.
        listaEnLaToma: Boolean(toma && toma.querySelector('#grabar-grabadas'))
    };
})()`;

const comoEsta = wc => mirar(wc, COMO_ESTA);

/** El formulario de renombrar, tal como se ve. */
const COMO_ESTA_EL_FORMULARIO = `(() => {
    const f = document.querySelector('#grabar-grabadas .clase-renombre');
    if (!f) return null;
    const mal = f.querySelector('.clase-renombre-mal');
    return {
        numero: f.querySelector('.grabar-num').value,
        curso: f.querySelector('.clase-renombre-curso').value,
        parte: (f.querySelector('.grabar-parte') || {}).textContent || '',
        hora: (f.querySelector('.clase-renombre-hora') || {}).textContent || '',
        mal: mal && !mal.hidden ? mal.textContent : null,
        // Que la hora sea texto y no un campo: se pidió mostrada y no editable, y
        // un campo apagado se lee como algo que falta.
        horaEsCampo: Boolean(f.querySelector('.clase-renombre-hora input'))
    };
})()`;

/**
 * Las carpetas de la lista, qué ofrece cada cabecera, y qué quedó guardado.
 *
 * Las tres cosas juntas a propósito: quitar una carpeta se rompe de dos maneras
 * distintas —se va de la pantalla y sigue guardada, o se va de lo guardado y la
 * pantalla no se entera— y con una sola de las dos lecturas cualquiera de las dos
 * mitades pasa en verde.
 */
const COMO_ESTAN_LAS_CARPETAS = `(async () => {
    const cabezas = [...document.querySelectorAll('#grabar-grabadas .carpeta-cabeza')];
    const ruta = h => (h.querySelector('.mono') || {}).textContent || '?';
    const quita = h => [...h.querySelectorAll('button')]
        .some(b => b.textContent.trim() === 'Quitar de la lista');
    return {
        rutas: cabezas.map(ruta),
        quitables: cabezas.filter(quita).map(ruta),
        enUso: cabezas.filter(h => /en uso/.test(h.textContent)).map(ruta),
        tarjetas: document.querySelectorAll('#grabar-grabadas .clase').length,
        // Lo que se relee en el repintado siguiente (\`cargar()\`), que es de donde
        // la carpeta volvía.
        guardadas: (await window.cc.ajustesLeer()).notasDirs
    };
})()`;

/** Marca la cabecera de una carpeta que se pueda quitar, y dice cuál es. */
function laCarpetaQuitable(wc) {
    return mirar(wc, `(() => {
        for (const e of document.querySelectorAll('[data-arnes-carpeta]')) {
            e.removeAttribute('data-arnes-carpeta');
        }
        const cual = [...document.querySelectorAll('#grabar-grabadas .carpeta-cabeza')]
            .find(h => [...h.querySelectorAll('button')]
                .some(b => b.textContent.trim() === 'Quitar de la lista'));
        if (!cual) return null;
        cual.dataset.arnesCarpeta = '1';
        return (cual.querySelector('.mono') || {}).textContent || null;
    })()`);
}

/**
 * Los títulos de las tarjetas dibujadas, la cuenta de arriba, y en qué modo.
 *
 * El modo va incluido porque sin él la pregunta del modo por fecha se contesta
 * sola: en el modo por carpeta los títulos no dicen de qué curso son, así que
 * "ninguno nombra la carpeta quitada" sale verde sin haber mirado nada.
 */
const LO_QUE_SE_LISTA = `(() => ({
    titulos: [...document.querySelectorAll('#grabar-grabadas .clase-titulo')]
        .map(t => t.textContent.trim()),
    cuenta: (document.getElementById('grabadas-cuantas') || {}).textContent || '',
    modo: [...document.querySelectorAll('.grabadas-modo')]
        .filter(b => b.getAttribute('aria-checked') === 'true')
        .map(b => b.dataset.modo).join(',')
}))()`;

/**
 * Cuántos comentarios hay guardados, contados donde viven.
 *
 * Del lado de los datos y no de los que están abiertos al margen: el botón cierra
 * el margen ANTES de mandar el cambio (`margen.js`), así que la caja se va de la
 * pantalla lo mismo si el cambio se hizo que si se canceló. Contar cajas abiertas
 * daría por borrado un comentario que sigue entero.
 */
const LOS_COMENTARIOS = `(async () => {
    const dirs = (await window.cc.ajustesLeer()).notasDirs || [];
    const clases = await window.cc.grabarListar(dirs);
    return clases.reduce((n, c) => n + (c.tomas || [])
        .reduce((m, t) => m + (t.comentarios || []).length, 0), 0);
})()`;

/**
 * Deja a la vista un comentario de una clase ya terminada, y dice qué dice.
 *
 * Las tarjetas se abren por código porque abrirlas no es lo que se prueba —son
 * `details`, y cuál de las cuatro tiene el comentario no se sabe hasta abrirlas—.
 * Los dos gestos que sí se prueban, el clic sobre la palabra comentada y el del
 * botón, van con el mouse.
 */
async function conUnComentarioALaVista(wc) {
    const hay = await mirar(wc, `(async () => {
        for (const d of document.querySelectorAll('#grabar-grabadas details.clase')) d.open = true;
        await new Promise(r => setTimeout(r, 500));
        return Boolean(document.querySelector('#grabar-grabadas .toma-palabra.es-comentada'));
    })()`);
    if (!hay) return null;
    await clic(wc, '#grabar-grabadas .toma-palabra.es-comentada');
    await dormir(500);
    return mirar(wc, `((document.querySelector('#grabar-grabadas .toma-com .toma-com-texto')
        || {}).textContent || '').trim() || null`);
}

/** Mirar la lista del otro modo y volver, para dejarla como estaba. */
async function comoSeVePorFecha(wc) {
    await clic(wc, '.grabadas-modo[data-modo="fecha"]');
    await dormir(700);
    const visto = await mirar(wc, LO_QUE_SE_LISTA);
    await clic(wc, '.grabadas-modo[data-modo="carpetas"]');
    await dormir(700);
    return visto;
}

/* ─── El recorrido ───────────────────────────────────────────────────────── */

/**
 * Se anota lo que la ventana pregunta, y se contesta lo que se le diga.
 *
 * Va antes de todo y no dentro de un caso porque hay dos gestos que preguntan
 * —Terminar y Borrar— y la hoja del sistema BLOQUEA: sin esto, el primer
 * `window.confirm` deja la ventana esperando una respuesta que no hay forma de
 * darle desde acá, y la ronda entera se cuelga con todo en rojo por un motivo que
 * no es el de ninguna prueba.
 *
 * Y lo que se anota es lo que hace falta comprobar: qué se preguntó. El cartel de
 * borrar tiene que nombrar los archivos que se van, y eso solo se puede leer
 * atajándolo acá.
 */
async function atajarLosCarteles(wc) {
    await mirar(wc, `(() => {
        window.__preguntas = [];
        window.__respuesta = true;
        window.confirm = texto => {
            window.__preguntas.push(String(texto));
            return window.__respuesta;
        };
        return 'atajados';
    })()`);
}

const loUltimoQueSePregunto = wc => mirar(wc,
    '(window.__preguntas || []).slice(-1)[0] || null');

/** Con qué se le va a contestar al próximo cartel. */
const contestar = (wc, que) => mirar(wc,
    `(() => { window.__respuesta = ${que ? 'true' : 'false'}; return 'listo'; })()`);

/** Espera a que la lista termine de dibujarse, que tarda lo que tardan las carpetas. */
async function esperarLista(wc) {
    for (let n = 0; n < 100; n++) {
        const como = await comoEsta(wc);
        if (como.cual === 'lista' && como.cuantas > 0) { await dormir(300); return como; }
        await dormir(200);
    }
    throw new Error('la lista de clases no llegó a dibujarse');
}

function casos(wc) {
    /** La primera tarjeta de la lista, que es sobre la que se trabaja. */
    const primera = '#grabar-grabadas .clase';
    let alEmpezar = null;
    let antesDeQuitar = null;
    let trasQuitar = null;
    let laQuitada = null;
    let porFecha = null;
    let elComentario = null;
    let comentariosAntes = 0;

    return [
        {
            que: 'al entrar a Grabar se ve la lista de la carpeta, y no la toma de notas',
            hacer: async () => {
                await mirar(wc, 'window.dev.abrirGrabar()');
                alEmpezar = await esperarLista(wc);
            },
            ademas: async () => {
                if (alEmpezar.cual !== 'lista') return `se abrió en «${alEmpezar.cual}»`;
                if (alEmpezar.dos) return 'las dos pantallas están a la vez';
                if (!alEmpezar.cuantas) return 'la lista está vacía';
                return null;
            },
            shot: 'lista'
        },
        {
            que: 'y está el botón de comenzar, que no arranca ninguna toma',
            hacer: async () => {},
            ademas: async () => {
                const b = await mirar(wc, `(() => {
                    const e = document.getElementById('grabar-comenzar');
                    return e ? { texto: e.textContent.trim(), titulo: e.title } : null;
                })()`);
                if (!b) return 'no está el botón';
                if (b.texto !== 'Comenzar clase') return `dice «${b.texto}»`;
                // Lo que el usuario subrayó: esto entra a la interfaz, no graba.
                return /Todavía no graba/.test(b.titulo) ? null : `no aclara que no graba: «${b.titulo}»`;
            }
        },
        {
            que: 'comenzar clase entra a la toma de notas y ahí la lista no se muestra',
            hacer: async () => {
                await clic(wc, '#grabar-comenzar');
                await dormir(700);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'toma') return `quedó en «${c.cual}»`;
                if (c.listaEnLaToma) return 'la lista de grabadas sigue colgando de la toma de notas';
                if (!c.volverPuesto) return 'no hay botón de volver';
                if (c.volverApagado) return 'el botón de volver está apagado sin estar grabando';
                return null;
            },
            shot: 'toma-sin-grabar'
        },
        {
            que: 'y todavía no está grabando: entrar no arrancó nada',
            hacer: async () => {},
            ademas: async () => {
                const e = await mirar(wc, 'window.cc.grabarEstado()');
                return e ? 'hay una sesión grabando y nadie apretó Iniciar' : null;
            }
        },
        {
            que: 'el botón de arriba vuelve a la lista',
            hacer: async () => {
                await clic(wc, '#grabar-volver');
                await dormir(700);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'lista') return `quedó en «${c.cual}»`;
                return c.cuantas === alEmpezar.cuantas ? null
                    : `la lista cambió de ${alEmpezar.cuantas} a ${c.cuantas} clases`;
            }
        },
        {
            que: 'grabando, volver está apagado y dice por qué',
            // La decisión: no se sale de una grabación por un botón de navegar. El
            // motor niega renombrar y borrar la clase en curso, así que volver a la
            // lista mientras graba llevaría a una lista donde lo único que se
            // quiere tocar es justamente lo que no se puede.
            hacer: async () => {
                await clic(wc, '#grabar-comenzar');
                await dormir(500);
                await clicTexto(wc, '#grabar-pantalla-toma', 'Iniciar grabación');
                await dormir(1500);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'toma') return `quedó en «${c.cual}»`;
                if (!c.volverApagado) return 'volver quedó habilitado mientras graba';
                if (!/grab/i.test(c.volverPorque || '')) {
                    return `no explica por qué: «${c.volverPorque}»`;
                }
                return null;
            },
            shot: 'grabando-sin-volver'
        },
        {
            que: 'terminar enciende el botón de volver, que es lo único que lo señala',
            // No se salta solo a la lista: terminar deja la clase entera en pantalla
            // y quien la grabó suele querer mirarla antes de irse. Lo que cambia es
            // que ahora SE PUEDE ir, y el aviso lo dice porque el botón encendido no
            // se ve solo.
            hacer: async () => {
                await clicTexto(wc, '#grabar-pantalla-toma', 'Terminar');
                await dormir(4000);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                const pregunta = await loUltimoQueSePregunto(wc);
                if (!/Terminar la toma de notas/.test(pregunta || '')) {
                    return `terminar no preguntó: «${pregunta}»`;
                }
                if (c.cual !== 'toma') return `se fue solo a «${c.cual}»`;
                return c.volverApagado ? 'volver quedó apagado con la clase ya terminada' : null;
            },
            shot: 'terminada-ya-se-puede-volver'
        },
        {
            que: 'y al volver, la clase que se acaba de grabar está en la lista',
            hacer: async () => {
                await clic(wc, '#grabar-volver');
                await dormir(1200);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'lista') return `quedó en «${c.cual}»`;
                if (c.cuantas !== alEmpezar.cuantas + 1) {
                    return `la lista pasó de ${alEmpezar.cuantas} a ${c.cuantas}, y tenía que sumar una`;
                }
                return null;
            },
            shot: 'lista-con-la-nueva'
        },
        {
            que: 'renombrar abre el formulario, con la hora mostrada y no editable',
            hacer: async () => {
                await clicTexto(wc, primera, 'Renombrar');
                await dormir(500);
            },
            ademas: async () => {
                const f = await mirar(wc, COMO_ESTA_EL_FORMULARIO);
                if (!f) return 'no se abrió el formulario';
                if (f.horaEsCampo) return 'la hora quedó como un campo';
                if (!/no se cambia/.test(f.hora)) return `la hora no explica nada: «${f.hora}»`;
                if (!/Rodecaster/.test(f.hora)) return `no dice para qué sirve: «${f.hora}»`;
                return null;
            },
            shot: 'renombre-abierto'
        },
        {
            que: 'con un curso vacío el motor se niega, y el formulario lo dice y se queda',
            hacer: async () => {
                await clic(wc, '#grabar-grabadas .clase-renombre .clase-renombre-curso');
                await vaciarCampo(wc);
                await clicTexto(wc, '.clase-renombre', 'Guardar');
                await dormir(900);
            },
            ademas: async () => {
                const f = await mirar(wc, COMO_ESTA_EL_FORMULARIO);
                if (!f) return 'el formulario se cerró y el motivo se perdió';
                if (!f.mal) return 'no se mostró ningún motivo';
                return /curso/i.test(f.mal) ? null : `el motivo no habla del curso: «${f.mal}»`;
            },
            shot: 'renombre-negado'
        },
        {
            que: 'un número ya usado avisa que va a quedar como la parte siguiente',
            hacer: async () => {
                await clic(wc, '#grabar-grabadas .clase-renombre .clase-renombre-curso');
                await escribir(wc, 'curso-de-prueba');
                await clic(wc, '#grabar-grabadas .clase-renombre .grabar-num');
                await vaciarCampo(wc);
                // El 3 es una de las clases que la maqueta ya tiene puestas.
                await escribir(wc, '3');
                await dormir(400);
            },
            ademas: async () => {
                const f = await mirar(wc, COMO_ESTA_EL_FORMULARIO);
                if (!f) return 'se cerró el formulario';
                return /parte 2/.test(f.parte) ? null : `la marca de la parte dice «${f.parte}»`;
            },
            shot: 'renombre-parte-siguiente'
        },
        {
            que: 'y al guardar queda con ese número y esa parte, como se prometió',
            hacer: async () => {
                await clicTexto(wc, '.clase-renombre', 'Guardar');
                await dormir(1200);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.renombrando) return 'el formulario quedó abierto';
                const cual = c.nombres.find(n => /Clase 3 · parte 2/.test(n));
                return cual ? null : `en la lista quedaron: ${c.nombres.join(' | ')}`;
            },
            shot: 'renombrada'
        },
        {
            // El mismo guardado, con la tecla en vez del botón, porque no son el
            // mismo gesto para el repintado: con Enter el foco se queda en el campo
            // —el submit sale de ahí— y `pintar` no repinta mientras haya foco
            // adentro del formulario. Así estaba el defecto: el nombre nuevo llegaba
            // al disco, el formulario se quedaba abierto sobre una clase que ya se
            // llamaba de otra manera, y la lista mostraba el nombre viejo.
            que: 'y guardar con la tecla Enter cierra el formulario igual que el botón',
            hacer: async () => {
                await clicTexto(wc, primera, 'Renombrar');
                await dormir(500);
                await clic(wc, '#grabar-grabadas .clase-renombre .grabar-num');
                await vaciarCampo(wc);
                // Un número que la maqueta no tiene, así que el nombre nuevo se ve.
                await escribir(wc, '77');
                await tecla(wc, 'Enter');
                await dormir(1200);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.renombrando) return 'el formulario quedó abierto después de guardar';
                const cual = c.nombres.find(n => /Clase 77/.test(n));
                return cual ? null : `en la lista quedaron: ${c.nombres.join(' | ')}`;
            },
            shot: 'renombrada-con-enter'
        },
        {
            que: 'borrar pregunta primero, y el cartel nombra lo que se va del disco',
            hacer: async () => {
                await contestar(wc, false);
                await clicTexto(wc, primera, 'Borrar');
                await dormir(900);
            },
            ademas: async () => {
                const [pregunta, c] = await Promise.all([
                    loUltimoQueSePregunto(wc),
                    comoEsta(wc)
                ]);
                if (!pregunta) return 'no preguntó nada';
                for (const cosa of ['XML', 'archivo de datos', 'audio', 'papelera', 'deshacer']) {
                    if (!pregunta.includes(cosa)) return `el cartel no nombra «${cosa}»`;
                }
                // Y con un "no" no se borró nada, que es la mitad de tener cartel.
                return c.cuantas === alEmpezar.cuantas + 1 ? null
                    : `dijo que no y la lista quedó en ${c.cuantas}`;
            }
        },
        {
            que: 'diciendo que sí, la clase se va de la lista y no vuelve al repintar',
            hacer: async () => {
                await contestar(wc, true);
                await clicTexto(wc, primera, 'Borrar');
                await dormir(1200);
                // Un repintado más, para que una lista que se rehace de cero no la
                // traiga de vuelta.
                await mirar(wc, 'window.dev.abrirGrabar()');
                await dormir(900);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'lista') return `quedó en «${c.cual}»`;
                return c.cuantas === alEmpezar.cuantas ? null
                    : `la lista quedó en ${c.cuantas} y tenía que volver a ${alEmpezar.cuantas}`;
            },
            shot: 'borrada'
        },
        {
            que: 'borrar un comentario de una clase terminada también pregunta, y dice qué texto se va',
            // El otro «Borrar» de esta pantalla, y el que se pasa por alto: no se
            // lleva archivos, se lleva lo escrito. Reescribe el XML en el acto y
            // desde acá no hay Cmd-Z —el historial es de la clase que se graba—,
            // así que por el criterio de la casa tiene que preguntar igual que el
            // de la clase.
            hacer: async () => {
                elComentario = await conUnComentarioALaVista(wc);
                comentariosAntes = await mirar(wc, LOS_COMENTARIOS);
                await contestar(wc, false);
                await clicTexto(wc, '#grabar-grabadas .toma-com', 'Borrar');
                await dormir(900);
            },
            ademas: async () => {
                if (!elComentario) return 'ninguna clase de la lista trae un comentario que mirar';
                const pregunta = await loUltimoQueSePregunto(wc);
                if (!pregunta) return 'no preguntó nada';
                if (!pregunta.includes(elComentario.slice(0, 20))) {
                    return `el cartel no dice cuál se va: «${pregunta}»`;
                }
                if (!/Cmd-Z/.test(pregunta)) return `no avisa que de acá no vuelve: «${pregunta}»`;
                const ahora = await mirar(wc, LOS_COMENTARIOS);
                return ahora === comentariosAntes ? null
                    : `dijo que no y se fue igual: había ${comentariosAntes} y quedaron ${ahora}`;
            },
            shot: 'cartel-del-comentario'
        },
        {
            que: 'y diciendo que sí, ese comentario se va del XML',
            hacer: async () => {
                await conUnComentarioALaVista(wc);
                await contestar(wc, true);
                await clicTexto(wc, '#grabar-grabadas .toma-com', 'Borrar');
                await dormir(1200);
            },
            ademas: async () => {
                if (!elComentario) return 'ninguna clase de la lista trae un comentario que mirar';
                const ahora = await mirar(wc, LOS_COMENTARIOS);
                return ahora === comentariosAntes - 1 ? null
                    : `había ${comentariosAntes} comentarios y quedaron ${ahora}`;
            }
        },
        {
            que: 'la carpeta en uso no ofrece quitarse: dice «en uso»',
            // Si se pudiera, la lista quedaría sin carpeta donde grabar — y los
            // ajustes la devolverían igual al sanear (`engine/ajustes.js`), o sea
            // que el botón mentiría. Que no esté es la mitad de por qué quitar
            // funciona.
            hacer: async () => {
                await clic(wc, '.grabadas-modo[data-modo="carpetas"]');
                await dormir(700);
                antesDeQuitar = await mirar(wc, COMO_ESTAN_LAS_CARPETAS);
            },
            ademas: async () => {
                const c = antesDeQuitar;
                if (c.rutas.length < 2) return `hay ${c.rutas.length} carpeta(s) y con una sola no se prueba nada`;
                if (c.enUso.length !== 1) return `dicen «en uso» ${c.enUso.length} carpetas`;
                if (c.quitables.includes(c.enUso[0])) return `la carpeta en uso ofrece quitarse`;
                return c.quitables.length === c.rutas.length - 1 ? null
                    : `${c.quitables.length} botones para ${c.rutas.length} carpetas`;
            }
        },
        {
            que: '«Quitar de la lista» saca la ruta, y no vuelve en el repintado siguiente',
            hacer: async () => {
                laQuitada = await laCarpetaQuitable(wc);
                await clicTexto(wc, '[data-arnes-carpeta="1"]', 'Quitar de la lista');
                await dormir(900);
                trasQuitar = await mirar(wc, COMO_ESTAN_LAS_CARPETAS);
                // Y un repintado que rehace la lista de cero releyendo los
                // ajustes, que es exactamente donde la carpeta volvía.
                await mirar(wc, 'window.dev.abrirGrabar()');
                await dormir(900);
                porFecha = await comoSeVePorFecha(wc);
            },
            ademas: async () => {
                if (!laQuitada) return 'ninguna carpeta ofrecía quitarse';
                const c = await mirar(wc, COMO_ESTAN_LAS_CARPETAS);
                if (trasQuitar.rutas.includes(laQuitada)) return `la cabecera de «${laQuitada}» se quedó ahí`;
                if (c.rutas.includes(laQuitada)) return `volvió al repintar: ${c.rutas.join(' | ')}`;
                if (c.guardadas.includes(laQuitada)) {
                    return `se fue de la pantalla y quedó guardada: ${c.guardadas.join(' | ')}`;
                }
                return c.rutas.length === antesDeQuitar.rutas.length - 1 ? null
                    : `quedaron ${c.rutas.length} carpetas de ${antesDeQuitar.rutas.length}`;
            },
            shot: 'carpeta-quitada'
        },
        {
            que: 'y sus clases se van con ella, también en «Por fecha», que es donde no hay cabecera que las tape',
            hacer: async () => {},
            ademas: async () => {
                if (!porFecha) return 'no se llegó a mirar el modo por fecha';
                if (porFecha.modo !== 'fecha') return `se miró en modo «${porFecha.modo}»`;
                const curso = String(laQuitada).split('/').pop();
                if (!porFecha.titulos.some(t => t.includes('·'))) {
                    return `en este modo cada título dice su curso y ninguno lo dice: ${porFecha.titulos.join(' | ')}`;
                }
                // En este modo cada tarjeta dice de qué curso es, así que una
                // clase huérfana de la carpeta quitada se ve por su nombre.
                const huerfanas = porFecha.titulos.filter(t => t.includes(curso));
                if (huerfanas.length) return `quedaron clases de la carpeta quitada: ${huerfanas.join(' | ')}`;
                // Y la cuenta de arriba tiene que contar lo mismo que se dibuja:
                // si sobrara una clase invisible, sería la que quedó colgada.
                const dice = Number((porFecha.cuenta.match(/\d+/) || [])[0]);
                return dice === porFecha.titulos.length ? null
                    : `arriba dice «${porFecha.cuenta}» y hay ${porFecha.titulos.length} tarjetas`;
            },
            shot: 'por-fecha-sin-la-quitada'
        },
        {
            que: 'las teclas de las vistas no hacen nada desde la lista',
            // P/R/S/M/X son de la toma de notas. Desde la lista no tienen a quién
            // aplicarse, y el peor caso no es que no hagan nada: es que se las
            // coma la clase en curso que no se está mirando.
            hacer: async () => {
                await tecla(wc, 'p');
                await tecla(wc, 'x');
                await dormir(400);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.cual !== 'lista') return `una tecla cambió de pantalla: «${c.cual}»`;
                const e = await mirar(wc, 'window.cc.grabarEstado()');
                return e ? 'una tecla arrancó una grabación' : null;
            }
        },
        {
            que: 'ni desde el campo del renombre, que es donde se escriben letras',
            hacer: async () => {
                await clicTexto(wc, primera, 'Renombrar');
                await dormir(400);
                await clic(wc, '#grabar-grabadas .clase-renombre .clase-renombre-curso');
                await escribir(wc, 'xpsm');
                await dormir(300);
            },
            ademas: async () => {
                const f = await mirar(wc, COMO_ESTA_EL_FORMULARIO);
                if (!f) return 'se cerró el formulario mientras se escribía';
                return f.curso.includes("xpsm") ? null
                    : `lo escrito no llegó al campo: «${f.curso}»`;
            },
            shot: 'escribiendo-en-el-renombre'
        }
    ];
}

async function ronda(wc) {
    const fallas = [];
    for (const caso of casos(wc)) {
        let mal = null;
        try {
            await caso.hacer();
            if (caso.ademas) mal = await caso.ademas();
        } catch (e) {
            mal = e.message;
        }
        console.log(mal ? `  ✗ ${caso.que}\n      ${mal}` : `  ✓ ${caso.que}`);
        if (mal) fallas.push(`${caso.que}: ${mal}`);
        if (CAPTURAS && caso.shot) await capturar(wc, path.join(CAPTURAS, `${caso.shot}.png`));
    }
    console.log(`\n${casos(wc).length - fallas.length} pasaron · ${fallas.length} fallaron`);
    return fallas;
}

async function enElectron() {
    const { app, BrowserWindow } = electron;
    const url = cli.arg('url', `http://localhost:${PUERTO}/`);
    const [w, h] = MEDIDA.split('x').map(Number);

    await app.whenReady();
    const win = new BrowserWindow({
        width: w,
        height: h,
        show: process.argv.includes('--ver'),
        webPreferences: { backgroundThrottling: false }
    });
    win.setContentSize(w, h);
    if (process.argv.includes('--consola')) {
        win.webContents.on('console-message', (_e, _n, texto) => console.log(`  [ventana] ${texto}`));
    }

    let codigo = 0;
    try {
        await win.loadURL(url);
        // Las carpetas de la maqueta se cargan solas al abrir, y tardan.
        await dormir(2500);
        await atajarLosCarteles(win.webContents);
        codigo = (await ronda(win.webContents)).length ? 1 : 0;
    } catch (e) {
        console.error(`el arnés se cayó: ${e && e.stack ? e.stack : e}`);
        codigo = 1;
    }
    app.exit(codigo);
}

if (typeof electron === 'string') enNode();
else enElectron();
