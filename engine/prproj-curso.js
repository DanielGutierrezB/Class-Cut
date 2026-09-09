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
const nidos = require('./prproj-nidos');

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

/** El bin que junta los pasos previos, adentro del de secuencias. */
const BIN_PRE = 'Pre';

/**
 * Los pasos del corte que quedaron guardados y que se pueden volver a mirar.
 *
 * Antes de tirar un solo cuadro, el pipeline deja en `The Cutter/Backup/` dos
 * fotos de la clase entera: `poblada`, con el material completo y los marcadores
 * como venían del XML del Rodecaster, y `alineada`, el mismo material con los
 * marcadores ya corridos por la alineación. Van en este orden porque es el orden
 * en que pasaron —primero se pobló, después se alineó, después se cortó—, y es
 * el orden en que sirven: cuando un marcador quedó donde no va, la pregunta es
 * en cuál de los dos pasos se movió.
 *
 * **El nombre del bin sale del nombre del archivo y no está escrito acá.** Es lo
 * que dice `workspace.FILES` sin la extensión, o sea la misma palabra que el
 * editor ve cuando abre `Backup/` en el Finder. La alternativa era ponerles algo
 * más explicativo —«antes de ajustar los marcadores», «antes del corte
 * automático»— y se descartó porque serían dos vocabularios para la misma cosa,
 * el del disco y el del panel, y comparar un bin con un archivo obligaría a
 * traducir de uno al otro cada vez. Con esto, además, un paso que cambie de
 * nombre en `workspace` cambia también acá y no queda un bin mintiendo.
 */
const PASOS_PREVIOS = ['populatedXml', 'alignedXml'].map(artefacto => ({
    nombre: path.basename(workspace.FILES[artefacto], '.xml'),
    rutaDe: (carpeta, clase) => workspace.artifact(carpeta, nombreGuardado(clase), artefacto)
}));

/**
 * El tercer paso: la clase cortada como se entregaba antes de las anidaciones.
 *
 * No vive en `Backup/` sino que ES el XML de la entrega, el que abre en Resolve,
 * y por eso no sale de `workspace.FILES` como los otros dos. Se anexa igual que
 * ellos porque cumple la misma función: es una foto de un paso anterior a la que
 * se puede volver.
 *
 * **Y esta vez el paso anterior sigue siendo la entrega en el otro formato.** La
 * secuencia de clase del proyecto ahora corta sobre las anidaciones, que es más
 * cómodo de editar pero más difícil de mirar: para saber qué archivo hay detrás
 * de un clip hay que entrar al nido. Esta copia responde eso sin entrar a nada, y
 * es además lo único que se parece a lo que Resolve va a abrir.
 */
const PASO_SIN_ANIDAR = {
    nombre: 'sin-anidar',
    rutaDe: (carpeta, clase) => clase.rutaXml
};

/** Los tres, en el orden en que pasaron: poblar, alinear, cortar. */
const PASOS = PASOS_PREVIOS.concat([PASO_SIN_ANIDAR]);


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
 *
 * Es el espejo plano del XML: cada corte apunta al archivo que el XML nombra.
 * La entrega ya no se arma así —usa `armarClaseSobreNidos`— pero los pasos de
 * `Pre` sí, y tiene que ser así: son fotos de un archivo que existe en el disco
 * y su valor es parecerse a él, no ser cómodas de editar.
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
    // El recuadro NO se avisa por clase: lo trae casi toda clase que tenga
    // pantalla compartida, así que trece clases dejaban trece líneas iguales que
    // tapaban a las que sí eran de esta clase y de ninguna otra. Se cuenta acá y
    // se dice una vez, en `poblar`, con el total.
    return {
        nombre: clase.nombre,
        cortes: colocados,
        marcadores: marcadores.length,
        conEfectos: clase.conEfectos || 0,
        pistasVideo,
        pistasAudio
    };
}


// ─── La clase, armada sobre las anidaciones ──────────────────────────

/**
 * Las vistas de cada bloque, en el orden en que quedaron en la línea de tiempo.
 *
 * Salen del `cutplan.json` que el corte dejó al lado del XML, y no del XML: ahí
 * la vista solo viaja en el nombre de los marcadores, y un bloque sin nota no
 * deja marcador. O sea que el XML sabe la vista de algunos bloques y de otros
 * no, y «algunos» no sirve para decidir el orden de las pistas.
 *
 * Sin `cutplan.json` —una clase cortada con una versión vieja— se contesta
 * vacío, y quien llama se arregla con lo que el XML sí dice: qué pista quedó
 * encendida. Eso alcanza para todo salvo para distinguir una `S` de una `R`.
 */
function vistasDe(carpeta, clase) {
    const ruta = workspace.artifact(carpeta, nombreGuardado(clase), 'cutplan');
    try {
        const plan = JSON.parse(fs.readFileSync(ruta, 'utf8'));
        return (plan.segments || []).filter(s => s.keep).map(s => s.view || '');
    } catch (err) {
        return [];
    }
}

/** Las vistas que se ven con el grabador de pantalla y no con la cámara. */
const VISTA_DE_CAMARA = 'PV';
const VISTA_DE_SLIDE = 'S';

/**
 * Una clase → una secuencia que corta sobre las anidaciones del curso.
 *
 * **Esta es la entrega, y la diferencia con `armarClase` es toda la gracia.**
 * Los cortes caen en los mismos lugares y duran lo mismo, pero en vez de mirar
 * al archivo miran a `CAM`, a `SR` o a `SLIDE`. Para el editor la línea de
 * tiempo se ve igual; lo que cambia es que ahora hay UN lugar donde tocar la
 * cámara de las trece clases en vez de dos mil.
 *
 * La cuenta que lo hace posible es una sola: un corte que en el XML entraba en
 * el segundo 300 de su clase entra en `franja.desdeSeg + 300` del nido, porque
 * adentro del nido esa clase arranca ahí. Los cinco nidos comparten el mapa de
 * franjas justamente para que sea la misma cuenta en todos.
 *
 * **El orden de las pistas depende de si la clase tiene alguna `S`**, y lo pidió
 * así el editor: con slides, `SLIDE` va en la dos y empuja al grabador de
 * pantalla a la tres, así el recuadro del profesor queda siempre solo, arriba de
 * todo. Sin slides no hace falta esa pista y no se crea: una pista vacía en las
 * trece clases es ruido que hay que saltear cada vez que se mira una.
 */
function armarClaseSobreNidos(taller, clase, pedido) {
    const { nidos, franja, vistas, medios, binSecuencias, avisos } = pedido;

    // Los bloques salen de la primera pista de video, que `export.js` escribe
    // con un corte por bloque que sobrevivió al corte, encendido o apagado.
    const bloques = clase.pistas.video.length ? clase.pistas.video[0].cortes : [];
    // Sin `cutplan.json` la vista se deduce de qué pista quedó encendida: si la
    // cámara está prendida es `PV` y si no, algo que se ve con la pantalla. No
    // distingue una `S`, y por eso una clase así entra sin la pista de slides.
    const vistaDe = i => {
        if (vistas[i]) return vistas[i];
        return bloques[i] && bloques[i].sonando ? VISTA_DE_CAMARA : 'R';
    };

    const hayS = bloques.some((corte, i) => vistaDe(i) === VISTA_DE_SLIDE);
    const pistasVideo = hayS ? 4 : 3;

    // La segunda pista de audio es el Live-Mix crudo, así que solo existe si se
    // sabe cuál es. Cuando no se sabe, la clase entra con una sola: mejor sin
    // respaldo que con una pista vacía en las trece.
    const vivo = nidos.pistaDelLiveMix(clase);
    const secuencia = taller.crearSecuencia({
        nombre: clase.nombre,
        pistasVideo,
        pistasAudio: vivo ? 2 : 1,
        duracionSeg: clase.duracionSeg
    });
    taller.guardarEn(binSecuencias, secuencia.itemDelPanel);

    const pista = {
        camara: secuencia.pistasVideo[0],
        slide: hayS ? secuencia.pistasVideo[1] : null,
        pantalla: secuencia.pistasVideo[hayS ? 2 : 1],
        mini: secuencia.pistasVideo[hayS ? 3 : 2]
    };

    let colocados = 0;
    const poner = (suPista, nido, corte, sonando, etiqueta) => {
        if (!suPista) return null;
        const item = taller.colocarCorte({
            pista: suPista,
            medio: nido.comoFuente,
            desdeSeg: corte.desdeSeg,
            hastaSeg: corte.hastaSeg,
            entradaSeg: franja.desdeSeg + corte.entradaSeg,
            etiqueta,
            sonando
        });
        colocados++;
        return item;
    };

    let sinRecuadro = 0;
    bloques.forEach((corte, i) => {
        const vista = vistaDe(i);
        const esCamara = vista === VISTA_DE_CAMARA;
        const esSlide = vista === VISTA_DE_SLIDE;

        // La cámara y la pantalla entran SIEMPRE las dos, y solo se enciende la
        // que el bloque eligió. Es lo que ya hacía el XML: cambiar de plano
        // sigue siendo un clic y ninguna tapa a la buena.
        poner(pista.camara, nidos.camara, corte, esCamara, nidos.etiquetaDeCamara);
        poner(pista.pantalla, nidos.pantalla, corte, !esCamara && !esSlide, nidos.etiquetaDePantalla);
        if (pista.slide) poner(pista.slide, nidos.slide, corte, esSlide);

        // **El recuadro del profesor: la MISMA `CAM` de la pista de abajo, con
        // la escala y la posición puestas encima.** No es otro nido: el editor
        // probó `MINI` —`CAM` anidada una segunda vez con el efecto adentro— y
        // prefirió esto, porque una anidación sobre otra es un nivel más para
        // entrar cada vez que quiere ver qué está mirando.
        //
        // Va solo donde se ve la pantalla a cuadro completo. En `S` no: el
        // profesor ya está de fondo adentro del slide, y ponerlo otra vez en la
        // esquina sería mostrarlo dos veces.
        if (!esCamara && !esSlide) {
            const recuadro = poner(pista.mini, nidos.camara, corte, true, nidos.etiquetaDeCamara);
            if (recuadro && !taller.ponerEncuadre(recuadro, nidos.encuadre)) sinRecuadro++;
        }
    });

    // **Las dos pistas de audio no son lo mismo, y esa es la gracia.** Arriba va
    // el nido, que adentro tiene los diez canales del Rodecaster con el Live-Mix
    // como único encendido: si un día hay que rescatar el micrófono de corbata
    // de la clase siete, el canal está ahí y es cuestión de subirlo. Abajo va el
    // Live-Mix a secas, apuntando al WAV y sin nido de por medio, muteado.
    //
    // El respaldo tiene que ser el archivo justamente porque el nido no lo es:
    // dos copias del mismo nido se rompen juntas. Con el WAV crudo debajo, si el
    // nido se desanida, se desincroniza o el editor lo toca de más, hay una
    // pista que sigue siendo exactamente lo que salió del aparato, y volver es
    // desmutearla.
    if (vivo) {
        for (const corte of vivo.cortes) {
            poner(secuencia.pistasAudio[0], nidos.audio, corte, true, nidos.etiquetaDeAudio);
            const medio = medios.get(corte.archivo.id);
            if (!medio) continue;
            // `entradaSeg` a secas, sin la franja: este corte mira al archivo de
            // esta clase, no a la línea de nueve horas donde su clase empieza en
            // `franja.desdeSeg`. Sumársela lo mandaría al medio de otra clase.
            taller.colocarCorte({
                pista: secuencia.pistasAudio[1],
                medio,
                desdeSeg: corte.desdeSeg,
                hastaSeg: corte.hastaSeg,
                entradaSeg: corte.entradaSeg,
                sonando: false
            });
            colocados++;
        }
    }

    const marcadores = clase.marcadores.filter(m => m.color != null);
    if (marcadores.length !== clase.marcadores.length) {
        avisos.push(`${clase.nombre}: ${clase.marcadores.length - marcadores.length} marcador(es)`
            + ' sin color declarado quedaron afuera');
    }
    taller.ponerMarcadores(secuencia.secuencia, marcadores);

    return {
        nombre: clase.nombre,
        cortes: colocados,
        marcadores: marcadores.length,
        conEfectos: 0,
        conSlides: hayS,
        sinRecuadro,
        pistasVideo,
        pistasAudio: vivo ? 2 : 1
    };
}


// ─── Los pasos de antes del corte ────────────────────────────────────

/**
 * Con qué nombre de secuencia se guardaron los artefactos de una clase.
 *
 * Sale del nombre del archivo final y no del `<name>` de adentro, aunque hoy los
 * dos digan lo mismo: `export.js` escribe `The Cutter/<X>.xml` y
 * `The Cutter/Backup/<X>_poblada.xml` en la misma corrida y a partir del mismo
 * `sequenceName`, así que emparejarlos por el nombre del archivo los sigue
 * emparejando aunque alguien haya editado el `<name>` a mano. El `<name>` es
 * contenido; el nombre del archivo es la llave con la que se guardó.
 */
function nombreGuardado(clase) {
    return clase.rutaXml ? path.basename(clase.rutaXml, path.extname(clase.rutaXml)) : clase.nombre;
}

/**
 * Los pasos previos de cada clase, en `02 Secuencias/Pre/<paso>/`.
 *
 * **Qué resuelve.** El proyecto entrega la clase ya cortada, que es lo que el
 * editor va a editar, pero cuando algo quedó raro —un marcador corrido, un tramo
 * que se fue— la pregunta no se contesta ahí adentro: hace falta ver la clase
 * antes del corte y antes de que la alineación tocara los marcadores. Eso ya
 * estaba guardado en `Backup/` y el editor lo importaba de a un XML por vez.
 * Acá entra solo.
 *
 * **Las secuencias no se renombran.** Las tres versiones de una clase llevan
 * adentro el mismo `<name>`, así que en el panel se van a ver tres filas que
 * dicen lo mismo, y lo que las distingue es el bin donde caen. Es a propósito:
 * el nombre es el de la clase y sigue siendo el de la clase en cualquiera de sus
 * pasos, y un `01_clase (poblada)` sería un nombre que no existe en ningún otro
 * lado del disco.
 *
 * **El material no se vuelve a importar.** Se comparte el mismo `registro` que
 * usan las clases, que es por curso justamente para que cada archivo entre una
 * sola vez al panel. Los pasos previos traen el material COMPLETO y el corte
 * final solo el que sobrevivió, así que de acá puede salir algún archivo que la
 * clase no había traído; ese va al bin de material de su clase, que es donde el
 * editor lo va a buscar, y no a uno aparte.
 *
 * **Una clase sin intermedios no es un error.** Un curso procesado con una
 * versión vieja no tiene `Backup/`, y una clase reprocesada a mano puede tener
 * uno de los dos y no el otro. Se saltea, se cuenta, y la generación sigue: el
 * editor prefiere doce pasos previos a que el botón le conteste un error por el
 * que falta.
 *
 * **Y si no hay ninguno, `Pre` no se crea.** Los cuatro bins vacíos de la raíz
 * se crean igual porque son el andamio de un trabajo que el editor va a hacer
 * después y él va a colgar cosas ahí. De este no cuelga nada que él ponga: lo
 * llena el generador o no lo llena nadie, así que un `Pre` vacío no es un lugar
 * reservado sino una carpeta que promete algo que no está.
 *
 * @returns {{secuencias:number, cortes:number, faltan:number}}
 */
function armarLosPasosPrevios(taller, pedido) {
    const { carpeta, clases, binSecuencias, binDeMaterial, registro, avisos } = pedido;

    // Se busca y se lee TODO antes de crear un solo bin, que es lo que permite
    // no crear `Pre` cuando no hay nada: un bin ya creado no se puede deshacer
    // sin dejar el panel a medio armar.
    const porPaso = PASOS.map(paso => ({ paso, leidas: [] }));
    let faltan = 0;
    clases.forEach((clase, indice) => {
        for (const entrada of porPaso) {
            const ruta = entrada.paso.rutaDe(carpeta, clase);
            if (!ruta || !fs.existsSync(ruta)) { faltan++; continue; }
            const leida = leerArchivo(ruta);
            if (!leida.ok) {
                // Un intermedio ilegible sí se avisa: el archivo está y no se
                // pudo leer, que es distinto de que la clase sea vieja.
                avisos.push(`${path.basename(ruta)}: ${leida.error}`);
                faltan++;
                continue;
            }
            entrada.leidas.push({ clase, indice, leida });
        }
    });

    if (!porPaso.some(e => e.leidas.length)) return { secuencias: 0, cortes: 0, faltan };

    // `Pre` va al final del bin de secuencias, después de las clases, porque lo
    // que el editor abre todos los días son las clases. El `orden` es para la
    // vista de cuadrícula, donde la lista no manda.
    const binPre = taller.crearBin(BIN_PRE, { orden: clases.length });
    taller.guardarEn(binSecuencias, binPre);

    // Los avisos de un paso previo se suman solo si dicen algo que no se dijo
    // ya. Son la misma clase mirada antes, así que casi todos salen repetidos
    // —la etiqueta que no está entre las medidas es la misma etiqueta— y con
    // trece clases por dos pasos eso son hasta veintiséis líneas que tapan al
    // único archivo que de verdad falta. Lo que sí es nuevo pasa: un medio que
    // el corte había descartado y no está en el disco aparece nombrándose a sí
    // mismo, y esa línea no la había dejado nadie.
    const dichos = new Set(avisos);
    const suyos = [];
    let secuencias = 0;
    let cortes = 0;

    porPaso.forEach((entrada, orden) => {
        if (!entrada.leidas.length) return;
        const binPaso = taller.crearBin(entrada.paso.nombre, { orden });
        taller.guardarEn(binPre, binPaso);
        for (const { clase, indice, leida } of entrada.leidas) {
            let medios = new Map();
            if (leida.archivos.size) {
                medios = importarMaterial(taller, leida, registro,
                    binDeMaterial(clase, indice), suyos);
            }
            cortes += armarClase(taller, leida, medios, binPaso, suyos).cortes;
            secuencias++;
        }
    });

    for (const aviso of suyos) {
        if (dichos.has(aviso)) continue;
        dichos.add(aviso);
        avisos.push(aviso);
    }
    return { secuencias, cortes, faltan };
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
 * @returns {Promise<{ok:boolean, ruta:string, clases:number, fuente:string,
 *                    avisos:string[], cuenta:string[], error:string}>}
 *          `avisos` es lo que quizás haya que ir a mirar; `cuenta`, la narración
 *          de lo que pasó. Ver por qué están separadas arriba de `generar`.
 */
async function generar(opciones) {
    const op = opciones || {};
    // Dos listas y no una, porque no se leen en el mismo momento ni por la misma
    // razón. `avisos` es lo que quizás haya que ir a mirar: un archivo que no
    // está, marcadores que quedaron afuera, el encuadre que no viaja. `cuenta` es
    // la narración de lo que pasó, que tranquiliza pero no pide nada. Mezcladas,
    // trece líneas de narración tapaban al único archivo que faltaba.
    const avisos = [];
    const cuenta = [];
    const vacio = { ok: false, ruta: null, clases: 0, fuente: null, avisos, cuenta, error: null };

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
    // tocó antes de abrir el archivo y extrañar los cortes. El bueno es
    // narración; el flaco es un aviso, porque hay algo que hacer al respecto.
    if (fuente.tipo === 'cortes') {
        cuenta.push(`Salió de ${fuente.xmls.length} clase(s) procesada(s) en «${workspace.OUTPUT_DIR}»:`
            + ' trae el material, los cortes y los marcadores.');
    } else {
        avisos.push(`No hay clases procesadas, así que salió de ${fuente.xmls.length} XML de notas`
            + ' tomadas en vivo: trae los marcadores, pero no el material ni los cortes.'
            + ' Procesá las clases en la pestaña Clases y volvé a generar para tener todo.');
    }

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
        resumen = poblar(taller, clases, avisos, decir, {
            // Los pasos previos viven en `The Cutter/Backup/`, así que solo los
            // hay cuando la fuente son los cortes. Las notas en vivo son un XML
            // de marcadores y nada más: no tuvieron pipeline y no hay ningún
            // paso anterior que mostrar.
            carpeta: fuente.tipo === 'cortes' ? op.carpeta : null
        });
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
        cuenta: [...cuenta, ...resumen.cuenta],
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
 *             Pre/           los pasos de antes del corte, si están guardados
 *                 poblada/   una por clase, ver `armarLosPasosPrevios`
 *                 alineada/
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
function poblar(taller, clases, avisos, decir, opciones) {
    const op = opciones || {};
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
    // El bin de material de cada clase, para que los pasos previos metan en él
    // lo que traigan de más en vez de armar un segundo lugar donde buscar el
    // mismo archivo. Se crea una vez y se reusa; la clave es la clase leída, que
    // es lo que las dos pasadas tienen en la mano.
    const binesDeMaterial = new Map();
    const binDeMaterial = (clase, i) => {
        if (!binesDeMaterial.has(clase)) {
            const binClase = taller.crearBin(clase.nombre, { orden: i });
            taller.guardarEn(binMaterial, binClase);
            binesDeMaterial.set(clase, binClase);
        }
        return binesDeMaterial.get(clase);
    };

    // **El material de TODAS antes de armar una sola secuencia**, que es lo que
    // el anidado obliga a cambiar. Las anidaciones del curso son una sola línea
    // de tiempo con las trece clases adentro, así que no se pueden armar hasta
    // tener importados los archivos de la última; y las secuencias de clase
    // cortan sobre ellas, así que van después. Antes era una sola pasada.
    const mediosPorClase = new Map();
    clases.forEach((clase, i) => {
        decir(i, clases.length, `Leyendo el material de ${clase.nombre}…`);
        mediosPorClase.set(clase, clase.archivos.size
            ? importarMaterial(taller, clase, registro, binDeMaterial(clase, i), avisos)
            : new Map());
    });

    // Las anidaciones cuelgan del bin de secuencias, que es donde el editor las
    // va a buscar: son secuencias, y son las que abre para tocar todas las
    // clases de una vez.
    //
    // El bin se crea ahora porque los nidos tienen que existir antes que las
    // clases —las clases cortan sobre ellos— pero se CUELGA después, con las
    // clases ya puestas. El orden de la lista es el orden que se ve, y lo que el
    // editor abre todos los días son las clases; los nidos y `Pre` son de las
    // veces que hay que ir a arreglar algo.
    decir(clases.length, clases.length, 'Armando las anidaciones del curso…');
    const binNidos = taller.crearBin(nidos.NOMBRES.raiz, { orden: clases.length });
    const armados = nidos.armarLosNidos(taller, {
        clases, mediosPorClase, bin: binNidos
    });

    clases.forEach((clase, i) => {
        decir(i, clases.length, `Armando ${clase.nombre}…`);
        armadas.push(armarClaseSobreNidos(taller, clase, {
            nidos: {
                ...armados,
                etiquetaDeCamara: nidos.ETIQUETA_DE_CAMARA,
                etiquetaDePantalla: nidos.ETIQUETA_DE_PANTALLA,
                etiquetaDeAudio: nidos.ETIQUETA_DE_AUDIO,
                pistaDelLiveMix: nidos.pistaDelLiveMix
            },
            franja: armados.franjas.get(clase),
            vistas: op.carpeta ? vistasDe(op.carpeta, clase) : [],
            medios: mediosPorClase.get(clase),
            binSecuencias,
            avisos
        }));
    });
    taller.guardarEn(binSecuencias, binNidos);

    let previos = { secuencias: 0, cortes: 0, faltan: 0 };
    if (op.carpeta) {
        decir(clases.length, clases.length, 'Buscando los pasos previos…');
        previos = armarLosPasosPrevios(taller, {
            carpeta: op.carpeta,
            clases,
            binSecuencias,
            binDeMaterial,
            registro,
            avisos
        });
    }

    // Recién ahora se borran los moldes: ya se clonó todo lo que hacía falta.
    // Si algo de lo generado hubiera quedado apuntando a la plantilla, no se
    // rompe en silencio — `verificar` lo encuentra y `guardar` no escribe.
    const podados = taller.podarLaPlantilla();

    const cortes = armadas.reduce((n, c) => n + c.cortes, 0);
    const marcas = armadas.reduce((n, c) => n + c.marcadores, 0);

    // Lo del recuadro, una vez y con el total. Es una limitación conocida del
    // XML de origen y no algo que haya salido mal hoy, así que dice qué falta y
    // qué no: los cortes están donde tienen que estar, lo que no viaja es el
    // encuadre. Alguien que lea esto tiene que poder decidir si le importa.
    const conEfectos = armadas.filter(c => c.conEfectos);
    if (conEfectos.length) {
        const total = conEfectos.reduce((n, c) => n + c.conEfectos, 0);
        avisos.push(`${total} corte(s) de ${conEfectos.length} clase(s) traían el recuadro`
            + ' puesto en el XML: entran en su lugar y con su duración, pero sin el encuadre.');
    }

    // Y lo mismo con los que no lo pudieron recibir: una vez y con el total. El
    // encuadre se copia de un clip de la plantilla que lo tenga puesto, y la
    // mayoría no tiene ninguno, así que esto se dice seguido y por una razón que
    // no es de este curso. Trece líneas iguales taparían a las que sí lo son.
    const faltantes = armadas.reduce((n, c) => n + (c.sinRecuadro || 0), 0);
    if (faltantes) {
        avisos.push(`${faltantes} corte(s) del recuadro del profesor entraron a cuadro completo:`
            + ' la plantilla no tiene ningún clip con la escala o la posición movidas del que'
            + ' copiar el encuadre. Se arregla achicando uno a mano y pegándole los atributos'
            + ' a los demás; o eligiendo de plantilla un proyecto donde el recuadro ya esté.');
    }

    const cuenta = [];
    if (descolgados) {
        cuenta.push(`Se quitaron ${descolgados} objeto(s) que traía la plantilla`
            + ` (${podados} borrado(s)); el panel quedó solo con lo del curso.`);
    }
    cuenta.push(`${armadas.length} secuencia(s), ${cortes} corte(s), ${marcas} marcador(es)`
        + ` y ${registro.size} archivo(s) de material.`);

    const conSlides = armadas.filter(c => c.conSlides).length;
    cuenta.push(`Las clases cortan sobre «${nidos.NOMBRES.raiz}»: ${armados.cortes} corte(s) reparten`
        + ` el material en ${Object.keys(nidos.NOMBRES).length - 1} anidación(es)`
        + ` de ${Math.round(armados.largoSeg / 60)} minutos, con ${nidos.AIRE_SEG / 60} de aire entre clases.`
        + (conSlides
            ? ` ${conSlides} clase(s) traen slides, así que llevan una pista más.`
            : ' Ninguna clase trae slides, así que ninguna lleva la pista de «SLIDE».'));

    // Los pasos previos son narración y no aviso, incluso los que faltan: una
    // clase vieja sin Backup no pide nada —se arregla reprocesándola, y quien
    // quiera hacerlo va a ir igual a la pestaña Clases—, pero la cuenta tiene
    // que estar para poder comprobar que los que sí están entraron todos.
    if (previos.secuencias) {
        cuenta.push(`En «${BIN_PRE}», ${previos.secuencias} secuencia(s) con ${previos.cortes} corte(s)`
            + ` de los pasos de antes (${PASOS.map(p => p.nombre).join(', ')}).`
            + (previos.faltan ? ` Otros ${previos.faltan} no estaban guardados en «${workspace.BACKUP_DIR}».` : ''));
    } else if (previos.faltan) {
        cuenta.push(`No hay ningún paso previo guardado en «${workspace.BACKUP_DIR}»`
            + ` (faltan ${previos.faltan}), así que el proyecto va sin «${BIN_PRE}».`
            + ' Se guardan al procesar una clase; las de antes de que eso existiera no los tienen.');
    }

    return {
        clases: armadas.length,
        detalle: armadas,
        medios: registro.size,
        cortes,
        marcas,
        previos,
        cuenta
    };
}

module.exports = {
    generar,
    ubicarFuente,
    xmlsDe,
    INTERMEDIOS,
    MAESTRO,
    ORDEN_DE_BINS,
    BIN_SECUENCIAS,
    BIN_MATERIAL,
    BIN_PRE,
    PASOS_PREVIOS,
    PASOS,
    PASO_SIN_ANIDAR
};
