'use strict';
/**
 * ajustes.js — Las preferencias del editor, guardadas fuera del proyecto.
 *
 * Viven en `~/Library/Application Support/Class Cut/ajustes.json`, no junto a
 * un curso: qué proveedor de IA usar es una decisión de la máquina y del
 * editor, no de la clase que se esté cortando. Y no en el localStorage de la
 * ventana, porque las herramientas de línea de comandos (`tools/medir-*.js`)
 * tienen que cortar con EXACTAMENTE el mismo criterio que la app — medir con
 * otro proveedor del que se usa sería medir otro producto.
 *
 * La escritura es atómica (archivo temporal + rename): un cierre a mitad de
 * guardado no puede dejar el JSON por la mitad.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const claves = require('./claves');

/** Los proveedores que existen. El orden es el de la página de Ajustes. */
const PROVEEDORES = ['local', 'cursor', 'anthropic'];

/**
 * Cuántas carpetas de material se recuerdan en el paso "Carpetas".
 *
 * Seis, y el tope se aplica al SANEAR: quien agregue una séptima no tiene que
 * acordarse de recortar, y un archivo escrito a mano con cuarenta tampoco puede
 * llenar la pantalla. La que se cae es la que hace más que no se usa.
 *
 * Seis y no cuarenta porque esa lista vive DEBAJO de la zona de soltar, en una
 * ventana que puede estar en su mínimo de 600 px de alto: pasado ese número la
 * lista se vuelve la protagonista de una pantalla cuyo trabajo es invitar a
 * soltar una carpeta nueva, y hay que buscar entre recientes en vez de leerlas.
 * Y seis alcanza para lo que esto es: los cursos que se están cortando ahora, no
 * un historial. Caerse de la lista no pierde nada —la carpeta sigue en el disco
 * y el botón de siempre la vuelve a traer—, así que el costo de quedarse corto
 * es un viaje al selector y el de pasarse es una pantalla ilegible todos los días.
 */
const RECIENTES = 6;

const DEFAULTS = {
    version: 1,
    /**
     * Dónde caen las notas que se toman en vivo (paso "Grabar").
     *
     * Vive acá y no en la ventana porque hace falta de los dos lados: la ventana
     * la propone y el escáner la usa para encontrar el XML de una clase que no lo
     * tiene adentro. La herramienta en vivo nunca escribe en la carpeta del
     * Rodecaster —esa está en su tarjeta y no aparece en la Mac hasta que la
     * grabación termina—, así que el XML y el material nacen separados y alguien
     * tiene que recordar dónde quedó cada uno.
     *
     * `notasDir` es la carpeta en uso —donde cae la próxima clase— y `notasDirs`
     * todas las que se usaron alguna vez, la activa primero. Una carpeta es un
     * curso: la lista de lo grabado se agrupa por ellas y el escáner las recorre
     * todas buscando el XML de una clase.
     */
    notasDir: null,
    notasDirs: [],
    /**
     * Las últimas carpetas de MATERIAL que se abrieron en el paso "Carpetas", la
     * más reciente primero.
     *
     * No es lo mismo que `notasDirs` y por eso no comparten clave: una carpeta de
     * notas es donde la app ESCRIBE los XML de lo que se graba, y una de material
     * es una raíz que el escáner LEE para encontrar clases —el curso entero, un
     * día, una clase suelta—. Pueden coincidir y suelen no coincidir: el material
     * llega de la tarjeta del Rodecaster y las notas nacen en la Mac. Mezclarlas
     * pondría carpetas de escritura en la lista de lectura y al revés.
     *
     * Sí comparten ARCHIVO, que es lo que importa: se guardan con el mismo
     * `guardar` atómico y se sanean acá, no en un tercer almacén con sus propias
     * reglas de escritura.
     *
     * Son rutas y nada más. Que la carpeta siga existiendo no se anota: un disco
     * externo se enchufa y se desenchufa, así que un "no está" escrito hoy sería
     * mentira mañana. Eso se pregunta al disco cada vez que la pantalla se abre.
     */
    carpetasRecientes: [],
    ia: {
        // 'local' es el que funciona en una Mac recién sacada de la caja, sin
        // cuentas ni claves: el que viene con la app.
        proveedor: 'local',
        // La configuración de cada proveedor se conserva aunque no esté activo:
        // cambiar a Claude y volver no puede hacerte reescribir el modelo que
        // tenías elegido en el otro.
        //
        // Acá NO viven secretos: la clave de Anthropic va al Llavero
        // (`engine/claves.js`). Un JSON en Application Support es texto plano
        // que viaja en cada backup.
        local: { modelo: null },
        cursor: { modelo: 'claude-sonnet-5-thinking-high' },
        anthropic: { modelo: 'claude-sonnet-4-5' }
    }
};

function archivo() {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Class Cut', 'ajustes.json');
}

/** Un objeto con TODAS las claves, venga lo que venga del disco. */
function sanear(crudo) {
    const ia = (crudo && crudo.ia) || {};
    const notasDir = (crudo && typeof crudo.notasDir === 'string' && crudo.notasDir) || null;
    // La activa siempre está en la lista y va primera: es el invariante que hace
    // que "elegir carpeta" sea guardar una sola clave, y que quitar una carpeta
    // de la lista no pueda dejar la activa afuera.
    const recordadas = (crudo && Array.isArray(crudo.notasDirs) ? crudo.notasDirs : [])
        .filter(d => typeof d === 'string' && d && d !== notasDir);
    const recientes = (crudo && Array.isArray(crudo.carpetasRecientes) ? crudo.carpetasRecientes : [])
        .filter(d => typeof d === 'string' && d);
    return {
        version: DEFAULTS.version,
        notasDir,
        notasDirs: (notasDir ? [notasDir] : []).concat([...new Set(recordadas)]),
        // Sin repetidas y hasta el tope, decidido acá y no en quien guarda.
        carpetasRecientes: [...new Set(recientes)].slice(0, RECIENTES),
        ia: {
            proveedor: PROVEEDORES.includes(ia.proveedor) ? ia.proveedor : DEFAULTS.ia.proveedor,
            local: { modelo: (ia.local && ia.local.modelo) || null },
            cursor: { modelo: (ia.cursor && ia.cursor.modelo) || DEFAULTS.ia.cursor.modelo },
            anthropic: { modelo: (ia.anthropic && ia.anthropic.modelo) || DEFAULTS.ia.anthropic.modelo }
        }
    };
}

function leer() {
    let crudo = null;
    try {
        crudo = JSON.parse(fs.readFileSync(archivo(), 'utf8'));
    } catch (err) {
        // Sin archivo o con un archivo roto, la app arranca con lo de fábrica:
        // unos ajustes ilegibles no pueden dejar sin cortar.
    }

    // Migración: las primeras versiones guardaban la clave en este JSON. Se
    // muda al Llavero y el archivo se reescribe sin ella — la próxima lectura
    // ya no pasa por acá.
    const vieja = crudo && crudo.ia && crudo.ia.anthropic && crudo.ia.anthropic.apiKey;
    if (vieja) {
        try {
            claves.guardar('anthropic', vieja);
            guardar(crudo);
        } catch (err) {
            // Si el Llavero no dejó, la clave sigue en el archivo y se vuelve a
            // intentar en la próxima lectura: perderla sería peor que tardar.
        }
    }

    return sanear(crudo);
}

function guardar(datos) {
    const limpio = sanear(datos);
    const destino = archivo();
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const temporal = `${destino}.tmp-${process.pid}`;
    fs.writeFileSync(temporal, `${JSON.stringify(limpio, null, 2)}\n`);
    fs.renameSync(temporal, destino);
    return limpio;
}

/**
 * Dónde buscar los XML de notas que no están junto a su clase, como lo espera
 * el escáner (`course-scan.scan(root, { notasDirs })`): todas las carpetas que
 * se usaron, la activa primero, que es la que gana si dos cursos tienen una
 * clase con el mismo número.
 *
 * Vive acá y no adentro del escáner para que ese siga siendo una función del
 * disco: la app y las herramientas que quieran ver lo mismo que la app se lo
 * pasan, y una prueba que no lo pasa no ve los XML de la máquina en que corre.
 */
function carpetasDeNotas() {
    return leer().notasDirs;
}

/**
 * Anota que se abrió una carpeta de material, primera de la lista.
 *
 * Volver a abrir una que ya estaba NO la duplica: la sube. La lista se ordena
 * por lo último que se usó y no por lo primero que se agregó, que es lo que hace
 * que el curso de esta semana esté siempre arriba y que el tope eche al que hace
 * más que nadie toca — con el orden de agregado, el primer curso que se cargó se
 * quedaría para siempre y el de ayer se caería primero.
 *
 * Se relee de disco en vez de recibir la lista: entre que la ventana leyó y
 * escribe pudo guardar otra pantalla, y `guardar` sanea, así que el recorte al
 * tope pasa una sola vez y en un solo sitio.
 */
function recordarCarpeta(ruta) {
    if (typeof ruta !== 'string' || !ruta) return leer();
    const antes = leer();
    return guardar({
        ...antes,
        carpetasRecientes: [ruta].concat(antes.carpetasRecientes.filter(d => d !== ruta))
    });
}

module.exports = {
    leer, guardar, carpetasDeNotas, recordarCarpeta,
    sanear, archivo, PROVEEDORES, DEFAULTS, RECIENTES
};
