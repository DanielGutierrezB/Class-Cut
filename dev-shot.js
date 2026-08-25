'use strict';
/**
 * dev-shot.js — El arnés para iterar la interfaz sin abrir la app a mano.
 *
 *   electron . --folder=/ruta/al/curso --shot=/tmp/class-cut.png --js='dev.abrirClase(id)'
 *
 * Carga la carpeta, espera a que la tabla termine de medir, corre el JS que se
 * le pase, guarda el PNG y sale. Para atajos de teclado hay `--key=Space` (una
 * tecla de verdad, con su acción por defecto) y `--js-despues=` para mirar cómo
 * quedó todo.
 *
 * Es lo único de `main.js` que no es cableado de la app: vive aparte para que
 * el proceso principal se lea entero como lo que es, y esto como lo que es.
 */

const fs = require('fs');
const { app } = require('electron');

function argValue(flag) {
    const hit = process.argv.find(a => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : null;
}

/** @param {BrowserWindow} win la ventana ya cargada */
async function correr(win) {
    const shot = argValue('shot');
    const folder = argValue('folder');
    const extraJs = argValue('js');
    if (!shot && !folder) return;

    if (folder) {
        await win.webContents.executeJavaScript(`dev.addFolder(${JSON.stringify(folder)})`);
        await new Promise(r => setTimeout(r, 4000));
    }
    if (extraJs) {
        // Sin esto, lo que el JS de prueba imprime se queda en la consola de la
        // ventana y desde afuera solo queda mirar el PNG y opinar.
        win.webContents.on('console-message', (_e, _nivel, texto) => console.log(texto));
        const salida = await win.webContents.executeJavaScript(extraJs);
        if (salida !== undefined) console.log(salida);
        await new Promise(r => setTimeout(r, Number(argValue('wait')) || 400));
    }

    // Y `elemento.click()` tampoco mueve el foco como lo mueve el mouse, que es
    // de dónde salen la mitad de los problemas con los atajos.
    const click = argValue('click');
    if (click) {
        const [x, y] = click.split(',').map(Number);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 300));
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
        const despues = argValue('js-despues');
        if (despues) {
            const salida = await win.webContents.executeJavaScript(despues);
            if (salida !== undefined) console.log(salida);
        }
    }

    if (!shot) return;

    await new Promise(r => setTimeout(r, 500));
    try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(shot, image.toPNG());
        console.log('captura:', shot);
    } catch (e) {
        console.error('no se pudo capturar:', e.message);
    }
    app.quit();
}

module.exports = { correr };
