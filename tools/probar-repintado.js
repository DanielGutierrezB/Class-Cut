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
 * Escribir varios renglones, con Enter entre uno y otro.
 *
 * La lista del CD llega en renglones y es lo que decide cuántos objetivos hay,
 * así que pegarla en una sola línea probaría un caso que no es el de nadie.
 */
async function escribirRenglones(wc, renglones) {
    for (const [i, renglon] of renglones.entries()) {
        if (i) await tecla(wc, 'Enter');
        await escribir(wc, renglon);
    }
}

/**
 * Vuelve a preguntar hasta que la respuesta deje de ser nula, o se rinde.
 *
 * Lo que se mide con el modelo tarda —acá unos segundos, en la app un par de
 * minutos— y dormir un número fijo es la forma de tener un arnés que falla los
 * martes: de más, la ronda se hace eterna; de menos, se pone roja sin que nada
 * esté mal. Se pregunta por lo que se está esperando y se corta cuando llega.
 */
async function esperarA(wc, js, cuanto) {
    const hasta = Date.now() + (cuanto || 15000);
    for (;;) {
        const r = await mirar(wc, js);
        if (r) return r;
        if (Date.now() > hasta) return null;
        await dormir(300);
    }
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

/**
 * Un clic que solo quiere decir "esta toma": una palabra suelta de su cuerpo.
 *
 * Antes esto era el cabezal —`.toma-cuando`, la hora— y ya no vale: tocar el
 * cabezal PLIEGA la tarjeta además de elegirla, así que un paso que solo quería
 * elegir se llevaba por delante el texto de la toma y el paso siguiente no
 * encontraba ni la nota ni las palabras. Es la misma trampa que el "primer botón
 * de la cabecera" que pasó de recuperar una toma a eliminarla: un selector
 * escrito por dónde estaba la cosa y no por lo que el gesto significa.
 *
 * Sin las orillas —ahí empieza el arrastre del borde— y sin las subrayadas, que
 * abren su comentario al margen.
 */
const enLaTarjeta = toma =>
    `#grabar-tomas .toma[data-toma="${toma}"] .toma-palabra:not(.es-orilla):not(.es-comentada)`;

/** El cabezal, donde el clic pliega y despliega. La hora: no es ningún control. */
const cabezal = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-cuando`;
const nota = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-nota`;
/** La primera palabra subrayada de una toma: el clic ahí abre su comentario. */
const comentada = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-palabra.es-comentada`;
const palabra = toma => `#grabar-tomas .toma[data-toma="${toma}"] .toma-palabra:not(.es-orilla)`;

/** Cómo está el margen de una toma, y qué vista muestra su tarjeta. */
const comoEstaElMargen = toma => `(() => {
    const t = document.querySelector('#grabar-tomas .toma[data-toma="${toma}"]');
    if (!t) return null;
    const puesta = t.querySelector('.toma-vista-btn.is-elegida');
    return {
        puesta: puesta ? puesta.textContent : null,
        abierto: t.classList.contains('es-comentando'),
        cuantos: t.querySelectorAll('.toma-margen .toma-com').length,
        resaltadas: t.querySelectorAll('.toma-palabra.es-abierta').length,
        escrito: (t.querySelector('.toma-com-campo') || {}).value
    };
})()`;

/**
 * Cómo está el pliegue de una toma, y si sigue diciendo dónde caen las teclas.
 *
 * Las dos cosas en la misma lectura y no en dos: el pliegue y la marca de elegida
 * viven los dos en el cabezal, que es lo único que queda de una tarjeta plegada,
 * y lo que hay que poder ver es justamente que no se pisan.
 *
 * El "· teclas" es un `::after` de CSS, así que no está en el texto del nodo: se
 * pregunta al estilo calculado, que es el único sitio donde existe.
 */
const comoEstaElPliegue = toma => `(() => {
    const t = document.querySelector('#grabar-tomas .toma[data-toma="${toma}"]');
    if (!t) return null;
    const marca = t.querySelector('.toma-pliegue');
    const n = t.querySelector('.toma-n');
    return {
        plegada: t.classList.contains('es-plegada'),
        resumen: Boolean(t.querySelector('.toma-resumen')),
        palabras: t.querySelectorAll('.toma-palabra').length,
        plegable: Boolean(t.querySelector(':scope > .toma-cabeza.es-plegable')),
        triangulo: marca ? marca.textContent : null,
        expandido: marca ? marca.getAttribute('aria-expanded') : null,
        elegida: t.classList.contains('es-elegida'),
        dicePorQue: /teclas/.test(getComputedStyle(n, '::after').content || '')
    };
})()`;

/**
 * El bloque de cobertura del temario, leído del DOM y de nadie más.
 *
 * Las tres filas de arriba van enteras porque son las que el usuario vio en
 * guion: lo que hace falta poder ver es que dejan de estarlo cuando hay una
 * medición, y que vuelven al guion mientras se está midiendo otra vez.
 */
const COMO_ESTA_EL_TEMARIO = `(() => {
    const b = document.querySelector('#grabar-analisis [data-bloque="temario"]');
    if (!b) return null;
    const caja = b.querySelector('.temario-caja');
    return {
        hayCaja: Boolean(caja),
        abierta: Boolean(caja && caja.open),
        resumen: ((b.querySelector('.temario-summary') || {}).textContent || '').trim(),
        filas: [...b.querySelectorAll('dd')].map(d => d.textContent.trim()),
        temas: [...b.querySelectorAll('.temario-tema')].map(e => e.textContent),
        faltan: b.querySelectorAll('.temario-lista.es-falta li').length
    };
})()`;

/** Cuándo se midió la cobertura que el motor tiene ahora, o null si no hay. */
const CUANDO_SE_MIDIO = `(async () => {
    const e = await window.cc.grabarEstado();
    const c = e && e.temario ? e.temario.cobertura : null;
    return c ? c.medidoEn : null;
})()`;

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
    /** Cuándo quedó medida la lista que pegó el arnés, para ver que se vuelve a medir. */
    let medidoAlPegar = null;

    return [
        {
            que: 'al abrir, la pantalla y el motor ya dicen lo mismo',
            hacer: async () => {}
        },
        {
            que: 'el gesto de plegar lo ofrecen las cerradas, y la abierta y la descartada no',
            // Acá y no al final: es el único momento de la ronda en que hay una
            // toma abierta y una descartada a la vez (la 4 y la 3), que son
            // justamente las dos que no se pliegan. Y se les toca el cabezal de
            // verdad: la promesa es que ahí no pasa nada, no que no haya cursor.
            hacer: async () => {
                await clic(wc, cabezal(4));
                await clic(wc, cabezal(3));
            },
            ademas: async () => {
                const como = await mirar(wc, `(() => {
                    const ids = sel => [...document.querySelectorAll(sel)].map(c => c.dataset.toma);
                    return {
                        plegables: ids('#grabar-tomas .toma:has(> .toma-cabeza.es-plegable)'),
                        abiertaPlegable: document.querySelectorAll('#grabar-tomas .toma.es-abierta .toma-cabeza.es-plegable').length,
                        descartadaPlegable: document.querySelectorAll('#grabar-tomas .toma.es-descartada .toma-cabeza.es-plegable').length,
                        triangulos: document.querySelectorAll('#grabar-tomas .toma-pliegue').length,
                        plegadas: ids('#grabar-tomas .toma.es-plegada'),
                        marcadas: ids('#grabar-tomas .toma.es-elegida')
                    };
                })()`);
                if (como.plegadas.length) return `algo se plegó: «${como.plegadas.join(' ')}»`;
                if (como.abiertaPlegable) return 'la toma abierta se dibuja como plegable';
                if (como.descartadaPlegable) return 'una descartada se dibuja como plegable';
                if (como.plegables.join(' ') !== '1 2') return `las plegables son «${como.plegables.join(' ')}»`;
                if (como.triangulos !== 2) return `hay ${como.triangulos} triangulitos y tendrían que ser 2`;
                // El clic en la descartada no la elige —no va al XML— así que la
                // marca vuelve a la abierta, que es lo de siempre.
                return como.marcadas.join(' ') === '4' ? null : `la marca quedó en «${como.marcadas.join(' ')}»`;
            }
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
                await clic(wc, enLaTarjeta(1));
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
                await clic(wc, enLaTarjeta(1));
                await clic(wc, `#grabar-tomas .toma[data-toma="1"] .toma-descartar`);
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
                await clic(wc, `#grabar-tomas .toma[data-toma="1"] .toma-descartar`);
                await clic(wc, enLaTarjeta(1));
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
                await clic(wc, `#grabar-tomas .toma[data-toma="2"] .toma-descartar`);
                await clic(wc, `#grabar-tomas .toma[data-toma="2"] .toma-descartar`);
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
                await clic(wc, enLaTarjeta(1));
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
            que: 'un botón de vista apretado con una nota a medio escribir no pierde el clic',
            // Este gesto manda DOS pedidos al motor de una sola vez: al apretar, el
            // campo pierde el foco y su `change` manda la nota, y detrás va el
            // cambio de vista.
            //
            // Y el segundo se perdía. El repintado que dispara la nota cae ENTRE el
            // mousedown y el mouseup del mismo clic —el `change` sale del propio
            // mousedown y la respuesta del motor vuelve en un microtask, o sea
            // antes de que el mouseup se procese—, la tarjeta se reemplazaba en el
            // medio, los dos eventos llegaban a nodos distintos y el navegador no
            // disparaba ningún `click`: el botón se apretaba y no pasaba nada. La
            // invariante aguantaba —la pantalla no mentía— y aun así el gesto se
            // había evaporado, que es su propia forma de desconcierto.
            //
            // Ahora la lista no se rehace con un botón apretado (`pintar`), así que
            // esto exige lo que el editor esperaba: la vista cambió Y la nota llegó.
            hacer: async () => {
                await clic(wc, nota(2));
                await escribir(wc, ' chau');
                await clic(wc, boton(1, 'PV'));
                await dormir(600);
            },
            ademas: async () => {
                const [una, enElMotor] = await Promise.all([
                    mirar(wc, enPantalla(1)),
                    mirar(wc, `(async () => {
                        const e = await window.cc.grabarEstado();
                        const t = e.tomas.find(x => x.id === 2);
                        return t ? t.comentario : null;
                    })()`)
                ]);
                if (una !== 'PV') return `el clic se perdió: la toma 1 muestra ${una}`;
                return /chau$/.test(String(enElMotor)) ? null : `la nota no llegó al motor: «${enElMotor}»`;
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
            que: 'pegar una lista nueva la mide sola, y las tres filas dejan el guion',
            // Con la clase ya grabando, que es el otro lado de lo que se arregló:
            // la caja está plegada porque ya hay lista, se abre tocando su
            // resumen, se corrige lo que hay sin borrar nada primero, y al guardar
            // se pliega de nuevo. Y lo que importa detrás: la medición sale sola.
            //
            // Las tres filas se miran antes y después. En guion es como el usuario
            // encontró el panel, y son la única señal de que la medición ocurrió:
            // un desplegable que aparece y no mueve ningún número no arregló nada.
            hacer: async () => {
                await clic(wc, '#grabar-analisis .temario-summary');
                await clic(wc, '#grabar-analisis .temario-campo');
                // Encima de lo que había, que es corregir la lista y no rehacerla.
                wc.selectAll();
                await dormir(150);
                await escribirRenglones(wc, ['- Contexto acotado', '- El archivo de reglas']);
                await clic(wc, '#grabar-analisis .temario-acciones .btn-primary');
                await dormir(400);
            },
            ademas: async () => {
                const guardando = await mirar(wc, COMO_ESTA_EL_TEMARIO);
                if (guardando.abierta) return 'la caja quedó abierta después de guardar';
                if (!/2 temas/.test(guardando.resumen)) return `plegada dice «${guardando.resumen}»`;

                const medido = await esperarA(wc, `(() => {
                    const t = ${COMO_ESTA_EL_TEMARIO};
                    return t && !t.filas.slice(0, 3).some(f => f === '—') ? t : null;
                })()`);
                if (!medido) return 'las tres filas se quedaron en guion: la medición no llegó a la pantalla';
                if (!/ de 2$/.test(medido.filas[0])) return `«Objetivos cubiertos» dice «${medido.filas[0]}»`;
                if (medido.temas.length !== 2) return `la lista dibujada tiene ${medido.temas.length} temas`;
                medidoAlPegar = await mirar(wc, CUANDO_SE_MIDIO);
                return medidoAlPegar ? null : 'el motor se quedó sin cobertura medida';
            }
        },
        {
            que: 'cerrar la abierta no le quita la elección a la que estaba elegida',
            // El otro borde: la elección es explícita y se respeta aunque debajo
            // cambie el paisaje. Quien eligió la toma 1 para arreglarle la vista
            // no cambió de idea porque "Pausa" haya cerrado la toma que corría, y
            // la marca sigue diciendo dónde va a caer la tecla.
            hacer: async () => {
                await clic(wc, enLaTarjeta(1));
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
        },
        {
            que: 'y ese mismo cierre volvió a medir la cobertura, sin que nadie la pidiera',
            // **El latido que el panel promete**: "se mide sola cada vez que se
            // cierra una toma". No hay gesto propio —el de arriba ya cerró la
            // toma— y eso es justamente lo que se comprueba: que la medición sale
            // del cierre y no de haber tocado el bloque del temario. Ninguna
            // prueba sin pantalla puede ver esta cadena entera, porque son tres
            // piezas distintas hablándose (el cierre, la cola de relecturas y la
            // consulta) y lo único que las une es que el panel cambie.
            hacer: async () => {},
            ademas: async () => {
                if (!medidoAlPegar) return 'no se llegó a medir nada antes de cerrar la toma';
                const otra = await esperarA(wc, `(async () => {
                    const cuando = await ${CUANDO_SE_MIDIO};
                    return cuando && cuando !== ${JSON.stringify(medidoAlPegar)} ? cuando : null;
                })()`);
                if (!otra) return 'la cobertura quedó con la medición de antes del cierre';
                const t = await mirar(wc, COMO_ESTA_EL_TEMARIO);
                return t.filas.slice(0, 3).some(f => f === '—')
                    ? `la medición nueva no llegó a las filas: ${t.filas.slice(0, 3).join(' · ')}`
                    : null;
            }
        },
        {
            que: 'con un comentario abierto al margen, la tarjeta se sigue refrescando',
            // El mismo bug del foco en versión angosta. `es-comentando` marcaba la
            // tarjeta como ocupada, y esa clase cubría DOS cosas: la caja donde
            // alguien está escribiendo un comentario nuevo —trabajo a medio hacer,
            // que hay que proteger— y un comentario viejo que solo se está mirando,
            // donde no hay nada que perder. Con el margen abierto, la tarjeta no se
            // rehacía nunca: el cambio se guardaba, no se veía, y aparecía de golpe
            // al cerrar el comentario.
            hacer: async () => {
                await clic(wc, comentada(1));
                await clic(wc, boton(1, 'MG'));
                await dormir(500);
            },
            ademas: async () => {
                const como = await mirar(wc, comoEstaElMargen(1));
                if (como.puesta !== 'MG') return `la toma 1 quedó mostrando ${como.puesta}`;
                if (!como.abierto || !como.cuantos) return 'el repintado se llevó el comentario abierto';
                return como.resaltadas ? null : 'el tramo del comentario dejó de estar resaltado';
            }
        },
        {
            que: 'y un repintado que empieza en otra toma tampoco se lo cierra',
            // La otra mitad: la tarjeta se rehace por cualquier motivo —acá, un
            // gesto en la toma 2— y el margen tiene que volver a abrirse sobre la
            // tarjeta nueva. Si no, mirar un comentario duraría hasta el repintado
            // siguiente.
            hacer: async () => {
                await clic(wc, boton(2, 'PV'));
                await dormir(500);
            },
            ademas: async () => {
                const como = await mirar(wc, comoEstaElMargen(1));
                if (!como.abierto || !como.cuantos) return 'el comentario se cerró solo';
                if (!como.resaltadas) return 'el tramo del comentario dejó de estar resaltado';
                return como.puesta === 'MG' ? null : `la toma 1 quedó mostrando ${como.puesta}`;
            }
        },
        {
            que: 'y el empujón de cada tres segundos, sin que nadie toque nada, tampoco',
            // El mismo caso que el de arriba pero de verdad, y son dos pruebas
            // distintas. Arriba el repintado sale de un clic: hay un gesto, hay
            // foco moviéndose, hay una respuesta del puente. Acá no hay nada — el
            // estado llega solo por `grabar-aviso`, que es como llega en la app la
            // mayor parte del tiempo, y ese camino no se podía verificar hasta que
            // la maqueta empezó a empujar.
            //
            // El cambio se le hace a la sesión de la maqueta por abajo y no con un
            // botón, justamente para que el único que pueda traerlo a la pantalla
            // sea el empujón. Y se espera un ciclo y monedas: menos es una carrera
            // con el reloj del motor.
            hacer: async () => {
                await mirar(wc, `(() => {
                    window.maqueta.sesionEnVivo().tomas.find(t => t.id === 1).vista = 'S';
                    return 'cambiada por abajo';
                })()`);
                const antes = await mirar(wc, enPantalla(1));
                if (antes !== 'MG') throw new Error(`la toma 1 se repintó sola antes de tiempo (${antes})`);
                await dormir(4000);
            },
            ademas: async () => {
                const como = await mirar(wc, comoEstaElMargen(1));
                if (como.puesta !== 'S') return `el empujón no llegó a la tarjeta: muestra ${como.puesta}`;
                if (!como.abierto || !como.cuantos) return 'el empujón se llevó el comentario abierto';
                return como.resaltadas ? null : 'el tramo del comentario dejó de estar resaltado';
            }
        },
        {
            que: 'y el clic sobre el mismo tramo lo cierra, como antes',
            // El margen se reabre solo en cada repintado, así que hay que
            // comprobar que se lo puede cerrar igual: si la marca de qué está
            // abierto no viajara a la tarjeta nueva, el interruptor volvería a
            // abrirlo en vez de cerrarlo y el comentario sería inapagable.
            hacer: async () => {
                await clic(wc, comentada(1));
                await clic(wc, boton(1, 'R'));
                await dormir(500);
            },
            ademas: async () => {
                const como = await mirar(wc, comoEstaElMargen(1));
                if (como.abierto || como.cuantos) return 'el comentario siguió abierto';
                return como.puesta === 'R' ? null : `la toma 1 quedó mostrando ${como.puesta}`;
            }
        },
        {
            que: 'la caja de un comentario nuevo a medio escribir sí se queda quieta',
            // La contracara, y es lo que no se puede romper al angostar la regla:
            // acá SÍ hay trabajo a medio hacer. Se escribe en la toma 4 y se toca
            // la 2 —o sea que el foco ya no está en la caja— y aun así lo escrito
            // tiene que seguir ahí.
            hacer: async () => {
                await arrastrar(wc, palabra(4), 260);
                await dormir(400);
                await escribir(wc, 'ojo');
                await clic(wc, boton(2, 'MG'));
                await dormir(500);
            },
            ademas: async () => {
                const [cuatro, dos] = await Promise.all([
                    mirar(wc, comoEstaElMargen(4)),
                    mirar(wc, enPantalla(2))
                ]);
                if (!cuatro.abierto) return 'el repintado se llevó la caja del comentario';
                if (cuatro.escrito !== 'ojo') return `lo escrito quedó en «${cuatro.escrito}»`;
                return dos === 'MG' ? null : `la toma 2 quedó mostrando ${dos}`;
            }
        },
        {
            que: 'y al cancelarla la tarjeta vuelve a rehacerse',
            hacer: async () => {
                await clic(wc, '#grabar-tomas .toma.es-comentando .toma-com.es-nuevo .btn-ghost');
                await clic(wc, boton(4, 'X2'));
                await dormir(500);
            },
            ademas: async () => {
                const como = await mirar(wc, comoEstaElMargen(4));
                if (como.abierto) return 'la caja del comentario quedó abierta';
                return como.puesta === 'X2' ? null : `la toma 4 quedó mostrando ${como.puesta}`;
            }
        },
        {
            que: 'un clic en el cabezal pliega la toma, y de paso la elige',
            // El gesto entero, que antes era un botón que decía "Plegar". Las dos
            // cosas a la vez son a propósito: el clic en una tarjeta ya quería
            // decir "esta toma" y plegarla es trabajar sobre esa toma.
            hacer: () => clic(wc, cabezal(1)),
            ademas: async () => {
                const como = await mirar(wc, comoEstaElPliegue(1));
                if (!como.plegada) return 'el cabezal no plegó la toma';
                if (!como.resumen) return 'plegada pero sin resumen: se escondió el texto y nada más';
                if (como.palabras) return `plegada y con ${como.palabras} palabras a la vista`;
                if (como.triangulo !== '▸') return `el triangulito quedó en «${como.triangulo}»`;
                if (como.expandido !== 'false') return `aria-expanded quedó en «${como.expandido}»`;
                return como.elegida ? null : 'plegar no la dejó elegida';
            }
        },
        {
            que: 'plegada sigue diciendo que las teclas caen ahí, y caen',
            // La condición de que plegar y elegir puedan compartir el clic: una
            // toma elegida y plegada tiene que seguir mostrando el anillo y el
            // "· teclas", porque sus cinco botones de vista siguen en el cabezal y
            // la tecla los sigue apretando. Si la marca se fuera con el texto, el
            // atajo quedaría apuntando a algo invisible, que es el defecto que la
            // marca existe para evitar.
            hacer: () => tecla(wc, 'p'),
            ademas: async () => {
                const como = await mirar(wc, comoEstaElPliegue(1));
                if (!como.plegada) return 'la tecla desplegó la toma';
                if (!como.elegida) return 'la marca de elegida se fue con el pliegue';
                if (!como.dicePorQue) return 'plegada y elegida, pero sin el "· teclas" en el cabezal';
                const puesta = await mirar(wc, enPantalla(1));
                return puesta === 'PV' ? null : `la tecla no cayó en la plegada, que muestra ${puesta}`;
            }
        },
        {
            que: 'los botones del cabezal de una plegada no la despliegan de rebote',
            hacer: () => clic(wc, boton(1, 'MG')),
            ademas: async () => {
                const [como, puesta] = await Promise.all([
                    mirar(wc, comoEstaElPliegue(1)),
                    mirar(wc, enPantalla(1))
                ]);
                if (!como.plegada) return 'el botón de vista desplegó la toma';
                return puesta === 'MG' ? null : `la toma 1 quedó mostrando ${puesta}`;
            }
        },
        {
            que: 'y el mismo clic en el cabezal la vuelve a desplegar, con su texto',
            hacer: () => clic(wc, cabezal(1)),
            ademas: async () => {
                const como = await mirar(wc, comoEstaElPliegue(1));
                if (como.plegada) return 'el cabezal no la desplegó';
                if (!como.palabras) return 'desplegada y sin texto';
                if (como.resumen) return 'desplegada y con el resumen del pliegue puesto';
                if (como.triangulo !== '▾') return `el triangulito quedó en «${como.triangulo}»`;
                return como.expandido === 'true' ? null : `aria-expanded quedó en «${como.expandido}»`;
            }
        },
        {
            que: 'y desplegada, sus botones tampoco la pliegan',
            // La otra mitad, y es la que importa más: si esto se rompiera, cambiar
            // la vista de una toma se llevaría de la pantalla el texto sobre el que
            // se está decidiendo, en el mismo clic. Se prueban los dos vecinos del
            // cabezal —el grupo de vistas y "Descartar"— y se recupera al final
            // para dejar la lista como estaba.
            hacer: async () => {
                await clic(wc, boton(1, 'S'));
                await clic(wc, '#grabar-tomas .toma[data-toma="1"] .toma-descartar');
                await clic(wc, '#grabar-tomas .toma[data-toma="1"] .toma-descartar');
            },
            ademas: async () => {
                const [como, puesta] = await Promise.all([
                    mirar(wc, comoEstaElPliegue(1)),
                    mirar(wc, enPantalla(1))
                ]);
                if (como.plegada) return 'un botón del cabezal plegó la tarjeta';
                if (!como.palabras) return 'la tarjeta quedó sin texto sin estar plegada';
                return puesta === 'S' ? null : `la toma 1 quedó mostrando ${puesta}`;
            }
        },
        {
            que: 'y el triangulito del cabezal pliega igual que el cabezal',
            // Es el mando accesible del pliegue —lo que lo deja alcanzable sin
            // mouse— así que tiene que hacer lo mismo y no algo parecido.
            hacer: () => clic(wc, '#grabar-tomas .toma[data-toma="1"] .toma-pliegue'),
            ademas: async () => {
                const como = await mirar(wc, comoEstaElPliegue(1));
                if (!como.plegada) return 'el triangulito no plegó la toma';
                return como.palabras ? `plegada y con ${como.palabras} palabras a la vista` : null;
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
        const pasos = banderas('paso');
        if (pasos.length) {
            // Sin esperar ninguna sesión: los pasos a mano son justamente para
            // mirar lo que la ronda no supone —la pantalla en reposo, una sesión
            // recién iniciada y vacía, la de después de "Terminar"—, y exigirle
            // cuatro tomas a eso lo dejaba fuera del alcance del arnés.
            for (const crudo of pasos) await correrPaso(win.webContents, JSON.parse(crudo));
        } else {
            await esperarSesion(win.webContents);
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
