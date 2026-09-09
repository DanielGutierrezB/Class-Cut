'use strict';
/**
 * probar-repintado.js — Gestos de verdad sobre la pantalla de Grabar, y una sola
 * pregunta después de cada uno:
 *
 *   **para toda toma, la vista que muestra su tarjeta es la que dice el motor.**
 *
 *   node tools/probar-repintado.js
 *   node tools/probar-repintado.js --ver --capturas=/tmp
 *   node tools/probar-repintado.js --paso='{"clicSel":"#grabar-compact"}' --paso='{"shot":"/tmp/x.png"}'
 *
 * Para qué, y por qué no alcanza `tests/run.js`. Los bugs de esta pantalla que
 * más caro salieron no están en ninguna decisión: están en el REPINTADO. El
 * último —el que motivó esto— era que la tarjeta que se acababa de tocar era la
 * única que no se redibujaba, porque `tarjetasOcupadas` la daba por ocupada al
 * ver el foco que Chromium le acababa de dar al botón apretado. El motor
 * escribía bien, el XML quedaba bien y `tomas.pintar` recibía el estado bueno:
 * lo único que estaba mal era lo que había en pantalla. Ninguna prueba sin
 * navegador puede ver eso, y por eso el arnés no es un lujo del que lo escribió
 * sino la única red que hay para esa familia entera. Lo que sí se puede probar
 * sin pantalla —qué tecla es cada vista, sobre qué toma actúan, qué respuesta se
 * tira por atrasada— está en `tests/teclas.test.js` y `tests/turnos.test.js`.
 *
 * Cómo. Levanta la maqueta en un puerto propio (`tools/maqueta.js`, datos de
 * mentira, sin Rodecaster ni carpeta de curso), abre una ventana de Electron
 * contra ella y manda CLICS Y TECLAS DE VERDAD con `sendInputEvent`. Eso último
 * es la mitad del asunto: `elemento.click()` no mueve el foco como lo mueve el
 * mouse, y el foco era justamente el bug. Un arnés que hiciera clic con JS
 * habría pasado en verde.
 *
 * Puerto propio (4399) y no el 4321: la maqueta de quien está mirando el diseño
 * no se pisa. Al terminar se apagan la ventana y el servidor.
 *
 * Con `--url` se corre contra otra cosa —la app de verdad abierta con
 * `--remote-debugging`, otra maqueta ya levantada— y entonces no se levanta
 * nada. La ronda de gestos supone la sesión de la maqueta (cuatro tomas, la 3
 * descartada, la 4 abierta), así que contra otro estado hay que usar `--paso`.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
// En Node es la ruta al binario; adentro de Electron, su API. Este archivo es
// las dos cosas: `node tools/probar-repintado.js` levanta la maqueta y se llama
// a sí mismo con Electron, que es quien puede abrir una ventana.
const electron = require('electron');
const cli = require('./lib/cli');

const PUERTO = Number(cli.arg('puerto', 4399));
const MEDIDA = String(cli.arg('size', '1400x1000'));
/** Dónde caen las capturas de la ronda. Sin esto no se saca ninguna. */
const CAPTURAS = cli.arg('capturas', null);

const dormir = ms => new Promise(r => setTimeout(r, ms));
const banderas = nombre => process.argv
    .filter(a => a.startsWith(`--${nombre}=`))
    .map(a => a.slice(nombre.length + 3));

/* ─── Del lado de Node: la maqueta y la ventana ──────────────────────────── */

/** Espera a que el servidor conteste, que tarda lo que tarde en arrancar. */
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
    const url = cli.arg('url') || `http://localhost:${PUERTO}/?grabando`;
    let maqueta = null;

    if (propia) {
        maqueta = spawn(process.execPath, [path.join(__dirname, 'maqueta.js'), `--puerto=${PUERTO}`], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'ignore', 'inherit']
        });
        // La primera vez, la maqueta arma el video y el audio de relleno con
        // ffmpeg y eso tarda unos segundos.
        await esperarMaqueta(url, Date.now() + 90000);
        console.log(`maqueta en ${url}`);
    }

    const env = { ...process.env };
    // Sin esto, Electron arranca como un Node pelado y no abre ninguna ventana.
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

/** Lo que un paso mira: se evalúa en la ventana y se imprime lo que devuelva. */
async function mirar(wc, js) {
    return wc.executeJavaScript(js);
}

/**
 * Dónde está un elemento, en coordenadas de la ventana, después de subirlo a la
 * vista.
 *
 * Las coordenadas a mano no sirven en esta pantalla: la lista mide distinto
 * según cuántas tomas haya y el scroll se pega al fondo solo. Se pregunta cada
 * vez, y si el elemento quedó fuera de la ventana se dice en vez de mandar un
 * clic al aire —un clic en el vacío no falla, y ahí el arnés estaría probando
 * nada en verde.
 */
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

/** Un clic del mouse, con el foco que mueve un clic del mouse. */
async function clic(wc, sel) {
    const { x, y } = await donde(wc, sel);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await dormir(120);
}

/**
 * Una tecla de verdad.
 *
 * Fabricada con `new KeyboardEvent` no arrastra la acción del navegador, y acá
 * lo que se está probando es un atajo del documento: hace falta que el evento
 * venga de donde vienen los del teclado.
 */
async function tecla(wc, k) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    await dormir(200);
}

/**
 * Escribir en el campo que tenga el foco, letra por letra.
 *
 * Poniendo `campo.value` desde JS no se dispara el `change` del navegador, así
 * que el texto no llega nunca al motor: una prueba escrita así dice que se
 * perdió lo que se estaba escribiendo cuando lo que pasó es que nadie lo
 * escribió. Es el mismo motivo por el que los clics van por `sendInputEvent`.
 */
async function escribir(wc, texto) {
    for (const letra of texto) await tecla(wc, letra);
}

/**
 * Arrastrar un elemento `dx` píxeles, en pasos.
 *
 * Con pasos intermedios porque el gesto se escucha en `pointermove`: un salto
 * de un punto al otro mueve el borde una palabra y se traba.
 */
async function arrastrar(wc, sel, dx) {
    const { x, y } = await donde(wc, sel);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await dormir(40);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 16; i++) {
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x + (dx * i) / 16), y });
        await dormir(25);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: x + dx, y, button: 'left', clickCount: 1 });
    await dormir(300);
}

async function capturar(wc, archivo) {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, (await wc.capturePage()).toPNG());
    console.log(`  captura: ${archivo}`);
}

/** Un paso escrito a mano en la línea de comandos (`--paso='{…}'`). */
async function correrPaso(wc, paso) {
    if (paso.js) {
        const salida = await mirar(wc, paso.js);
        if (salida !== undefined) console.log(JSON.stringify(salida));
    }
    if (paso.clicSel) await clic(wc, paso.clicSel);
    if (paso.tecla) await tecla(wc, paso.tecla);
    if (paso.arrastreSel) await arrastrar(wc, paso.arrastreSel[0], paso.arrastreSel[1]);
    if (paso.rueda) {
        const [x, y, dy] = paso.rueda;
        wc.sendInputEvent({
            type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy,
            wheelTicksX: 0, wheelTicksY: dy / 40, canScroll: true
        });
    }
    await dormir(paso.espera == null ? 250 : paso.espera);
    if (paso.shot) await capturar(wc, paso.shot);
}

/* ─── La invariante ──────────────────────────────────────────────────────── */

/**
 * Lo que dice el motor y lo que muestra la pantalla, en la misma forma.
 *
 * El estado se le pide por el mismo camino que lo pide la ventana
 * (`window.cc.grabarEstado`), así que esto sirve igual contra la maqueta y
 * contra la app de verdad. Las descartadas quedan fuera de los dos lados: su
 * tarjeta se pliega sin los botones de vista, así que no hay nada que comparar.
 *
 * Se comparan cadenas y no objetos para que el fallo se lea de un vistazo: al
 * lado de «1=PV 2=R 4=S» se ve cuál de las cuatro se quedó atrás.
 */
const INVARIANTE = `(async () => {
    const e = await window.cc.grabarEstado();
    const motor = (e ? e.tomas : []).filter(t => !t.descartada)
        .map(t => t.id + '=' + t.vista).join(' ');
    const dom = [...document.querySelectorAll('#grabar-tomas .toma:not(.es-descartada)')]
        .map(c => {
            const puesta = c.querySelector('.toma-vista-btn.is-elegida');
            return c.dataset.toma + '=' + (puesta ? puesta.textContent : '—');
        })
        .join(' ');
    return { motor, dom };
})()`;

async function invariante(wc) {
    const { motor, dom } = await mirar(wc, INVARIANTE);
    if (motor === dom) return null;
    return `el motor dice «${motor}» y la pantalla muestra «${dom}»`;
}

/** Espera a que la maqueta termine de armar la sesión. */
async function esperarSesion(wc) {
    for (let n = 0; n < 100; n++) {
        const cuantas = await mirar(wc, "document.querySelectorAll('#grabar-tomas .toma').length");
        if (cuantas >= 4) { await dormir(400); return cuantas; }
        await dormir(200);
    }
    throw new Error('la pantalla de Grabar no llegó a dibujar sus tomas');
}

const boton = (toma, vista) => `#grabar-tomas .toma[data-toma="${toma}"] .toma-vista-btn[data-vista="${vista}"]`;
const cabeza = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-cuando`;
const nota = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-nota`;

/** Qué vista muestra la tarjeta de una toma, leído del DOM y de nadie más. */
const enPantalla = toma => `(() => {
    const b = document.querySelector('#grabar-tomas .toma[data-toma="${toma}"] .toma-vista-btn.is-elegida');
    return b ? b.textContent : null;
})()`;

/**
 * La ronda: los gestos con los que se toca una toma, uno por uno.
 *
 * Son los que pasan por `acciones.alCambiar`, que es el único camino por el que
 * la pantalla cambia algo: el botón de vista, la tecla, el descarte, el borde
 * arrastrado. Cada uno se hace de verdad y detrás va la misma pregunta. Y son
 * varios y no uno porque el defecto no estaba en el gesto sino en lo que los
 * cinco comparten —el repintado—, así que el que lo destapa puede ser cualquiera.
 *
 * `ademas` es lo propio de cada caso: la invariante dice que la pantalla y el
 * motor coinciden, no que el cambio haya caído en la toma que se tocó.
 */
function casos(wc) {
    return [
        {
            que: 'al abrir, la pantalla y el motor ya dicen lo mismo',
            hacer: async () => {}
        },
        {
            que: 'el botón de vista de una toma vieja repinta SU tarjeta',
            // El bug original entero: el foco se queda en el botón apretado, y
            // con eso la tarjeta de esa toma era la única que no se rehacía.
            hacer: () => clic(wc, boton(1, 'MG')),
            ademas: async () => {
                const puesta = await mirar(wc, enPantalla(1));
                return puesta === 'MG' ? null : `la toma 1 quedó mostrando ${puesta}`;
            }
        },
        {
            que: 'el botón de vista de la toma abierta también',
            hacer: () => clic(wc, boton(4, 'S')),
            ademas: async () => {
                const puesta = await mirar(wc, enPantalla(4));
                return puesta === 'S' ? null : `la toma 4 quedó mostrando ${puesta}`;
            }
        },
        {
            que: 'sin ninguna toma elegida, la tecla cae en la abierta y la marca lo dice',
            hacer: () => tecla(wc, 'r'),
            ademas: async () => {
                const [puesta, marcadas] = await Promise.all([
                    mirar(wc, enPantalla(4)),
                    mirar(wc, `[...document.querySelectorAll('#grabar-tomas .toma.es-elegida')]
                        .map(c => c.dataset.toma)`)
                ]);
                if (puesta !== 'R') return `la abierta quedó en ${puesta}, no en R`;
                return marcadas.join(' ') === '4' ? null : `la marca está en «${marcadas.join(' ')}»`;
            }
        },
        {
            que: 'con la toma 1 elegida, la tecla cae en la toma 1 y no en la abierta',
            hacer: async () => {
                await clic(wc, cabeza(1));
                await tecla(wc, 'x');
            },
            ademas: async () => {
                const [una, abierta, marcada] = await Promise.all([
                    mirar(wc, enPantalla(1)),
                    mirar(wc, enPantalla(4)),
                    mirar(wc, "document.querySelectorAll('#grabar-tomas .toma.es-elegida').length")
                ]);
                if (una !== 'X2') return `la elegida quedó en ${una}, no en X2`;
                if (abierta !== 'R') return `la tecla se le fue a la abierta, que quedó en ${abierta}`;
                if (marcada !== 1) return `la marca de elegida está en ${marcada} tarjetas`;
                return null;
            }
        },
        {
            que: 'descartar la toma elegida devuelve las teclas a la abierta',
            // El borde de la elección: una descartada no va al XML y su tarjeta se
            // pliega sin botones, así que la tecla no puede seguir apuntándole. Y
            // la marca tiene que mudarse en el mismo repintado, no después.
            hacer: async () => {
                await clic(wc, cabeza(1));
                await clic(wc, `#grabar-tomas .toma[data-toma="1"] .toma-cabeza .btn-ghost`);
                await tecla(wc, 'p');
            },
            ademas: async () => {
                const [marcadas, abierta] = await Promise.all([
                    mirar(wc, `[...document.querySelectorAll('#grabar-tomas .toma.es-elegida')]
                        .map(c => c.dataset.toma)`),
                    mirar(wc, enPantalla(4))
                ]);
                if (marcadas.join(' ') !== '4') return `la marca quedó en «${marcadas.join(' ')}»`;
                return abierta === 'PV' ? null : `la tecla no cayó en la abierta, que muestra ${abierta}`;
            }
        },
        {
            que: 'recuperar la deja como estaba y se la puede volver a elegir',
            hacer: async () => {
                await clic(wc, `#grabar-tomas .toma[data-toma="1"] .toma-cabeza .btn-ghost`);
                await clic(wc, cabeza(1));
            },
            ademas: async () => {
                const marcadas = await mirar(wc, `[...document.querySelectorAll('#grabar-tomas .toma.es-elegida')]
                    .map(c => c.dataset.toma)`);
                return marcadas.join(' ') === '1' ? null : `la marca quedó en «${marcadas.join(' ')}»`;
            }
        },
        {
            que: 'seleccionar texto para comentar elige esa toma y no dispara las teclas',
            // Los dos lados del mismo gesto. Uno: soltar una selección termina en
            // un clic dentro de la ficha, y eso elige la toma —seleccionar para
            // comentar es trabajar sobre esa toma, así que el clic no pierde su
            // sentido por venir con texto seleccionado—. El otro: con el foco en
            // la caja del comentario, la S es una letra y no un atajo, que es la
            // regla de siempre (`estaEscribiendo`).
            hacer: async () => {
                await arrastrar(wc, `#grabar-tomas .toma[data-toma="2"] .toma-palabra:not(.es-orilla)`, 260);
                await dormir(400);
                await tecla(wc, 's');
            },
            ademas: async () => {
                const como = await mirar(wc, `(() => ({
                    marcadas: [...document.querySelectorAll('#grabar-tomas .toma.es-elegida')].map(c => c.dataset.toma),
                    caja: [...document.querySelectorAll('#grabar-tomas .toma.es-comentando')].map(c => c.dataset.toma),
                    foco: document.activeElement.className,
                    escrito: (document.querySelector('.toma-com-campo') || {}).value
                }))()`);
                if (como.caja.join(' ') !== '2') return `la caja de comentario abrió en «${como.caja.join(' ')}»`;
                if (como.marcadas.join(' ') !== '2') return `la marca quedó en «${como.marcadas.join(' ')}»`;
                if (!/toma-com-campo/.test(como.foco)) return `el foco quedó en «${como.foco}»`;
                return como.escrito === 's' ? null : `la S no se escribió en la caja: «${como.escrito}»`;
            }
        },
        {
            que: 'cerrada la caja, la tecla cae en la toma que quedó elegida',
            // Con "Cancelar" y no con Escape: adentro de un campo manda el
            // deshacer y las letras del campo, Escape incluido, y la caja se
            // cierra soltándola (ver `queHace` y `tests/teclas.test.js`). Lo que
            // importa acá es lo de después: la toma que se eligió al seleccionar
            // sigue siendo la elegida cuando el teclado vuelve a estar libre.
            hacer: async () => {
                await clic(wc, '#grabar-tomas .toma.es-comentando .toma-com.es-nuevo .btn-ghost');
                await tecla(wc, 'm');
            },
            ademas: async () => {
                const [caja, dos] = await Promise.all([
                    mirar(wc, "document.querySelectorAll('#grabar-tomas .toma.es-comentando').length"),
                    mirar(wc, enPantalla(2))
                ]);
                if (caja !== 0) return 'la caja del comentario quedó abierta';
                return dos === 'MG' ? null : `la tecla no cayó en la elegida, que muestra ${dos}`;
            }
        },
        {
            que: 'descartar y recuperar deja la vista donde estaba',
            hacer: async () => {
                await clic(wc, `#grabar-tomas .toma[data-toma="2"] .toma-cabeza .btn-ghost`);
                await clic(wc, `#grabar-tomas .toma[data-toma="2"] .toma-cabeza .btn-ghost`);
            }
        },
        {
            que: 'arrastrar el IN de una toma no le cambia la vista a nadie',
            hacer: () => arrastrar(wc, '#grabar-tomas .toma[data-toma="2"] .toma-borde.es-in', 140),
            ademas: async () => {
                const movio = await mirar(wc, `(() => {
                    const t = document.querySelector('#grabar-tomas .toma[data-toma="2"]');
                    return t.querySelectorAll('.toma-palabra.es-orilla').length;
                })()`);
                return movio > 3 ? null : `el arrastre no movió el borde (${movio} orillas)`;
            }
        },
        {
            que: 'la tarjeta donde se escribe se queda quieta y su nota llega al motor',
            // La tarjeta donde alguien escribe no se rehace a propósito: sacarla
            // del documento le quitaría el foco a media palabra. La que se acaba
            // de tocar, en cambio, sí: son dos tarjetas distintas, y confundirlas
            // fue el bug. Acá se escribe en la 2 y se toca la 1.
            hacer: async () => {
                await clic(wc, nota(2));
                await escribir(wc, ' hola');
                await clic(wc, cabeza(1));
                await dormir(400);
            },
            ademas: async () => {
                const [escrito, enElMotor] = await Promise.all([
                    mirar(wc, `(() => {
                        const n = document.querySelector('#grabar-tomas .toma[data-toma="2"] .toma-nota');
                        return n ? n.value : null;
                    })()`),
                    mirar(wc, `(async () => {
                        const e = await window.cc.grabarEstado();
                        const t = e.tomas.find(x => x.id === 2);
                        return t ? t.comentario : null;
                    })()`)
                ]);
                if (!/hola$/.test(String(enElMotor))) return `la nota no llegó al motor: «${enElMotor}»`;
                return escrito === enElMotor
                    ? null
                    : `el campo dice «${escrito}» y el motor «${enElMotor}»`;
            }
        },
        {
            que: 'un botón de vista con una nota a medio escribir no deja la pantalla mintiendo',
            // Este gesto manda DOS pedidos al motor de una sola vez: al apretar, el
            // campo pierde el foco y su `change` manda la nota, y detrás va el
            // cambio de vista.
            //
            // Lo que se comprueba es la invariante y nada más, y hay que decir por
            // qué: la nota repinta la lista, y ese repintado puede caer ENTRE el
            // mousedown y el mouseup del mismo clic. La tarjeta se reemplaza en el
            // medio, así que los dos eventos llegan a nodos distintos y el
            // navegador no dispara ningún `click`: el botón se aprieta y no pasa
            // nada. Está medido —se espiaron los tres eventos— y es un resto
            // conocido que se arregla del lado del repintado (reusar la tarjeta en
            // vez de reemplazarla), no de acá. Que la pantalla y el motor sigan
            // diciendo lo mismo cuando el clic se pierde es exactamente lo que
            // esta ronda tiene que garantizar.
            hacer: async () => {
                await clic(wc, nota(2));
                await escribir(wc, ' chau');
                await clic(wc, boton(1, 'PV'));
                await dormir(600);
            }
        },
        {
            que: 'dos gestos seguidos, con la primera respuesta atrasada',
            // La carrera: el motor aplica los dos cambios en orden —el canal es
            // uno—, pero las respuestas pueden volver al revés, y la vieja no
            // trae el segundo cambio. Se demora la primera a propósito porque
            // provocarlo a mano es cuestión de suerte; lo que se demora es SOLO
            // la respuesta, así que el motor sigue viendo lo que vería siempre.
            hacer: async () => {
                await mirar(wc, `(() => {
                    const antes = window.cc.grabarEditar;
                    let n = 0;
                    window.cc.grabarEditar = async cambio => {
                        const mio = ++n;
                        const estado = await antes(cambio);
                        await new Promise(r => setTimeout(r, mio === 1 ? 900 : 0));
                        return estado;
                    };
                    return 'puente demorado';
                })()`);
                await clic(wc, boton(1, 'R'));
                await clic(wc, boton(4, 'MG'));
                await dormir(1600);
            },
            ademas: async () => {
                const [una, cuatro] = await Promise.all([
                    mirar(wc, enPantalla(1)),
                    mirar(wc, enPantalla(4))
                ]);
                if (una !== 'R') return `el primer cambio se perdió: la toma 1 muestra ${una}`;
                return cuatro === 'MG' ? null : `el segundo cambio se perdió: la toma 4 muestra ${cuatro}`;
            }
        },
        {
            que: 'cerrar la abierta no le quita la elección a la que estaba elegida',
            // El otro borde: la elección es explícita y se respeta aunque debajo
            // cambie el paisaje. Quien eligió la toma 1 para arreglarle la vista
            // no cambió de idea porque "Pausa" haya cerrado la toma que corría, y
            // la marca sigue diciendo dónde va a caer la tecla.
            hacer: async () => {
                await clic(wc, cabeza(1));
                await clic(wc, '#grabar-cerrar-toma');
                await dormir(400);
                await tecla(wc, 's');
            },
            ademas: async () => {
                const como = await mirar(wc, `(() => ({
                    marcadas: [...document.querySelectorAll('#grabar-tomas .toma.es-elegida')].map(c => c.dataset.toma),
                    abiertas: document.querySelectorAll('#grabar-tomas .toma.es-abierta').length
                }))()`);
                const una = await mirar(wc, enPantalla(1));
                if (como.abiertas !== 0) return 'la toma no se cerró';
                if (como.marcadas.join(' ') !== '1') return `la marca quedó en «${como.marcadas.join(' ')}»`;
                return una === 'S' ? null : `la tecla no cayó en la elegida, que muestra ${una}`;
            }
        }
    ];
}

async function ronda(wc) {
    const fallas = [];
    let n = 0;
    for (const caso of casos(wc)) {
        n++;
        let mal = null;
        try {
            await caso.hacer();
            mal = await invariante(wc);
            if (!mal && caso.ademas) mal = await caso.ademas();
        } catch (e) {
            mal = e.message;
        }
        console.log(mal ? `  ✗ ${caso.que}\n      ${mal}` : `  ✓ ${caso.que}`);
        if (mal) fallas.push(`${caso.que}: ${mal}`);
        if (CAPTURAS) {
            await capturar(wc, path.join(CAPTURAS, `repintado-${String(n).padStart(2, '0')}.png`));
        }
    }
    console.log(`\n${casos(wc).length - fallas.length} pasaron · ${fallas.length} fallaron`);
    return fallas;
}

async function enElectron() {
    const { app, BrowserWindow } = electron;
    const url = cli.arg('url', `http://localhost:${PUERTO}/?grabando`);
    const [w, h] = MEDIDA.split('x').map(Number);

    await app.whenReady();
    const win = new BrowserWindow({
        width: w,
        height: h,
        // Escondida salvo que la pidan: esto corre al lado de otras cosas y una
        // ventana que se roba el foco cada vez molesta más de lo que muestra.
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
        await esperarSesion(win.webContents);
        const pasos = banderas('paso');
        if (pasos.length) {
            for (const crudo of pasos) await correrPaso(win.webContents, JSON.parse(crudo));
        } else {
            codigo = (await ronda(win.webContents)).length ? 1 : 0;
        }
    } catch (e) {
        console.error(`el arnés se cayó: ${e && e.stack ? e.stack : e}`);
        codigo = 1;
    }
    app.exit(codigo);
}

if (typeof electron === 'string') enNode();
else enElectron();
