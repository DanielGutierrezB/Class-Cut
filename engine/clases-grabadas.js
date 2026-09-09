'use strict';
/**
 * clases-grabadas.js — Las clases que ya están en el disco.
 *
 * Del otro lado de la pared está la grabación en curso, que vive en memoria y se
 * mueve sola. Acá no hay sesión ni relojes: hay una carpeta con archivos, y todo
 * lo que se puede hacer con ellos sin estar grabando —listarlos, editarlos,
 * volver a oírlos, renombrarlos y borrarlos—.
 *
 * Es la frontera más limpia que tenía `grabacion.js` adentro y por eso salió
 * entera: ninguna de estas funciones mira el estado de la sesión. La única que
 * necesitaba saber algo de ella —`listar`, que esconde la clase que se está
 * grabando para que la pantalla no la vea dos veces— lo recibe como un nombre y
 * nada más.
 *
 * **Todo lo que escribe o borra se queda adentro de la carpeta de notas.** El
 * nombre del curso lo elige el editor y puede traer barras o `..`; las rutas se
 * arman con `workspace` y se comprueban antes de tocar nada (`adentro`). Un
 * renombrado no puede escribir fuera de `xml/`, y un borrado no puede sacar de
 * ahí un archivo que no puso esta app.
 */

const fs = require('fs');
const path = require('path');

const notasXml = require('./notas-xml');
const nombreDeClase = require('./nombre-de-clase');
const workspace = require('./workspace');
const oirToma = require('./oir-toma');
const lengua = require('./lengua');
const empalme = require('./empalme');
const vivo = require('./notas-vivo');
const gpu = require('./gpu');

/**
 * Cómo termina el archivo con la hora del día. Vive en `workspace.js` junto con
 * el resto de la forma de la carpeta de notas: acá se usa para reconocer una
 * clase en el disco, y allá para saber en qué piso dejarla.
 */
const { SUFIJO_SIDECAR } = workspace;

/**
 * Las clases ya grabadas en las carpetas de notas, de la más nueva a la más vieja.
 *
 * Se leen del disco y no de la memoria: la lista SON las carpetas. Así la clase
 * de ayer aparece igual que la de hace un minuto, y cerrar la app no borra nada
 * de lo que se veía. Lo que hay es lo que quedó escrito —el archivo con la hora
 * del día que se escribe en cada cambio (`notas-xml.sidecar`)—, así que una
 * clase que se cortó por un cierre brusco aparece igual, con lo que había hasta
 * ahí. Cada clase dice de qué carpeta salió (`carpeta`), que es su curso.
 *
 * La que se está grabando ahora no va: la pantalla la dibuja aparte, con lo que
 * llega por los avisos, y sería verla dos veces.
 *
 * **Es el momento en que la carpeta toma forma.** Antes las clases caían sueltas
 * en la raíz y ahora bajan un piso (`workspace.migrarNotas`), y esta es la única
 * puerta por la que se pasa siempre antes de ver una clase: abrir la pantalla de
 * Grabar lista, y arrancar una grabación también (`parteQueSigue`). Mudar acá es
 * lo que hace que el editor no tenga que enterarse.
 *
 * Igual se sigue mirando la raíz. La mudanza puede no haber podido con algo —un
 * disco de solo lectura, un archivo abierto por otro programa—, y una clase que
 * no se pudo mover tiene que seguir apareciendo: que se "borren" trece clases es
 * lo peor que puede pasar acá, y cuesta un `readdir` evitarlo.
 *
 * @param {string[]} dirs las carpetas de notas (`ajustes.carpetasDeNotas`)
 * @param {string} [enCurso] la secuencia que se está grabando, para dejarla fuera
 */
function listar(dirs, enCurso) {
    const clases = [];
    for (const dir of dirs || []) {
        workspace.migrarNotas(dir);
        // Por secuencia y no por ruta: si la misma clase quedó en los dos pisos
        // —la mudanza no pisa nada, así que un choque de nombres deja las dos—,
        // se muestra una sola vez y gana la de adentro, que es la que se
        // reescribe al editarla.
        const vistas = new Set();
        for (const donde of workspace.notasConDatos(dir)) {
            for (const clase of sidecaresDe(donde, dir)) {
                if (clase.secuencia === enCurso || vistas.has(clase.secuencia)) continue;
                vistas.add(clase.secuencia);
                clases.push(clase);
            }
        }
    }
    return clases.sort((a, b) => (b.ceroMs || 0) - (a.ceroMs || 0));
}

/**
 * Las clases que hay en una carpeta concreta.
 *
 * `base` es la carpeta de notas que el editor eligió y `donde` el piso en el que
 * se está mirando: la clase dice de cuál salió con la primera, que es su curso y
 * lo que agrupa la lista en pantalla (`src/js/grabar/grabadas.js`).
 */
function sidecaresDe(donde, base) {
    let nombres = [];
    try {
        nombres = fs.readdirSync(donde);
    } catch (e) {
        return []; // una carpeta que no está no tiene clases
    }

    const clases = [];
    for (const nombre of nombres) {
        if (!nombre.endsWith(SUFIJO_SIDECAR)) continue;
        const json = path.join(donde, nombre);
        try {
            const leida = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
            if (!leida || !leida.secuencia) continue;
            const suyos = workspace.notasDeClase(json);
            clases.push({
                ...leida,
                carpeta: base,
                // El empalme de cada toma se rehace al leer, por lo mismo que el
                // agregado de abajo: lo que el archivo guarda es la respuesta del
                // modelo y el descarte del editor, y la sugerencia depende de
                // dónde están los bordes ahora — que se pueden mover sobre una
                // clase ya terminada (`editarGrabada`).
                tomas: (leida.tomas || []).map(t =>
                    ({ ...t, empalme: empalme.paraLaPantalla(t, leida.tomas) })),
                // El agregado se rehace al leer y no sale del archivo: lo que el
                // archivo guarda es la medida de cada toma, y qué tomas cuentan
                // depende de cuáles quedaron descartadas — que se puede cambiar
                // sobre una clase ya terminada (`editarGrabada`).
                lengua: lengua.agregado(leida.tomas),
                archivos: { xml: suyos.xml, json: suyos.json }
            });
        } catch (e) {
            // Un JSON a medio escribir o de otra cosa: no es una clase.
        }
    }
    return clases;
}

/**
 * Qué parte de esa clase es la que va a arrancar ahora.
 *
 * Una clase se puede grabar en dos tandas —se para a mitad y se retoma un rato
 * después—, y cada tanda es su propia grabación: su audio, su XML y su carpeta
 * del Rodecaster. La primera vez que se usa un número es la parte 1; volver a
 * usarlo abre la 2, la 3, y así.
 *
 * **Se cuenta contra el disco y no contra lo que la pantalla tenga en la mano.**
 * La pantalla lo adivina para poder mostrarlo mientras se escribe, pero su lista
 * puede estar vieja —se grabó desde otra ventana, alguien copió un XML— y dos
 * grabaciones con el mismo nombre se pisarían el archivo.
 */
function parteQueSigue(dir, clase, enCurso) {
    return listar([dir], enCurso).filter(c => c.clase === clase).length + 1;
}

/** Las clases que se están regenerando ahora, por su archivo con la hora del día. */
const regenerando = new Set();

/**
 * Vuelve a leer todas las tomas de una clase ya grabada con el modelo grande, y
 * reescribe su XML y su archivo con la hora del día.
 *
 * Para qué: una clase puede haber quedado con texto del ciclo de señales —el
 * descartable— si la app se cerró de golpe, o haberse grabado sin el modelo
 * grande a mano. El audio está guardado (`xml/Audio/` en la carpeta de notas, o
 * la carpeta plana de antes: ver `dondeQuedoElWav`), así que se puede volver a
 * leer entero. No se toca nada más: ni los bordes, ni las vistas,
 * ni las notas del director, ni qué se descartó.
 *
 * Y hace una segunda cosa, que es la que importa cuando un borde se quedó sin
 * lugar: relee cada toma con orillas nuevas alrededor de los bordes de AHORA
 * (`oirToma.leer`). Así, después de correr un OUT hasta el final de lo que había
 * guardado, esto le devuelve otros doce segundos de texto por delante y el
 * borde puede seguir. Es el único camino que hay para ir más lejos que lo
 * guardado, porque es el único que vuelve a oír.
 *
 * No corre mientras la GPU esté ocupada: el Whisper de las señales ya está
 * andando cada tres segundos, y otro modelo grande peleándosela pone en riesgo
 * la clase que se está grabando por mejorar una que ya está. Es el mismo
 * criterio con el que el panel se abstiene del modelo local y se pregunta en el
 * mismo sitio —`engine/gpu.js`—, pero acá se pregunta si la tiene CUALQUIERA y
 * no solo el Whisper, y no depende del proveedor: lo que esto levanta es Whisper
 * y Whisper es local siempre, así que también hay que dejar tranquila la
 * medición del cierre, que recién ahí llegó a hacerse.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {function} [avisar] recibe `{tipo:'regenerando', json, hechas, total}`
 */
async function regenerar(json, avisar) {
    if (gpu.ocupada()) throw new Error('Terminá la grabación en curso antes de regenerar una clase.');
    if (regenerando.has(json)) throw new Error('Esa clase ya se está regenerando.');
    regenerando.add(json);
    try {
        const estado = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
        const clase = workspace.notasDeClase(json);
        // El WAV se guardó con la ruta de entonces. Si la carpeta se movió —o si
        // la mudó la app al darle forma—, sigue en alguna de las carpetas de
        // audio de esta carpeta de notas.
        const archivos = (estado.sesiones || []).map(s => ({
            ...s,
            archivo: dondeQuedoElWav(clase, s.archivo)
        }));
        const tomas = (estado.tomas || []).filter(t => t.inMs != null && t.outMs != null);
        const aviso = typeof avisar === 'function' ? avisar : () => {};

        let sinAudio = 0;
        let degradadas = 0;
        let sinLeer = 0;
        for (const [i, toma] of tomas.entries()) {
            const leido = await oirToma.leer(archivos, toma);
            // **Y acá es donde la marca se limpia sola.** `leer` devuelve
            // `relectura: null` cuando la toma salió con el modelo bueno, así que
            // el `Object.assign` borra la marca que le había quedado de la clase
            // en vivo. Es justo para lo que existe este botón: la toma que quedó
            // leída con un modelo peor —porque el sistema se llevaba a whisper-cli
            // mientras se grababa— es exactamente la que esto arregla, y acá la
            // GPU está libre, que es la razón por la que ahora sí puede salir.
            if (leido) Object.assign(toma, leido);
            else sinAudio++;
            if (leido && leido.relectura) {
                if (leido.relectura.estado === 'degradada') degradadas++;
                else sinLeer++;
            }
            aviso({ tipo: 'regenerando', json, hechas: i + 1, total: tomas.length });
        }

        workspace.writeAtomic(clase.xml, notasXml.xmlDeNotas(estado));
        workspace.writeJson(clase.json, notasXml.sidecar(estado));
        // `degradadas` y `sinLeer` se cuentan para poder decirlo al terminar: una
        // regeneración que no logró leer tres tomas y contesta "8 tomas releídas"
        // es la misma pérdida silenciosa que esto vino a arreglar.
        return {
            tomas: tomas.length, sinAudio, degradadas, sinLeer,
            archivos: { xml: clase.xml, json: clase.json }
        };
    } finally {
        regenerando.delete(json);
    }
}

/**
 * Dónde está hoy un WAV que el sidecar anotó con la ruta de entonces.
 *
 * La ruta guardada manda si el archivo sigue ahí; si no, se lo busca por su
 * nombre en las carpetas de audio de esta carpeta de notas. Sin esto, darle
 * forma a la carpeta dejaría a "Regenerar" sin audio en todas las clases
 * viejas, y eso no se ve hasta que alguien la aprieta.
 */
function dondeQuedoElWav(clase, guardado) {
    if (guardado && fs.existsSync(guardado)) return guardado;
    const nombre = path.basename(guardado || '');
    const donde = clase.audios.find(dir => fs.existsSync(path.join(dir, nombre)));
    return path.join(donde || clase.audios[0], nombre);
}

/**
 * Cambia una clase que ya terminó, y reescribe su XML.
 *
 * Antes una clase generada se leía y nada más, y eso dejaba fuera el momento en
 * que uno de verdad tiene algo que decir: viendo el guion entero, con la clase ya
 * cerrada. El único camino era rehacer la clase.
 *
 * **El XML se reescribe acá mismo, en el mismo gesto.** Un cambio que se queda en
 * la pantalla no llega a Premiere, y tener un botón aparte de "guardar"
 * garantiza que alguna vez se haga lo primero sin lo segundo.
 *
 * **Qué se puede y qué no lo decide `vivo.aplicar`, y el criterio es si alcanza
 * con lo que ya está escrito.** Comentar, cambiar la vista, escribir la nota del
 * director y descartar una toma son escribir un campo. Mover un borde también
 * entra, que es lo que menos parece: las orillas de cada toma están guardadas en
 * el mismo archivo, así que correr el IN o el OUT dentro de ese rango es repartir
 * de nuevo las palabras que ya están (ver `moverBordeGuardado` allá). El texto no
 * se rehace y no hace falta el audio.
 *
 * Sí corre con una grabación en curso: no toca el audio ni pelea por Whisper,
 * escribe dos archivos de otra clase. Eso sigue siendo cierto con los bordes
 * adentro, y es justamente lo que se protege dejando fuera el borde que se pasa
 * de lo guardado: ese sí pediría Whisper, y para eso está `regenerar`.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {object} cambio uno de los de `editar` que no necesite el audio
 */
function editarGrabada(json, cambio) {
    const c = cambio || {};
    const estado = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
    const toma = (estado.tomas || []).find(t => t.id === c.toma);
    if (!toma) throw new Error(`Esa clase no tiene la toma ${c.toma}.`);
    vivo.aplicar(toma, c);

    // Se reescribe donde está, no donde iría hoy: una clase que quedó en la raíz
    // y no se pudo mudar se sigue editando ahí. Mudarla de contrabando en un
    // gesto que el editor pidió para cambiar una vista sería mover sus archivos
    // sin que nadie lo haya pedido.
    const clase = workspace.notasDeClase(json);
    workspace.writeAtomic(clase.xml, notasXml.xmlDeNotas(estado));
    workspace.writeJson(clase.json, notasXml.sidecar(estado));
    return { archivos: { xml: clase.xml, json: clase.json } };
}

/* ─── Gestionar la carpeta: renombrar y borrar ────────────────────────────
 *
 * Una carpeta de notas junta las trece clases de un curso y se llena a lo largo
 * de varios días de rodaje. Hasta acá la app sabía crear clases y no sabía
 * arreglarlas: una que se grabó con el número equivocado —el rodaje se dio vuelta
 * y la 7 salió antes que la 6— o con el curso mal escrito se quedaba así, y la
 * única salida era entrar a la carpeta y mover archivos a mano, que es
 * exactamente donde el sidecar y el XML se separan.
 *
 * Las dos operaciones de acá tocan tres archivos —el XML, el sidecar y el WAV— y
 * la gracia está en el orden, porque tres archivos no se pueden escribir de una.
 * El criterio es el mismo que el de la mudanza de `workspace.migrarNotas`: **el
 * sidecar es lo que hace visible a una clase** (`sidecaresDe` busca su sufijo y
 * nada más), así que se lo deja para el final. Una operación cortada por la
 * mitad deja la clase en la lista, entera o repetida, y nunca desaparecida.
 */

/** Lee el sidecar de una clase, o dice que ese archivo no es una clase. */
function leerSidecar(json) {
    if (!String(json || '').endsWith(SUFIJO_SIDECAR)) {
        throw new Error('Eso no es el archivo de una clase.');
    }
    try {
        return notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8'))) || {};
    } catch (e) {
        throw new Error('No pude leer esa clase: su archivo de datos está roto.');
    }
}

/** Borra un archivo que puede no estar. @returns {boolean} si había algo que borrar */
function quitar(ruta) {
    try {
        fs.unlinkSync(ruta);
        return true;
    } catch (e) {
        return false; // ya no estaba, o nunca estuvo
    }
}

/**
 * Los WAV de una clase que están hoy en el disco.
 *
 * Se resuelven con `dondeQuedoElWav` y se filtran por existencia, que no es lo
 * mismo: esa función siempre devuelve una ruta —la mejor que se le ocurre— y
 * acá hacen falta las de verdad. Un audio que ya no está no puede borrarse ni
 * renombrarse, y las dos operaciones tienen que terminar igual.
 */
function audiosDe(sitio, estado) {
    const vistos = new Set();
    const salida = [];
    for (const s of estado.sesiones || []) {
        if (!s.archivo) continue;
        const donde = dondeQuedoElWav(sitio, s.archivo);
        if (vistos.has(donde) || !fs.existsSync(donde)) continue;
        vistos.add(donde);
        salida.push({ sesion: s, archivo: donde });
    }
    return salida;
}

/**
 * La hora de captura de una clase, que es lo único que un renombrado no toca.
 *
 * Es la hora de "Iniciar grabación", y con ella post encuentra a qué carpeta del
 * Rodecaster corresponde esta clase: el Rodecaster escribe su propia hora local
 * en el nombre de su carpeta y el emparejamiento compara las dos
 * (`nombre-de-clase.js`). Cambiarla no renombraría una clase: la desemparejaría.
 *
 * Sale del sidecar antes que del nombre. Las dos dicen lo mismo —`iniciar` arma
 * el nombre con el mismo `ceroMs` que guarda— pero el sidecar lo tiene al
 * milisegundo y en un solo campo, mientras que el nombre hay que volver a
 * parsearlo. Y hay clases con nombre viejo, de antes de que la hora entrara en
 * él: esas solo se pueden renombrar gracias al sidecar, y de paso salen con el
 * nombre de ahora.
 */
function horaDeCaptura(estado, nombre) {
    if (estado.ceroMs) return Number(estado.ceroMs);
    const leido = nombreDeClase.leer(nombre);
    if (leido && leido.cuandoMs != null) return leido.cuandoMs;
    throw new Error('Esa clase no dice a qué hora se grabó. Renombrarla le inventaría ' +
        'una hora nueva y la dejaría sin poder emparejarse con la carpeta del Rodecaster.');
}

/**
 * Hasta 999 porque el número se relee con `^(\d{1,3})` en las dos puntas de la
 * app (`nombre-de-clase.js`, `rodecaster-xml.classNumberFromSequenceName`): un
 * cuarto dígito daría un nombre que la app no sabe volver a leer.
 */
function numeroDeClase(valor) {
    const n = Math.round(Number(valor));
    if (!Number.isFinite(n) || n < 1 || n > 999) {
        throw new Error('El número de clase tiene que estar entre 1 y 999.');
    }
    return n;
}

/**
 * Cómo se llamaría este WAV con la clase renombrada.
 *
 * El audio se llama `<secuencia>-<n>.wav` (`captura.abrir`), así que renombrarlo
 * es cambiarle el prefijo y dejarle el resto: el `-1` de la cola distingue las
 * dos capturas de una clase que se pausó, y no es nuestro para tocarlo.
 *
 * @returns {string|null} null si el archivo no lleva nuestro nombre, y entonces
 *   no lo pusimos nosotros y no se toca.
 */
function wavRenombrado(ruta, viejo, nuevo) {
    const base = path.basename(ruta);
    const prefijo = workspace.safeName(viejo);
    if (!base.startsWith(prefijo)) return null;
    return path.join(path.dirname(ruta), workspace.safeName(nuevo) + base.slice(prefijo.length));
}

/**
 * Renombra una clase: el número y el curso, nunca la hora.
 *
 * **Reusar un número la convierte en la parte siguiente, igual que grabar.** Es
 * la decisión de fondo de acá y sale de ser coherente con el único camino que ya
 * existía: arrancar una grabación con un número usado abre la parte 2
 * (`parteQueSigue`), porque una clase se puede grabar en dos tandas. Rechazar el
 * renombrado sería tener dos reglas para lo mismo, y encima la peor de las dos
 * para el caso que se quiere resolver — el editor renombra JUSTAMENTE cuando
 * quiere juntar esta clase con otra que ya está. Renombrar al número que la
 * clase ya tiene le deja su parte como estaba: cambiar solo el curso no puede
 * convertir una parte 1 en parte 2.
 *
 * **La que se está grabando no se renombra.** El motor tiene su nombre en
 * memoria y le escribe el XML en cada cambio: renombrarle los archivos por
 * debajo haría que la escritura siguiente los volviera a crear con el nombre
 * viejo, y la clase quedaría partida en dos.
 *
 * **El orden es el que aguanta un corte.** Primero el audio, después el par
 * nuevo, y recién al final se borra el par viejo. En ningún momento hay un
 * sidecar apuntando a un XML que ya no se llama así: mientras el nuevo no está
 * escrito, el viejo sigue completo; cuando el nuevo ya está, el viejo se va. Lo
 * peor que puede dejar un corte de luz es la clase repetida en la lista, que se
 * arregla mirando; y lo que falle en el medio se deshace acá mismo.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {object} cambio { clase, curso } — lo que no venga se deja como está
 * @param {string} [enCurso] la secuencia que se está grabando ahora
 */
function renombrar(json, cambio, enCurso) {
    const c = cambio || {};
    const sitio = workspace.notasDeClase(json);
    const estado = leerSidecar(json);

    if (estado.secuencia && estado.secuencia === enCurso) {
        throw new Error('Esa clase se está grabando ahora. Terminá la grabación para renombrarla.');
    }
    if (c.curso != null && !String(c.curso).trim()) {
        throw new Error('El nombre del curso no puede quedar vacío.');
    }

    const cuandoMs = horaDeCaptura(estado, sitio.nombre);
    const numero = numeroDeClase(c.clase != null ? c.clase : estado.clase);
    const curso = c.curso != null
        ? String(c.curso)
        : (estado.curso || (nombreDeClase.leer(sitio.nombre) || {}).curso || '');
    const parte = numero === Number(estado.clase)
        ? (Number(estado.parte) || 1)
        : parteQueSigue(sitio.base, numero, enCurso);

    const nombre = nombreDeClase.armar({ clase: numero, parte, curso, cuandoMs });
    const archivos = { xml: sitio.xml, json: sitio.json };
    // El mismo nombre no es un error: se llega acá corrigiendo una tilde que el
    // nombre de archivo ya no distinguía. Se contesta que no se movió nada, en
    // vez de escribir dos archivos encima de sí mismos.
    if (nombre === sitio.nombre) return { secuencia: nombre, archivos, movida: false, audios: 0 };

    const destino = workspace.notasArchivos(sitio.base, workspace.safeName(nombre));
    for (const ruta of [destino.xml, destino.json]) {
        if (!workspace.dentroDe(sitio.base, ruta)) {
            throw new Error('Ese nombre se sale de la carpeta de notas.');
        }
        if (fs.existsSync(ruta)) {
            throw new Error(`Ya hay una clase llamada «${nombre}» en esa carpeta.`);
        }
    }

    const movidos = [];
    try {
        for (const wav of audiosDe(sitio, estado)) {
            const nuevo = wavRenombrado(wav.archivo, sitio.nombre, nombre);
            if (!nuevo || fs.existsSync(nuevo)) continue;
            if (!workspace.dentroDe(sitio.base, nuevo)) {
                throw new Error('Ese nombre se sale de la carpeta de notas.');
            }
            fs.renameSync(wav.archivo, nuevo);
            movidos.push([wav.archivo, nuevo]);
            // El sidecar que se va a escribir tiene que decir dónde está el audio
            // AHORA: es de donde sale "Regenerar" meses después.
            wav.sesion.archivo = nuevo;
        }

        estado.secuencia = nombre;
        estado.clase = numero;
        estado.parte = parte;
        estado.curso = curso;

        workspace.writeAtomic(destino.xml, notasXml.xmlDeNotas(estado));
        workspace.writeJson(destino.json, notasXml.sidecar(estado));
    } catch (err) {
        // Lo que se llegó a hacer se deshace, y la clase queda exactamente como
        // estaba. Es lo que convierte tres escrituras sueltas en una operación:
        // sin esto, un disco lleno a mitad de camino dejaba el audio con el
        // nombre nuevo y el sidecar con el viejo, o sea la clase sin audio.
        for (const [de, a] of movidos.reverse()) {
            try { fs.renameSync(a, de); } catch (e) { /* se hizo lo que se pudo */ }
        }
        quitar(destino.xml);
        quitar(destino.json);
        throw err;
    }

    // Y recién con el par nuevo entero en el disco se va el viejo. El sidecar
    // primero: es el que hace visible a la clase, así que la repetida dura lo que
    // tarda un `unlink`, y el XML que queda suelto no lo lista nadie.
    quitar(sitio.json);
    quitar(sitio.xml);

    return { secuencia: nombre, archivos: destino, movida: true, audios: movidos.length };
}

/**
 * Borra una clase: el XML, el sidecar y el audio.
 *
 * **Borra de verdad y no manda a la papelera.** El audio de una clase son cientos
 * de megas y lo que el editor quiere al apretar esto es que dejen de estar. La
 * confirmación es de la pantalla, no de acá: este es el gesto ya decidido.
 *
 * **Lo que falte no es un error.** Se llega a borrar una clase justamente cuando
 * quedó mal —un cierre brusco sin XML, un audio que alguien ya movió a mano— y
 * plantarse en el primer archivo ausente dejaría los otros dos ahí, sin forma de
 * sacarlos desde la app. Se borra lo que haya y se cuenta qué se fue.
 *
 * **El sidecar, último.** Por lo mismo de siempre: es lo que hace visible a la
 * clase. Si esto se corta a la mitad, la clase sigue en la lista con la mitad de
 * sus archivos y volver a apretar termina el trabajo — cosa que solo es cierta
 * porque lo que falta no es un error. Al revés, un corte dejaría un WAV de
 * cientos de megas que ya no aparece en ninguna pantalla.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {string} [enCurso] la secuencia que se está grabando ahora
 */
function borrar(json, enCurso) {
    const sitio = workspace.notasDeClase(json);
    const estado = leerSidecar(json);

    if (estado.secuencia && estado.secuencia === enCurso) {
        throw new Error('Esa clase se está grabando ahora. Terminá la grabación para borrarla.');
    }

    let audios = 0;
    for (const wav of audiosDe(sitio, estado)) {
        // Un sidecar puede traer la ruta que tenía el WAV en otra máquina o en
        // otra carpeta. Se borra lo que esté adentro de esta carpeta de notas y
        // nada más: acá se está borrando de verdad.
        if (!workspace.dentroDe(sitio.base, wav.archivo)) continue;
        if (quitar(wav.archivo)) audios++;
    }

    const xml = quitar(sitio.xml);
    const sidecar = quitar(sitio.json);
    return { secuencia: estado.secuencia || sitio.nombre, xml, sidecar, audios };
}

module.exports = {
    SUFIJO_SIDECAR,
    listar,
    sidecaresDe,
    parteQueSigue,
    regenerar,
    dondeQuedoElWav,
    editarGrabada,
    renombrar,
    borrar
};
