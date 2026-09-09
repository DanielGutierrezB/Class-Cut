'use strict';
/**
 * ipc/prproj.js — El puente del proyecto de Premiere.
 *
 * Aparte de `ipc/grabar.js` aunque el botón viva en la misma pestaña, porque no
 * es lo mismo: la toma de notas escribe una clase mientras alguien habla, y esto
 * lee un curso ya cortado y lo empaqueta. Comparten la pantalla y nada más.
 *
 * Lo que sale de acá es ADITIVO. El XML sigue siendo la entrega, y si generar el
 * proyecto falla no puede llevarse puesto nada de lo que ya funciona: por eso
 * cada canal contesta `{ ok }` en vez de tirar, y el motor escribe el archivo
 * nuevo sin tocar ninguno de los que ya estaban.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ajustes = require('../engine/ajustes');
const curso = require('../engine/prproj-curso');
const prproj = require('../engine/prproj');
const moldes = require('../engine/prproj-moldes');

/**
 * Dónde cae el proyecto de un curso.
 *
 * El nombre es el de la carpeta, que es como el editor llama al curso en todos
 * lados: si la carpeta es `2026_curso-spec-driven-development`, el proyecto se
 * llama igual. Un nombre inventado por nosotros obligaría a traducir entre lo que
 * dice el Finder y lo que dice Premiere cada vez.
 *
 * Y va en una carpeta `Proyecto/` propia, no suelto: Premiere deja auto-guardados
 * y previsualizaciones al lado del proyecto, y sin una carpeta que los contenga
 * eso se mezcla con el material.
 */
function destinoDe(carpeta) {
    return path.join(carpeta, 'Proyecto', `${path.basename(carpeta)}.prproj`);
}

/**
 * El primer nombre libre al lado de uno ocupado: `Curso 2.prproj`, `Curso 3`…
 *
 * Se cuenta hasta encontrar hueco en vez de pegarle la fecha porque así se lee
 * como lo que es —el segundo intento, el tercero— y es lo que hace el Finder, que
 * es donde el editor los va a ver.
 */
function alLado(destino) {
    const dir = path.dirname(destino);
    const ext = path.extname(destino);
    const base = path.basename(destino, ext);
    for (let n = 2; n < 1000; n++) {
        const otro = path.join(dir, `${base} ${n}${ext}`);
        if (!fs.existsSync(otro)) return otro;
    }
    // Mil proyectos del mismo curso es un problema que no vamos a resolver
    // inventando un nombre más largo.
    throw new Error(`Hay demasiados proyectos en ${dir}. Llevate alguno antes de generar otro.`);
}

/**
 * Por qué este archivo no sirve de plantilla, o `null` si sirve.
 *
 * Se revisa al elegirla y no al usarla, y esa es toda la gracia: enterarse de que
 * el archivo no servía recién cuando se quiso armar el curso entero es enterarse
 * tarde y en el peor momento. Acá el error todavía tiene un arreglo obvio, que es
 * elegir otro.
 *
 * Y se le pregunta al MOTOR qué le falta, en vez de revisar acá por arriba que
 * sea un proyecto y confiar. La diferencia no es teórica: el proyecto que el
 * editor armó a mano —el que se llama «Plantilla», el que cualquiera elegiría—
 * abre perfecto y no sirve de molde, porque importó los XML de antes del arreglo
 * del estéreo y Premiere le metió los diez WAV en mono. No tiene ni un corte
 * estéreo del que copiar. Con una revisión por arriba eso se descubría a mitad
 * del armado del curso, con un mensaje que no dice qué hacer.
 */
function porQueNoSirve(ruta) {
    let crudo = null;
    try {
        crudo = zlib.gunzipSync(fs.readFileSync(ruta));
    } catch (err) {
        return 'Ese archivo no se pudo abrir. Un .prproj es XML comprimido, ' +
            'y este no lo es: ¿está dañado, o es un proyecto de otro programa?';
    }
    if (!crudo.slice(0, 400).includes('<PremiereData')) {
        return 'Ese archivo se abre pero no es un proyecto de Premiere.';
    }

    let faltan;
    try {
        faltan = moldes.loQueFalta(moldes.detectarMoldes(prproj.Proyecto.leer(ruta)));
    } catch (err) {
        return `Ese proyecto se abre pero no lo pude recorrer: ${err.message}`;
    }
    if (faltan.length) {
        return 'Ese proyecto abre, pero no tiene de dónde copiar:\n\n· ' + faltan.join('\n· ')
            + '\n\nLa plantilla se usa de molde, así que tiene que tener puesto en una '
            + 'secuencia un ejemplo de cada cosa. Sirve cualquier proyecto tuyo donde '
            + 'hayas tirado a la línea de tiempo un video, un audio mono y un audio estéreo.';
    }
    return null;
}

/**
 * Los bins que arma el generador, que son con lo que se reconoce lo nuestro.
 *
 * Se le preguntan al motor en vez de escribirlos acá: si algún día se llaman de
 * otra manera, esto lo sigue solo en vez de dejar de reconocer nada en silencio.
 */
const NUESTROS_BINS = curso.ORDEN_DE_BINS;

/** Dónde buscar sola, y hasta dónde bajar. */
const DONDE_BUSCAR = ['Movies', 'Documents', 'Desktop'];
const HONDO = 4;
// Abrir un proyecto y recorrerlo cuesta; con los más nuevos alcanza y sobra.
const CUANTOS_PROBAR = 10;

/**
 * Un `.prproj` del editor que sirva de molde, buscado en vez de preguntado.
 *
 * **Preguntar por una plantilla es un requisito raro de explicar.** Quien aprieta
 * «Generar .prproj» quiere su curso en Premiere, no elegir un archivo del que
 * nunca oyó hablar; y la respuesta correcta —«cualquier proyecto tuyo que tenga
 * en la línea de tiempo un video, un audio mono y uno estéreo»— es una condición
 * que nadie tiene por qué llevar en la cabeza. Pero la máquina sí puede probarla,
 * y probarla es exactamente lo que hace `porQueNoSirve`. Así que se prueban los
 * proyectos que el editor ya tiene y se usa el primero que pase.
 *
 * Sale de los proyectos del editor y no de uno que venga adentro de la app a
 * propósito: el molde le presta al archivo nuevo la versión y los ajustes del
 * Premiere que lo guardó, y el Premiere que importa es el suyo. Uno empaquetado
 * acá envejecería con nosotros y no con él.
 *
 * De los más nuevos a los más viejos porque el más reciente es el que más se
 * parece a lo que el editor usa hoy, y dejando para el final los que salieron de
 * acá. Un proyecto nuestro sirve de molde —es una mutación fiel de uno real, con
 * las mismas versiones de clase— pero si alguna vez un defecto nuestro escribe un
 * archivo torcido, usarlo de molde lo propaga a todos los que vengan. Ya pasó una
 * vez con los marcadores. Se prefieren, entonces, y no se descartan: quedan de
 * último recurso, que es mejor que preguntar.
 */
function buscarPlantilla() {
    const candidatos = candidatosDe(os.homedir()).slice(0, CUANTOS_PROBAR);
    const nuestros = [];
    for (const ruta of candidatos) {
        if (loEscribimosNosotros(ruta)) { nuestros.push(ruta); continue; }
        if (!porQueNoSirve(ruta)) return ruta;
    }
    for (const ruta of nuestros) {
        if (!porQueNoSirve(ruta)) return ruta;
    }
    return null;
}

/**
 * Los `.prproj` que hay bajo un home, del más nuevo al más viejo.
 *
 * Aparte de `buscarPlantilla` para poder mirarlo: es la mitad barata —recorrer
 * carpetas y ordenar por fecha— y la otra mitad abre y recorre proyectos de
 * megas. Probar el orden sin tener que fabricar proyectos de Premiere de verdad
 * es la diferencia entre una prueba que corre siempre y una que se saltea.
 *
 * @returns {string[]}
 */
function candidatosDe(home) {
    const encontrados = [];
    const bajar = (dir, hondo) => {
        if (hondo > HONDO || encontrados.length > 400) return;
        let entradas;
        try {
            entradas = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            return; // sin permiso, o un disco que se desmontó mientras mirábamos
        }
        for (const e of entradas) {
            if (e.name.startsWith('.')) continue;
            const completo = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules') continue;
                bajar(completo, hondo + 1);
            } else if (e.name.endsWith('.prproj')) {
                try {
                    encontrados.push({ ruta: completo, cuando: fs.statSync(completo).mtimeMs });
                } catch (err) { /* se fue mientras mirábamos */ }
            }
        }
    };
    for (const nombre of DONDE_BUSCAR) bajar(path.join(home, nombre), 0);
    return encontrados.sort((a, b) => b.cuando - a.cuando).map(c => c.ruta);
}

/**
 * Si este `.prproj` lo armó Class Cut.
 *
 * Se mira el panel y no el nombre ni la carpeta, porque el archivo se puede
 * mover y renombrar —de hecho el primero que generamos terminó en otro lado—.
 * La marca son los seis bins numerados, todos, que es la organización que arma
 * el generador y que ningún proyecto llega a tener por casualidad.
 *
 * Se lee el archivo por arriba en vez de recorrer el grafo: acá alcanza con
 * saber si los nombres están, y esto corre sobre varios candidatos seguidos.
 */
function loEscribimosNosotros(ruta) {
    try {
        const xml = zlib.gunzipSync(fs.readFileSync(ruta)).toString('utf8');
        return NUESTROS_BINS.every(b => xml.includes(`<Name>${b}</Name>`));
    } catch (err) {
        return false;
    }
}

/**
 * Si la plantilla anotada todavía está y todavía sirve de molde.
 *
 * Se revisa el contenido y no solo que el archivo exista, porque hay dos maneras
 * de que una anotación buena se pudra. Una es que la muevan, la renombren o esté
 * en un disco que hoy no está enchufado. La otra es más callada: la anotación
 * pudo guardarse antes de que existiera esta revisión, o el editor pudo abrir ese
 * proyecto y sacarle de la línea de tiempo justo el clip estéreo del que
 * copiábamos. En los dos casos conviene enterarse acá —donde todavía se puede
 * buscar otra— y no a mitad del armado del curso.
 */
function sirveTodavia(ruta) {
    try {
        if (!fs.statSync(ruta).isFile()) return false;
    } catch (err) {
        return false;
    }
    return !porQueNoSirve(ruta);
}

/**
 * Qué le pasa hoy a la plantilla, que es lo que decide si el botón se puede
 * apretar y, si no, qué hay que decirle a quien lo mira.
 *
 * Se pregunta al disco en vez de confiar en el ajuste porque una plantilla es un
 * archivo que alguien puede mover, renombrar o tener en un disco externo. El
 * ajuste guarda dónde estaba, no que siga estando.
 *
 * Y si no hay ninguna anotada, o la que había ya no sirve, se busca una antes de
 * darse por vencido: preguntar es el último recurso, no el primero.
 */
function estadoDeLaPlantilla() {
    const anotada = ajustes.leer().plantillaPrproj;
    if (anotada && sirveTodavia(anotada)) return { ok: true, ruta: anotada };

    const encontrada = buscarPlantilla();
    if (encontrada) {
        // Se anota para no volver a barrer el disco en cada apretón, y para que
        // el editor pueda ver cuál salió elegida y cambiarla si quiere.
        ajustes.guardar({ ...ajustes.leer(), plantillaPrproj: encontrada });
        return { ok: true, ruta: encontrada, hallada: true };
    }
    return { ok: false, falta: anotada ? 'no-esta' : 'sin-elegir', ruta: anotada || undefined };
}

/**
 * @param {object} deps { ipcMain, dialog, ventana, send, anotar } de `main.js`
 */
function registrar({ ipcMain, dialog, ventana, send, anotar }) {
    ipcMain.handle('prproj-plantilla', () => estadoDeLaPlantilla());

    /**
     * Elegir la plantilla, y comprobarla en el mismo gesto.
     *
     * Se valida antes de guardarla y no al usarla: enterarse de que el archivo
     * no servía recién cuando se quiso generar el curso entero es enterarse
     * tarde y en el peor momento. Acá el error todavía tiene arreglo obvio,
     * que es elegir otro.
     */
    ipcMain.handle('prproj-elegir-plantilla', async () => {
        const elegido = await dialog.showOpenDialog(ventana(), {
            title: 'Elegí un proyecto de Premiere para usar de plantilla',
            buttonLabel: 'Usar de plantilla',
            filters: [{ name: 'Proyecto de Premiere', extensions: ['prproj'] }],
            properties: ['openFile']
        });
        if (elegido.canceled || !elegido.filePaths.length) return { ok: false, cancelado: true };

        const ruta = elegido.filePaths[0];
        const mal = porQueNoSirve(ruta);
        if (mal) {
            anotar('prproj.plantilla-mala', { ruta, error: mal });
            return { ok: false, error: mal };
        }
        const guardados = ajustes.guardar({ ...ajustes.leer(), plantillaPrproj: ruta });
        anotar('prproj.plantilla', { ruta });
        return { ok: true, ruta: guardados.plantillaPrproj };
    });

    ipcMain.handle('prproj-generar', async (event, carpeta) => {
        const plantilla = estadoDeLaPlantilla();
        if (!plantilla.ok) return { ok: false, ...plantilla };

        let destino = destinoDe(carpeta);
        if (fs.existsSync(destino)) {
            // Con el nombre atado a la carpeta, el segundo apretón del botón
            // apunta siempre al mismo archivo. Y ese archivo no es un resultado
            // sino un lugar de trabajo: para cuando alguien vuelva a generar, ahí
            // adentro puede haber una tarde de edición. Reemplazarlo en silencio
            // sería tirar trabajo sin avisar, que es el defecto que menos se
            // perdona.
            const r = await dialog.showMessageBox(ventana(), {
                type: 'warning',
                buttons: ['Guardar uno nuevo al lado', 'Reemplazarlo', 'Cancelar'],
                defaultId: 0,
                cancelId: 2,
                title: 'Ya hay un proyecto de este curso',
                message: 'Ya hay un proyecto de este curso',
                detail: `${destino}\n\nSi lo abriste en Premiere y editaste adentro, ` +
                    'reemplazarlo se lleva puesto ese trabajo.'
            });
            if (r.response === 2) return { ok: false, cancelado: true };
            if (r.response === 0) destino = alLado(destino);
        }

        anotar('prproj.genera', { carpeta, destino, plantilla: plantilla.ruta });
        try {
            const r = await curso.generar({
                carpeta,
                destino,
                plantilla: plantilla.ruta,
                avisar: paso => send('prproj-aviso', { carpeta, ...paso })
            });
            anotar('prproj.generado', { carpeta, ruta: r.ruta, clases: r.clases });
            return { ok: true, ...r };
        } catch (err) {
            anotar('prproj.genera-falla', { carpeta, error: err.message });
            return { ok: false, error: err.message };
        }
    });
}

module.exports = {
    registrar,
    estadoDeLaPlantilla,
    destinoDe,
    alLado,
    porQueNoSirve,
    buscarPlantilla,
    candidatosDe,
    loEscribimosNosotros
};
