'use strict';
/**
 * dev-shot.js — El arnés para iterar la interfaz sin abrir la app a mano.
 *
 *   electron . --folder=/ruta/al/curso --shot=/tmp/class-cut.png --js='dev.abrirClase(id)'
 *
 * Carga la carpeta, espera a que la tabla termine de medir, corre el JS que se
 * le pase, guarda el PNG y sale. Para atajos de teclado hay `--key=Space` (una
 * tecla de verdad, con su acción por defecto), `--click=x,y[,cuántos]` para
 * clics de verdad (con su tercer número, un doble clic), `--drag=x1,y1,x2,y2`
 * para arrastres, y `--js-despues=` para mirar cómo quedó todo.
 *
 * `--responder=N` contesta los diálogos de varias salidas con esa opción, sin
 * abrirlos: es la única forma de probar desde afuera qué hace la ventana con
 * cada respuesta.
 *
 * `--size=1024x840` abre a esa medida, y con varias separadas por coma
 * (`--size=900x840,1440x840`) repite el JS y la captura en cada una: revisar si
 * algo se rompe al angostar la ventana pedía abrir la app cinco veces y escanear
 * la carpeta cinco veces para mirar la misma barra.
 *
 * Es lo único de `main.js` que no es cableado de la app: vive aparte para que
 * el proceso principal se lea entero como lo que es, y esto como lo que es.
 */

const fs = require('fs');
const { app, ipcMain } = require('electron');

function argValue(flag) {
    const hit = process.argv.find(a => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : null;
}

/** Las medidas de `--size`, en orden. `[]` si no vino la bandera. */
function medidas() {
    const crudo = argValue('size');
    if (!crudo) return [];
    return crudo.split(',').filter(Boolean).map(par => {
        const [w, h] = par.split('x').map(Number);
        if (!w || !h) throw new Error(`--size no se entiende: ${par} (va 1024x840)`);
        return { w, h };
    });
}

/**
 * `--responder=0` contesta los diálogos sin abrirlos: los dos, el de varias
 * salidas (`preguntar`) y el de sí o no (`confirmar`).
 *
 * Es para poder probar qué hace la ventana con cada respuesta, que es lo único
 * que ahí importa. La hoja de macOS no se puede manejar desde afuera —`osascript`
 * necesita permiso de accesibilidad y `sendInputEvent` va al contenido web, no a
 * la hoja—, así que con el diálogo de verdad la única rama comprobable era la de
 * quedarse esperando.
 *
 * `confirmar` entró después que `preguntar` y por un motivo concreto: detrás de
 * él están los tres gestos que no se deshacen —borrar una clase grabada,
 * reprocesar tirando el trabajo guardado, terminar la toma de notas— o sea
 * justamente los que más falta hace ejercitar desde afuera y los únicos que, sin
 * esto, cuelgan el arnés en la primera hoja del sistema. Se contesta con el mismo
 * índice: el 0 es el botón que hace la cosa, cualquier otro es Cancelar, que es
 * exactamente lo que `main.js` devuelve (`response === 0`).
 *
 * Se reemplaza el manejador acá y no en el puente: `window.cc` viaja congelado
 * por el `contextBridge` (a propósito), así que desde el `--js` no se puede
 * envolver nada. Y se hace desde este archivo, que sin sus banderas no existe,
 * para que la app instalada no tenga por dónde contestarse sus propios diálogos.
 *
 * El número es el índice de la opción; -1 es Cancelar. Cada consulta se imprime
 * entera —título y detalle—, así que también sirve para comprobar que NO se
 * preguntó, y para leer lo que el cartel prometía antes de que se lo conteste.
 */
function responderDialogos() {
    const crudo = argValue('responder');
    if (crudo == null) return;
    const respuesta = Number(crudo);
    ipcMain.removeHandler('preguntar');
    ipcMain.handle('preguntar', (event, payload) => {
        console.log(`preguntar: «${(payload && payload.titulo) || ''}» → ${respuesta}`);
        return respuesta;
    });
    ipcMain.removeHandler('confirmar');
    ipcMain.handle('confirmar', (event, payload) => {
        const p = payload || {};
        // El detalle en una línea: es donde el cartel de borrar nombra los
        // archivos que se van, y desde afuera no hay otra forma de leerlo.
        const detalle = String(p.mensaje || '').replace(/\s*\n+\s*/g, ' · ');
        console.log(`confirmar: «${p.titulo || ''}» · ${detalle} → ${respuesta === 0}`);
        return respuesta === 0;
    });
}

/** Mete el ancho en el nombre del PNG para que un barrido no se pise a sí mismo. */
function conMedida(shot, medida) {
    if (!medida) return shot;
    const punto = shot.lastIndexOf('.');
    return punto < 0
        ? `${shot}-${medida.w}x${medida.h}`
        : `${shot.slice(0, punto)}-${medida.w}x${medida.h}${shot.slice(punto)}`;
}

/** El JS de prueba, los clics, las teclas y la captura: un pase de medición. */
async function pase(win, shot, medida) {
    const extraJs = argValue('js');
    if (extraJs) {
        const salida = await win.webContents.executeJavaScript(extraJs);
        if (salida !== undefined) console.log(salida);
        await new Promise(r => setTimeout(r, Number(argValue('wait')) || 400));
    }

    // Y `elemento.click()` tampoco mueve el foco como lo mueve el mouse, que es
    // de dónde salen la mitad de los problemas con los atajos.
    //
    // Con un tercer número, esa cantidad de clics seguidos: `--click=120,760,2`
    // es un doble clic. Y no es dos veces `--click`, que es justamente el punto:
    // el `dblclick` lo sintetiza el navegador a partir del `clickCount` que trae
    // cada evento del sistema, así que dos clics con `clickCount: 1` no lo
    // producen nunca. Sin esto, ningún gesto de doble clic de la app —el del
    // divisor del panel y el del volumen— se podía probar desde afuera.
    const click = argValue('click');
    if (click) {
        const [x, y, cuantos] = click.split(',').map(Number);
        for (let n = 1; n <= Math.max(1, cuantos || 1); n++) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: n });
            win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: n });
        }
        await new Promise(r => setTimeout(r, 300));
    }

    // `--drag=x1,y1,x2,y2` arrastra de un punto al otro, con pasos intermedios.
    //
    // Por lo mismo que `--click`, y más todavía: un arrastre fabricado con
    // `new PointerEvent` no tiene un puntero activo detrás, así que
    // `setPointerCapture` tira y el gesto no arranca nunca. Es la única forma de
    // probar desde afuera las líneas de IN y OUT del texto, que se mueven con el
    // mouse apretado y no con un clic.
    const drag = argValue('drag');
    if (drag) {
        const [x1, y1, x2, y2] = drag.split(',').map(Number);
        const pasos = 12;
        win.webContents.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 });
        for (let i = 1; i <= pasos; i++) {
            const t = i / pasos;
            win.webContents.sendInputEvent({
                type: 'mouseMove',
                x: Math.round(x1 + (x2 - x1) * t),
                y: Math.round(y1 + (y2 - y1) * t)
            });
            await new Promise(r => setTimeout(r, 16));
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 400));
    }

    // Un atajo de teclado no se puede probar con `new KeyboardEvent`: un evento
    // fabricado no arrastra la acción del navegador, así que el scroll de la
    // barra espaciadora —que es justo lo que se quiere ver— nunca aparece.
    const key = argValue('key');
    if (key) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        win.webContents.sendInputEvent({ type: 'char', keyCode: key });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
        await new Promise(r => setTimeout(r, 500));
    }

    // Después de todo lo que se haya mandado, no solo de las teclas: lo que un
    // clic dejó en el estado no siempre se ve en la captura, y colgado de
    // `--key` había que mandar una tecla al aire para poder mirar.
    const despues = argValue('js-despues');
    if (despues) {
        const salida = await win.webContents.executeJavaScript(despues);
        if (salida !== undefined) console.log(salida);
    }

    if (!shot) return;
    await new Promise(r => setTimeout(r, 500));
    try {
        const image = await win.webContents.capturePage();
        const destino = conMedida(shot, medida);
        fs.writeFileSync(destino, image.toPNG());
        console.log('captura:', destino);
    } catch (e) {
        console.error('no se pudo capturar:', e.message);
    }
}

/**
 * `--guion=<archivo>` le da la ventana a un recorrido escrito aparte.
 *
 * Las banderas de arriba alcanzan para un gesto y una captura, y no para un
 * recorrido: una corrida de la toma de notas en vivo tiene que abrir una sesión,
 * empujarle audio de verdad durante minutos, esperar a que Whisper abra las tomas
 * y recién entonces tocar algo. Eso no entra en un `--js`, y sobre todo no puede
 * salir de la ventana: **el audio hay que leerlo del disco y convertirlo, y la
 * ventana no tiene Node.**
 *
 * Así que el recorrido corre ACÁ, en el proceso principal, que es el único lugar
 * que tiene las dos cosas a la vez —`fs` y ffmpeg de un lado, `webContents` del
 * otro— y puede meterle el PCM a la ventana para que ella lo mande por el puente
 * de verdad (`window.cc.grabarPcm`). Un recorrido que llamara al motor desde acá
 * se saltearía justamente el puente que se quiere probar.
 *
 * El archivo exporta `correr({ win, arg })`. Vive en `tools/` y no acá porque
 * esto es el arnés y aquello es una corrida suya; sin la bandera no se carga
 * nada, así que la app instalada no tiene por dónde ejecutar un recorrido.
 */
async function guion(win) {
    const ruta = argValue('guion');
    if (!ruta) return false;
    const recorrido = require(require('path').resolve(ruta));
    win.webContents.on('console-message', (_e, _nivel, texto) => console.log(texto));
    await recorrido.correr({ win, arg: argValue });
    return true;
}

/** @param {BrowserWindow} win la ventana ya cargada */
async function correr(win) {
    const shot = argValue('shot');
    const folder = argValue('folder');
    const tamanos = medidas();
    responderDialogos();
    if (await guion(win)) return;
    if (!shot && !folder && !tamanos.length) return;

    // Sin esto, lo que el JS de prueba imprime se queda en la consola de la
    // ventana y desde afuera solo queda mirar el PNG y opinar.
    if (argValue('js')) win.webContents.on('console-message', (_e, _nivel, texto) => console.log(texto));

    // El primer ancho va antes de cargar la carpeta: la tabla mide sus columnas
    // al terminar el escaneo y si la ventana cambia después queda con las
    // medidas de otro ancho.
    if (tamanos.length) win.setContentSize(tamanos[0].w, tamanos[0].h);

    if (folder) {
        await win.webContents.executeJavaScript(`dev.addFolder(${JSON.stringify(folder)})`);
        await new Promise(r => setTimeout(r, 4000));
    }

    if (!tamanos.length) {
        await pase(win, shot, null);
    } else {
        for (const medida of tamanos) {
            // `setContentSize` y no `setSize` porque lo que se mide desde el JS
            // es `innerWidth`, y pedir el ancho de la ventana deja unos píxeles
            // de diferencia según la plataforma. Ojo: `minWidth` recorta, así
            // que pedir menos de 900 no da menos de 900.
            win.setContentSize(medida.w, medida.h);
            await new Promise(r => setTimeout(r, 600));
            console.log(`── ${medida.w}x${medida.h} ──`);
            await pase(win, shot, tamanos.length > 1 ? medida : null);
        }
    }

    if (shot) app.quit();
}

module.exports = { correr };
