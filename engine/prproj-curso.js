'use strict';
/**
 * prproj-curso.js — Un curso entero en un proyecto de Premiere.
 *
 * Es la capa que sabe de Class Cut. Abajo tiene el motor (`prproj.js`, objetos y
 * referencias) y el taller (`prproj-secuencia.js`, secuencias y cortes), y
 * ninguno de los dos sabe qué es una clase. Acá se decide de dónde salen los
 * datos, cómo se ordenan los bins y qué se le avisa al editor.
 *
 * **De dónde saca los datos, que es la decisión que manda.** Class Cut escribe
 * dos clases de XML y este módulo elige solo:
 *
 * 1. Si hay XML en `<carpeta>/The Cutter/` usa esos. Son los **cortados**, los
 *    que salen de procesar una clase en «Clases», y traen todo lo que hace
 *    valioso al `.prproj`: los clips con sus rutas, los cortes con sus tiempos,
 *    las pistas, los colores de etiqueta y los marcadores. Es el caso que manda.
 * 2. Si no, y hay XML en `<carpeta>/xml/`, usa esos. Son las **notas en vivo**
 *    de «Grabar»: marcadores tomados mientras se grababa, sin material ni
 *    cortes. Sale un proyecto de marcadores, que no es gran cosa pero le ahorra
 *    al editor importar de a uno.
 * 3. Si no hay ninguno, el error dice cuál de las dos cosas falta, porque
 *    "no encontré nada" no le dice a nadie qué hacer después: una carpeta sin
 *    procesar y una carpeta sin grabar se arreglan distinto.
 *
 * Los dos casos no prometen lo mismo, así que el resultado lo dice: el campo
 * `fuente` vale `'cortes'` o `'notas'`, y lo mismo va escrito en `avisos` para
 * que se lea sin mirar el campo.
 *
 * **Por qué se listan los XML en vez de usar `course-scan.js`.** `course-scan`
 * enumera las clases de una carpeta y `estado-clase` sabe si el trabajo guardado
 * sigue vigente, y las dos cosas son las correctas para la pestaña «Clases», que
 * tiene que mostrar también las clases que faltan procesar. Acá la pregunta es
 * otra: qué clases YA se procesaron, y de eso el XML es la prueba directa —
 * existe si y solo si alguien procesó la clase. Pasar por `course-scan` sería
 * enumerar clases para después preguntarle a cada una si tiene XML, que es el
 * mismo resultado por el camino largo.
 *
 * Y hay un motivo más fuerte para no meter `estado-clase` en la decisión: diría
 * que un XML escrito antes de que el material cambiara está vencido, y por eso
 * habría que saltearlo. Pero un XML vencido igual se importa bien y es mejor que
 * nada; negárselo al editor sería peor que dárselo. Si algún día se quiere
 * avisar de los vencidos, `estado-clase` está para eso y no hay que tocar nada
 * de acá — es un aviso más, no otra fuente.
 */

const fs = require('fs');
const path = require('path');

const workspace = require('./workspace');
const prproj = require('./prproj');
const { Taller, ETIQUETAS, loQueFalta } = require('./prproj-secuencia');
const { leerArchivo } = require('./clase-del-xml');

/**
 * Los intermedios del pipeline, que no son la entrega de ninguna clase.
 *
 * `_poblada` y `_alineada` son pasos del corte y viven en `The Cutter/Backup/`,
 * así que normalmente ni se cruzan; se filtran igual porque copiar uno al lado
 * "para mirarlo" es algo que pasa, y entraría como si fuera una clase más.
 */
const INTERMEDIOS = /_(poblada|alineada)\.xml$/i;

/**
 * El XML maestro de sincronía, que vive junto a las clases pero no es una.
 *
 * El nombre se le pregunta a `workspace` en vez de escribirlo acá: es la misma
 * función con la que se escribió el archivo, así que si algún día se llama de
 * otra manera, esto lo sigue solo.
 */
const MAESTRO = path.basename(workspace.masterXml(''));

/** Cómo se llaman los bins que se arman. */
const BIN_SECUENCIAS = '02 Secuencias';
const BIN_MATERIAL = '01 Material';

/**
 * Los seis bins de la raíz, en el orden en que los quiere el editor.
 *
 * Copiado del proyecto que armó a mano. Los cuatro últimos quedan vacíos a
 * propósito: son el andamio del trabajo que viene después de cortar.
 */
const ORDEN_DE_BINS = [BIN_MATERIAL, BIN_SECUENCIAS, '03 Audio', '04 Assets', '05 Comps', '06 Color'];


// ─── Encontrar de dónde salen los datos ──────────────────────────────

/**
 * Los XML de una carpeta, en el orden en que se llaman las clases.
 *
 * El orden importa: el editor abre el bin de secuencias y espera la clase 1
 * arriba. Se compara con `numeric` para que la 10 vaya después de la 9 y no
 * después de la 1, que es lo que da el orden de texto.
 */
function xmlsDe(dir) {
    let entradas;
    try {
        entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    return entradas
        .filter(e => e.isFile() && /\.xml$/i.test(e.name)
            && !INTERMEDIOS.test(e.name) && e.name !== MAESTRO)
        .map(e => path.join(dir, e.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'es', { numeric: true }));
}

/**
 * Decide con cuál de las dos fuentes se trabaja.
 *
 * Las dos carpetas se piden a `workspace` en vez de escribir `'The Cutter'` y
 * `'xml'` acá: son las mismas funciones con las que `export.js` y la toma de
 * notas escribieron los archivos, así que si algún día se mueven, se mueven en
 * un solo lugar y esto los sigue.
 */
function ubicarFuente(carpeta) {
    const dirCortes = workspace.outputRoot(carpeta);
    const dirNotas = workspace.notasXmlDir(carpeta);

    const cortes = xmlsDe(dirCortes);
    if (cortes.length) return { ok: true, tipo: 'cortes', dir: dirCortes, xmls: cortes };

    const notas = xmlsDe(dirNotas);
    if (notas.length) return { ok: true, tipo: 'notas', dir: dirNotas, xmls: notas };

    // El error nombra las dos cosas que faltan y qué hacer con cada una, porque
    // son dos problemas distintos con dos arreglos distintos.
    return {
        ok: false,
        error: `No hay XML para armar el proyecto en «${path.basename(carpeta)}».`
            + ` No encontré clases procesadas en «${path.relative(carpeta, dirCortes) || 'The Cutter'}»`
            + ' (se generan procesando una clase en la pestaña Clases),'
            + ` ni notas tomadas en vivo en «${path.relative(carpeta, dirNotas) || 'xml'}»`
            + ' (se generan grabando desde la pestaña Grabar).'
    };
}

// ─── Armar el proyecto ───────────────────────────────────────────────

/**
 * Mete en el proyecto los archivos de una clase, sin repetir ninguno.
 *
 * El `registro` es por curso y no por clase: dos clases podrían nombrar el mismo
 * archivo, y en un `.prproj` cada archivo tiene que entrar UNA vez —si entrara
 * dos, el panel mostraría dos filas para el mismo medio y el editor no sabría
 * cuál usar. Se indexa por ruta absoluta, que es lo que identifica un archivo.
 */
function importarMaterial(taller, clase, registro, bin, avisos) {
    const mios = new Map();
    for (const [, archivo] of clase.archivos) {
        if (registro.has(archivo.ruta)) {
            mios.set(archivo.id, registro.get(archivo.ruta));
            continue;
        }
        if (!archivo.existe) {
            avisos.push(`${clase.nombre}: el archivo «${archivo.nombre}» no está en el disco;`
                + ' el clip entra igual y Premiere lo va a mostrar como faltante');
        }
        const medio = taller.importarMedio({
            ruta: archivo.ruta,
            nombre: archivo.nombre,
            duracionSeg: archivo.duracionSeg,
            canales: archivo.canales,
            conVideo: archivo.conVideo,
            etiqueta: etiquetaDelArchivo(clase, archivo)
        });
        taller.guardarEn(bin, medio.clipProjectItem);
        registro.set(archivo.ruta, medio);
        mios.set(archivo.id, medio);
    }
    return mios;
}

/**
 * Con qué color se pinta la fila del panel de un archivo.
 *
 * Sale del primer corte que lo usa, o sea que la regla la sigue decidiendo
 * `fcp-xml.js` y acá solo se lee. Es lo que hace que la cámara del profesor
 * quede cerúlea y la del grabador de pantalla rosa en el panel, igual que en la
 * línea de tiempo, sin repetir la tabla de colores en dos módulos.
 */
function etiquetaDelArchivo(clase, archivo) {
    for (const pista of clase.pistas.video) {
        for (const corte of pista.cortes) {
            if (corte.archivo.id === archivo.id && corte.etiqueta) return corte.etiqueta;
        }
    }
    return null;
}

/**
 * Una clase → una secuencia con sus pistas, sus cortes y sus marcadores.
 */
function armarClase(taller, clase, medios, binSecuencias, avisos) {
    const pistasVideo = Math.max(1, clase.pistas.video.length);
    const pistasAudio = Math.max(1, clase.pistas.audio.length);

    const secuencia = taller.crearSecuencia({
        nombre: clase.nombre,
        pistasVideo,
        pistasAudio,
        duracionSeg: clase.duracionSeg
    });
    taller.guardarEn(binSecuencias, secuencia.itemDelPanel);

    let colocados = 0;
    const sinPintar = new Set();
    const colocar = (cortes, pista) => {
        for (const corte of cortes) {
            const medio = medios.get(corte.archivo.id);
            if (!medio) continue;
            if (corte.etiqueta && !ETIQUETAS[corte.etiqueta]) sinPintar.add(corte.etiqueta);
            taller.colocarCorte({
                pista,
                medio,
                desdeSeg: corte.desdeSeg,
                hastaSeg: corte.hastaSeg,
                entradaSeg: corte.entradaSeg,
                etiqueta: corte.etiqueta,
                sonando: corte.sonando
            });
            colocados++;
        }
    };

    clase.pistas.video.forEach((p, i) => colocar(p.cortes, secuencia.pistasVideo[i]));
    clase.pistas.audio.forEach((p, i) => colocar(p.cortes, secuencia.pistasAudio[i]));

    const marcadores = clase.marcadores.filter(m => m.color != null);
    if (marcadores.length !== clase.marcadores.length) {
        avisos.push(`${clase.nombre}: ${clase.marcadores.length - marcadores.length} marcador(es)`
            + ' sin color declarado quedaron afuera');
    }
    taller.ponerMarcadores(secuencia.secuencia, marcadores);

    for (const etiqueta of sinPintar) {
        avisos.push(`${clase.nombre}: la etiqueta «${etiqueta}» no está entre las medidas`
            + ` (${Object.keys(ETIQUETAS).join(', ')}), así que esos clips entran sin pintar`);
    }
    if (clase.conEfectos) {
        avisos.push(`${clase.nombre}: ${clase.conEfectos} corte(s) traían el recuadro puesto en el XML;`
            + ' entran en su lugar y con su duración, pero sin el encuadre');
    }

    return { nombre: clase.nombre, cortes: colocados, marcadores: marcadores.length, pistasVideo, pistasAudio };
}


// ─── La puerta ───────────────────────────────────────────────────────

/**
 * Arma un `.prproj` con una secuencia por clase del curso.
 *
 * **El destino llega hecho y acá no se discute.** El nombre del proyecto sale de
 * la carpeta del curso, así que el segundo apretón del botón apunta siempre al
 * mismo archivo — y ese archivo no es un resultado sino el lugar donde el editor
 * abre Premiere y trabaja: para cuando alguien vuelva a generar puede haber una
 * tarde de edición adentro. Entonces hay que preguntar antes de pisarlo, y
 * preguntar es un diálogo, y los diálogos viven en el proceso principal. `ipc`
 * resuelve el choque y llama con la ruta ya libre. Acá no se calcula ningún
 * nombre: dos lugares que deciden dónde se escribe es como aparece un archivo
 * donde nadie lo busca.
 *
 * @param {object} opciones
 * @param {string} opciones.carpeta   la ruta raíz del curso
 * @param {string} opciones.destino   la ruta completa del `.prproj` a escribir
 * @param {string} opciones.plantilla un `.prproj` del que copiar los moldes
 * @param {function} [opciones.avisar] recibe `{hecho, total, que}` mientras arma
 * @param {number} [opciones.semilla] para que dos corridas den el mismo archivo
 * @returns {Promise<{ok:boolean, ruta:string, clases:number, fuente:string, avisos:string[], error:string}>}
 */
async function generar(opciones) {
    const op = opciones || {};
    const avisos = [];
    const vacio = { ok: false, ruta: null, clases: 0, fuente: null, avisos, error: null };

    if (!op.carpeta) return { ...vacio, error: 'No me dijeron de qué carpeta.' };
    if (!fs.existsSync(op.carpeta)) {
        return { ...vacio, error: `La carpeta «${op.carpeta}» no está.` };
    }
    if (!op.destino) return { ...vacio, error: 'No me dijeron dónde escribir el proyecto.' };
    if (!op.plantilla || !fs.existsSync(op.plantilla)) {
        return {
            ...vacio,
            error: 'Falta la plantilla: un .prproj de Premiere del que copiar los moldes'
                + (op.plantilla ? ` (no encontré «${op.plantilla}»)` : '')
        };
    }

    const fuente = ubicarFuente(op.carpeta);
    if (!fuente.ok) return { ...vacio, error: fuente.error };

    // Los dos casos no prometen lo mismo, y el editor tiene que saber cuál le
    // tocó antes de abrir el archivo y extrañar los cortes.
    avisos.push(fuente.tipo === 'cortes'
        ? `Salió de ${fuente.xmls.length} clase(s) procesada(s) en «${workspace.OUTPUT_DIR}»:`
            + ' trae el material, los cortes y los marcadores.'
        : `No hay clases procesadas, así que salió de ${fuente.xmls.length} XML de notas tomadas en vivo:`
            + ' trae los marcadores, pero no el material ni los cortes.'
            + ' Procesá las clases en la pestaña Clases y volvé a generar para tener todo.');

    const avisar = typeof op.avisar === 'function' ? op.avisar : () => {};
    // La forma del aviso es la que espera la ventana: `hecho` de `total`, y `que`
    // en palabras para el globito. Un aviso que tira no puede llevarse puesta la
    // generación — sería perder el trabajo por no poder contarlo.
    const decir = (hecho, total, que) => {
        try { avisar({ hecho, total, que }); } catch (e) { /* contar no es el trabajo */ }
    };

    // Se leen todos los XML antes de tocar la plantilla: si uno está roto,
    // conviene saberlo antes de haber armado medio proyecto. No se avisa de a
    // uno porque leer trece XML tarda menos que pintar el botón: la barra
    // arrancaría y terminaría en el mismo cuadro.
    decir(0, fuente.xmls.length, `Leyendo ${fuente.xmls.length} clase(s)…`);
    const clases = [];
    fuente.xmls.forEach(ruta => {
        const leida = leerArchivo(ruta);
        if (!leida.ok) {
            avisos.push(`${path.basename(ruta)}: ${leida.error}`);
            return;
        }
        avisos.push(...leida.avisos);
        clases.push(leida);
    });
    if (!clases.length) {
        return {
            ...vacio,
            fuente: fuente.tipo,
            error: `Encontré ${fuente.xmls.length} XML en «${path.basename(fuente.dir)}»`
                + ' pero ninguno se pudo leer. Mirá los avisos.'
        };
    }

    let proyecto;
    try {
        proyecto = prproj.Proyecto.leer(op.plantilla);
    } catch (e) {
        return { ...vacio, fuente: fuente.tipo, error: `No pude abrir la plantilla: ${e.message}` };
    }

    let taller;
    try {
        taller = new Taller(proyecto, { semilla: op.semilla });
        // Se revisan los moldes ANTES de tocar nada. Descubrir a mitad del
        // armado que la plantilla no presta un corte de video deja al editor
        // esperando y sin archivo; acá el mensaje dice qué le falta.
        const faltan = loQueFalta(taller.moldes);
        if (faltan.length) throw new Error(`le falta ${faltan.join(', y ')}`);
    } catch (e) {
        return {
            ...vacio,
            fuente: fuente.tipo,
            error: `La plantilla «${path.basename(op.plantilla)}» no sirve de molde: ${e.message}`
        };
    }

    let resumen;
    try {
        resumen = poblar(taller, clases, avisos, decir);
    } catch (e) {
        return { ...vacio, fuente: fuente.tipo, error: `Se cortó armando el proyecto: ${e.message}` };
    }

    try {
        decir(clases.length, clases.length, 'Guardando el proyecto…');
        proyecto.guardar(op.destino);
    } catch (e) {
        // `guardar` verifica antes de escribir, así que un fallo acá quiere decir
        // que el grafo quedó mal y que NO se escribió nada. Se dice así.
        return {
            ...vacio,
            fuente: fuente.tipo,
            error: `El proyecto quedó inconsistente y no lo escribí: ${e.message}`
        };
    }

    return {
        ok: true,
        ruta: op.destino,
        clases: resumen.clases,
        fuente: fuente.tipo,
        avisos,
        error: null
    };
}

/**
 * Los bins y las secuencias, en el orden en que un editor los busca.
 *
 * **Esta organización no la inventé: es la que el editor armó a mano.** Importó
 * el curso en Premiere, lo acomodó como lo quería y guardó, y de ese archivo
 * salió esta lista, bin por bin y en este orden:
 *
 *     Root Bin/
 *         01 Material/
 *             <clase>/       los doce archivos de esa clase
 *         02 Secuencias/     una por clase, en orden de clase
 *         03 Audio/          vacío
 *         04 Assets/         vacío
 *         05 Comps/          vacío
 *         06 Color/          vacío
 *
 * Los números adelante son para que el panel los ordene así y no alfabéticamente.
 * El material va agrupado por clase porque son doce archivos por clase: sueltos
 * serían más de ciento cincuenta filas en una lista sola, tan inútil como no
 * tener bins. Agrupado queda igual que en el disco, así que el editor ya sabe
 * dónde mirar. Y el bin de material de cada clase se llama igual que su
 * secuencia, que es el `sequenceName` de Class Cut.
 *
 * **Los cuatro vacíos se crean igual aunque no entre nada.** Son el andamio del
 * trabajo que viene después —la música, los gráficos, las composiciones, el
 * color— y el editor espera encontrarlos armados al abrir. Un bin vacío cuesta
 * un objeto; que falte cuesta que lo cree a mano trece veces.
 */
function poblar(taller, clases, avisos, decir) {
    const raiz = taller.raizDelPanel();

    // Lo primero de todo: descolgar lo que traía la plantilla, así lo generado
    // no queda mezclado con las secuencias y los medios del editor. Los objetos
    // siguen vivos hasta el final porque de ellos se clona todo esto.
    const descolgados = taller.vaciarElPanel();

    const bins = new Map();
    ORDEN_DE_BINS.forEach((nombre, i) => {
        const bin = taller.crearBin(nombre, { orden: i });
        taller.guardarEn(raiz, bin);
        bins.set(nombre, bin);
    });
    const binMaterial = bins.get(BIN_MATERIAL);
    const binSecuencias = bins.get(BIN_SECUENCIAS);

    const registro = new Map();
    const armadas = [];
    clases.forEach((clase, i) => {
        decir(i, clases.length, `Armando ${clase.nombre}…`);
        let medios = new Map();
        if (clase.archivos.size) {
            const binClase = taller.crearBin(clase.nombre, { orden: i });
            taller.guardarEn(binMaterial, binClase);
            medios = importarMaterial(taller, clase, registro, binClase, avisos);
        }
        armadas.push(armarClase(taller, clase, medios, binSecuencias, avisos));
    });

    // Recién ahora se borran los moldes: ya se clonó todo lo que hacía falta.
    // Si algo de lo generado hubiera quedado apuntando a la plantilla, no se
    // rompe en silencio — `verificar` lo encuentra y `guardar` no escribe.
    const podados = taller.podarLaPlantilla();
    if (descolgados) {
        avisos.push(`Se quitaron ${descolgados} objeto(s) que traía la plantilla`
            + ` (${podados} borrado(s)); el panel quedó solo con lo del curso.`);
    }

    const cortes = armadas.reduce((n, c) => n + c.cortes, 0);
    const marcas = armadas.reduce((n, c) => n + c.marcadores, 0);
    avisos.push(`${armadas.length} secuencia(s), ${cortes} corte(s), ${marcas} marcador(es)`
        + ` y ${registro.size} archivo(s) de material.`);

    return { clases: armadas.length, detalle: armadas, medios: registro.size, cortes, marcas };
}

module.exports = {
    generar,
    ubicarFuente,
    xmlsDe,
    INTERMEDIOS,
    MAESTRO,
    BIN_SECUENCIAS,
    BIN_MATERIAL
};
