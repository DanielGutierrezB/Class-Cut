'use strict';
/**
 * probar-recientes.js — Las últimas carpetas del paso "Carpetas", con clics de
 * verdad, y una pregunta después de cada uno.
 *
 *   node tools/probar-recientes.js
 *   node tools/probar-recientes.js --ver --capturas=/tmp/class-cut
 *
 * Qué prueba, y por qué no lo prueba `tests/run.js`. Lo que se guarda y lo que se
 * recorta está en `tests/recientes.test.js`, que escribe el JSON de verdad y lo
 * relee del disco. Lo de acá es lo otro: que la lista aparezca ANTES de que el
 * disco conteste —o sea que la pantalla de entrada de la app no se cuelgue
 * esperando un volumen dormido—, que la carpeta que no está se vea marcada en vez
 * de desaparecer, que tocarla conteste algo en vez de no hacer nada, y que
 * quitarla la saque de la pantalla Y de lo guardado a la vez. Las cuatro son de
 * pantalla: no hay ninguna decisión que mirar sin ventana, y las cuatro son
 * exactamente donde esto se rompe.
 *
 * Y por qué no va en `probar-lista.js`. Ese arnés recorre las dos pantallas de
 * Grabar y su ronda entera —entrar, grabar, terminar, renombrar, borrar— supone
 * esa sesión. Este empieza en la pantalla con la que la app ABRE, que es la otra
 * punta de la app, y la única cosa que comparten es el texto del botón «Quitar de
 * la lista», que es a propósito el mismo. Meterlo allá sería hacer que un fallo de
 * la entrada se reporte como un fallo de la lista de Grabar.
 *
 * Cómo. Como los otros: la maqueta en un puerto propio (4403, ni el 4321 del que
 * mira el diseño ni el 4399/4402 de los otros arneses), una ventana de Electron y
 * `sendInputEvent`. Clics del mouse y no `elemento.click()`, por lo de siempre.
 *
 * Lo que este arnés NO puede contestar: si la lista sobrevive a cerrar la app. La
 * maqueta guarda en memoria y recargar la página la deja como nueva. Eso se
 * verifica contra la app de verdad, abriéndola dos veces con `dev-shot` y mirando
 * el `ajustes.json` que quedó en el disco entre una y otra.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
const cli = require('./lib/cli');

const PUERTO = Number(cli.arg('puerto', 4403));
const MEDIDA = String(cli.arg('size', '1400x1000'));
const CAPTURAS = cli.arg('capturas', null);

/** La carpeta que la maqueta pone en un disco desenchufado (`AFUERA` en `cc.js`). */
const PERDIDA = '/Volumes/Rushes 2026/Clientes/Fundación Norte/Cursos/2508_taller-de-guion';

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
 * Marca la fila de una ruta y hace clic en su botón o en la fila entera.
 *
 * Por la ruta y no por la posición: el orden de esta lista CAMBIA sola —abrir una
 * carpeta la sube al tope— así que "la segunda fila" es distinta antes y después
 * de cada gesto, que es justo lo que hay que comprobar.
 */
async function clicEnFila(wc, ruta, boton) {
    const puesto = await mirar(wc, `(() => {
        for (const e of document.querySelectorAll('[data-arnes]')) e.removeAttribute('data-arnes');
        const fila = [...document.querySelectorAll('#drop-recientes-lista .reciente')]
            .find(f => f.dataset.ruta === ${JSON.stringify(ruta)});
        if (!fila) return 'no hay ninguna fila de ' + ${JSON.stringify(ruta)}
            + ' (hay: ' + [...document.querySelectorAll('.reciente')].map(f => f.dataset.ruta).join(' | ') + ')';
        const cual = ${JSON.stringify(boton || '')}
            ? [...fila.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(boton || '')})
            : fila.querySelector('.reciente-abrir');
        if (!cual) return 'la fila no tiene ningún botón que diga ' + ${JSON.stringify(boton)};
        cual.dataset.arnes = '1';
        return null;
    })()`);
    if (puesto) throw new Error(puesto);
    await clic(wc, '[data-arnes="1"]');
}

async function capturar(wc, archivo) {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, (await wc.capturePage()).toPNG());
    console.log(`      captura: ${archivo}`);
}

/* ─── Lo que se le pregunta a la pantalla ────────────────────────────────── */

/**
 * La lista tal como se ve, y aparte lo que quedó guardado.
 *
 * Las dos juntas a propósito, por la misma razón que en `probar-lista.js`: quitar
 * una ruta se rompe de dos maneras opuestas —se va de la pantalla y sigue
 * guardada, o se va de lo guardado y la pantalla no se entera— y mirando una sola
 * mitad cualquiera de las dos pasa en verde.
 */
const COMO_ESTA = `(async () => {
    const filas = [...document.querySelectorAll('#drop-recientes-lista .reciente')];
    const texto = (f, sel) => (f.querySelector(sel) || {}).textContent || '';
    const visible = e => Boolean(e) && !e.hidden;
    const error = document.getElementById('drop-error');
    return {
        caja: visible(document.getElementById('drop-recientes')),
        rutas: filas.map(f => f.dataset.ruta),
        nombres: filas.map(f => texto(f, '.reciente-nombre')),
        dondes: filas.map(f => texto(f, '.reciente-donde')),
        perdidas: filas.filter(f => f.classList.contains('es-perdida')).map(f => f.dataset.ruta),
        marcas: filas.filter(f => f.querySelector('.reciente-marca')).map(f => texto(f, '.reciente-marca')),
        quitables: filas.filter(f => [...f.querySelectorAll('button')]
            .some(b => b.textContent.trim() === 'Quitar de la lista')).map(f => f.dataset.ruta),
        // Los globitos: la ruta entera tiene que seguir a mano aunque se muestre
        // plegada, porque es lo único que distingue dos cursos que se llaman igual.
        globitos: filas.map(f => (f.querySelector('.reciente-abrir') || {}).title || ''),
        error: visible(error) ? error.textContent : null,
        vista: (document.querySelector('.view.is-visible') || {}).id || '?',
        guardadas: await window.cc.carpetasRecientes()
    };
})()`;

const comoEsta = wc => mirar(wc, COMO_ESTA);

/**
 * La primera vez que la lista tiene filas dibujadas, y si ya traía marcas.
 *
 * Se sondea rápido en vez de esperar un rato fijo porque lo que se está midiendo
 * es un ORDEN: entre que la lista aparece y que el disco contesta hay medio
 * segundo, y una espera fija de 200 ms es una apuesta a que ese medio segundo no
 * cambie nunca.
 */
async function elPrimerDibujo(wc) {
    const hasta = Date.now() + 8000;
    while (Date.now() < hasta) {
        const foto = await mirar(wc, `(() => {
            const filas = [...document.querySelectorAll('#drop-recientes-lista .reciente')];
            return {
                filas: filas.length,
                marcas: filas.filter(f => f.querySelector('.reciente-marca')).length
            };
        })()`).catch(() => null);
        if (foto && foto.filas) return foto;
        await dormir(25);
    }
    throw new Error('la lista no se dibujó nunca');
}

/** Ir al paso 2 con un clic en el cabezal, como iría cualquiera. */
async function alPasoDeCarpetas(wc) {
    await clic(wc, '#steps .step[data-step="2"]');
}

/* ─── La ronda ───────────────────────────────────────────────────────────── */

function casos(wc) {
    let alEmpezar = null;
    let apenasEntrado = null;
    let yaMarcado = null;
    let antesDeAbrir = null;
    let laAbierta = null;

    return [
        {
            que: 'la lista aparece SIN esperar al disco: primero se pinta, después se marca',
            // El orden es el asunto, y por eso se mira desde una app recién
            // abierta y no entrando al paso 2: entrando, la respuesta del disco
            // ya está en memoria de la vez anterior y las dos fases se ven como
            // una. La maqueta tarda medio segundo en contestar qué hay en el
            // disco (`carpetasEnDisco`), que es lo que tarda un volumen dormido.
            // Si la pantalla esperara esa respuesta para pintar, la app abriría
            // en blanco justo cuando el disco está peor. Así que se mira el
            // PRIMER dibujo: tiene que haber filas y ninguna marca.
            hacer: async () => {
                wc.reload();
                apenasEntrado = await elPrimerDibujo(wc);
                await dormir(2500);
                await alPasoDeCarpetas(wc);
                await dormir(1200);
                yaMarcado = await comoEsta(wc);
                alEmpezar = yaMarcado;
            },
            ademas: async () => {
                if (apenasEntrado.filas < 3) {
                    return `el primer dibujo trajo ${apenasEntrado.filas} filas`;
                }
                if (apenasEntrado.marcas) {
                    return `marcó ${apenasEntrado.marcas} carpeta(s) antes de preguntarle al disco`;
                }
                if (!yaMarcado.caja) return 'la caja de recientes no se mostró';
                return yaMarcado.marcas.length === 1 ? null
                    : `después de preguntar quedaron ${yaMarcado.marcas.length} marcas`;
            },
            shot: 'recientes'
        },
        {
            que: 'cada fila dice el curso entero y la ruta plegada por el medio',
            hacer: async () => {},
            ademas: async () => {
                const c = alEmpezar;
                if (c.nombres.some(n => !n.trim())) return `hay filas sin nombre: ${c.nombres.join(' | ')}`;
                // El nombre es el último tramo, que es lo que distingue dos cursos.
                for (let i = 0; i < c.rutas.length; i++) {
                    const cola = c.rutas[i].split('/').pop();
                    if (c.nombres[i] !== cola) return `«${c.nombres[i]}» no es el final de ${c.rutas[i]}`;
                }
                const larga = c.rutas.findIndex(r => r.split('/').filter(Boolean).length > 5);
                if (larga < 0) return 'ninguna ruta es lo bastante larga para probar el plegado';
                if (!c.dondes[larga].includes('…')) {
                    return `la ruta larga salió entera: «${c.dondes[larga]}»`;
                }
                if (c.dondes[larga].length >= c.rutas[larga].length) {
                    return `plegada mide más que entera: «${c.dondes[larga]}»`;
                }
                return c.globitos[larga] === c.rutas[larga] ? null
                    : `el globito no trae la ruta entera: «${c.globitos[larga]}»`;
            }
        },
        {
            que: 'la carpeta que no está sigue en la lista, marcada «no la encuentro»',
            // Esconderla sería lo cómodo y es lo que no se hizo: un disco externo
            // desenchufado es el estado normal de la mitad del material, y una
            // lista que se vacía al desenchufar deja al editor creyendo que perdió
            // el curso. Marcada dice lo único que hay que saber: enchufá el disco.
            hacer: async () => {},
            ademas: async () => {
                const c = alEmpezar;
                if (!c.rutas.includes(PERDIDA)) return 'la carpeta del disco desenchufado no está en la lista';
                if (!c.perdidas.includes(PERDIDA)) return 'está en la lista pero sin marcar';
                if (!/no la encuentro/.test(c.marcas[0] || '')) return `la marca dice «${c.marcas[0]}»`;
                // Y las demás NO se marcan: una marca que sale en todas no dice nada.
                return c.perdidas.length === 1 ? null
                    : `se marcaron ${c.perdidas.length}: ${c.perdidas.join(' | ')}`;
            }
        },
        {
            que: 'tocarla no se queda callado: dice qué pasó y qué se puede hacer',
            hacer: async () => {
                await clicEnFila(wc, PERDIDA);
                await dormir(1200);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (!c.error) return 'el clic no hizo nada y no dijo nada';
                for (const cosa of ['enchuf', 'Elegir carpeta', 'Quitar de la lista']) {
                    if (!c.error.includes(cosa)) return `el aviso no ofrece «${cosa}»: «${c.error}»`;
                }
                if (!c.error.includes(PERDIDA.split('/').pop())) {
                    return `el aviso no dice cuál: «${c.error}»`;
                }
                if (c.vista !== 'view-drop') return `el clic se llevó la pantalla a «${c.vista}»`;
                // Y no se la sacó de la lista por no estar: eso lo decide el editor.
                return c.rutas.includes(PERDIDA) ? null : 'se borró sola de la lista';
            },
            shot: 'la-que-no-esta'
        },
        {
            que: 'un clic en una que sí está la abre y lleva a sus clases',
            hacer: async () => {
                antesDeAbrir = await comoEsta(wc);
                // La última de las que están, para que subir al tope se note.
                laAbierta = antesDeAbrir.rutas.filter(r => !antesDeAbrir.perdidas.includes(r)).pop();
                await clicEnFila(wc, laAbierta);
                await dormir(2000);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                if (c.vista !== 'view-classes') return `quedó en «${c.vista}»`;
                return c.error ? `abrió y encima dejó un error puesto: «${c.error}»` : null;
            },
            shot: 'abierta-de-un-clic'
        },
        {
            que: 'y al volver, la que se acaba de abrir quedó primera',
            // El orden es por último uso y no por cuándo se agregó: es lo que hace
            // que el curso de esta semana esté siempre arriba, y lo que decide a
            // quién echa el tope.
            hacer: async () => {
                await alPasoDeCarpetas(wc);
                await dormir(1200);
            },
            ademas: async () => {
                const c = await comoEsta(wc);
                const abierta = laAbierta;
                if (c.rutas[0] !== abierta) return `arriba quedó «${c.rutas[0]}» y se abrió «${abierta}»`;
                if (c.rutas.length !== antesDeAbrir.rutas.length) {
                    return `la lista pasó de ${antesDeAbrir.rutas.length} a ${c.rutas.length}: se duplicó`;
                }
                return c.guardadas[0] === abierta ? null
                    : `en pantalla subió y en lo guardado no: ${c.guardadas.join(' | ')}`;
            }
        },
        {
            que: 'todas ofrecen «Quitar de la lista», también la que no está',
            // Sobre todo la que no está: si la única fila sin botón fuera la del
            // disco que se perdió, la lista se ensuciaría justo con lo que ya no
            // sirve y no habría manera de limpiarla.
            hacer: async () => {},
            ademas: async () => {
                const c = await comoEsta(wc);
                if (!c.quitables.includes(PERDIDA)) return 'la que no está no se puede quitar';
                return c.quitables.length === c.rutas.length ? null
                    : `${c.quitables.length} botones para ${c.rutas.length} filas`;
            }
        },
        {
            que: 'quitar una la saca de la pantalla y de lo guardado, y no vuelve al repintar',
            // El defecto que esto vigila tiene nombre y ya pasó una vez: la lista
            // de Grabar guardaba sobre una copia que se tiraba, la carpeta se iba
            // de la pantalla y el repintado siguiente —que relee los ajustes— la
            // traía de vuelta. Por eso se mira lo guardado y se sale y se entra.
            hacer: async () => {
                await clicEnFila(wc, PERDIDA, 'Quitar de la lista');
                await dormir(800);
            },
            ademas: async () => {
                const recien = await comoEsta(wc);
                if (recien.rutas.includes(PERDIDA)) return 'la fila se quedó ahí';
                if (recien.guardadas.includes(PERDIDA)) {
                    return `se fue de la pantalla y quedó guardada: ${recien.guardadas.join(' | ')}`;
                }
                // Y ahora el repintado que rehace la lista releyendo los ajustes,
                // que es exactamente donde volvía.
                await clic(wc, '#steps .step[data-step="3"]');
                await dormir(600);
                await alPasoDeCarpetas(wc);
                await dormir(1200);
                const c = await comoEsta(wc);
                if (c.rutas.includes(PERDIDA)) return `volvió al repintar: ${c.rutas.join(' | ')}`;
                return c.rutas.length === recien.rutas.length ? null
                    : `quedaron ${c.rutas.length} filas y recién quitada había ${recien.rutas.length}`;
            },
            shot: 'quitada'
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
        // Las carpetas de la maqueta entran solas al abrir y tardan; además dejan
        // la app en la tabla, así que la ronda empieza volviendo al paso 2.
        await dormir(2500);
        codigo = (await ronda(win.webContents)).length ? 1 : 0;
    } catch (e) {
        console.error(`el arnés se cayó: ${e && e.stack ? e.stack : e}`);
        codigo = 1;
    }
    app.exit(codigo);
}

if (typeof electron === 'string') enNode();
else enElectron();
