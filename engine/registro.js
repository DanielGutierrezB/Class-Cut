'use strict';
/**
 * registro.js — El diario de la app, para poder contar qué pasó.
 *
 * Existe por una razón concreta: cuando algo sale mal, lo único que llega es
 * "no me anduvo". Los `console.log` del proceso principal no se ven desde la
 * app —salvo que se la abra desde la terminal, que nadie hace— y los de la
 * ventana viven en un inspector que hay que saber abrir. Con esto, reportar un
 * problema es apretar un botón y adjuntar un archivo.
 *
 * Cuatro decisiones que valen el comentario:
 *
 * **Sobrevive al cierre.** Antes vivía solo en memoria, y eso lo dejaba inútil
 * justo en el caso que más importa: si la app se cae, el diario de lo que la
 * hizo caer se cae con ella. Quien la vuelve a abrir para pedir ayuda encuentra
 * un archivo que empieza en el arranque de después del problema. Ahora cada
 * línea se vuelca a un archivo en la carpeta de la app, y la descarga junta
 * todas las corridas y no solo la de ahora.
 *
 * **Tiene dos topes, y son distintos.** En memoria se guardan `TOPE` líneas
 * porque un array que solo crece dentro del proceso que además tiene el modelo
 * cargado es una fuga con buenos modales. En disco caben muchas más
 * (`TOPE_EN_DISCO`) porque ahí no molestan y porque un problema que aparece cada
 * tanto se diagnostica comparando la corrida de hoy con la de ayer. Las dos
 * cuentas dicen cuánto tiraron: un archivo que miente por omisión es peor que no
 * tenerlo.
 *
 * **No lleva secretos.** La clave de Anthropic vive en el Llavero y no puede
 * terminar en un archivo que el editor va a mandar por mail. `sanear` tapa todo
 * campo que se llame como un secreto y todo texto con forma de clave, y lo hace
 * al ANOTAR y no al escribir: si estuviera solo al escribir, el secreto habría
 * vivido en memoria y en disco hasta entonces, y cualquier volcado lo tendría.
 *
 * **No lleva rutas enteras.** El nombre de usuario y el árbol completo de un
 * disco ajeno no ayudan a entender nada; los dos últimos tramos sí dicen de qué
 * clase se habla. Un log que se puede compartir sin pensarlo se comparte; uno
 * que hay que revisar antes, no.
 *
 * No sabe de Electron a propósito: la ventana anota por IPC, y las dos carpetas
 * —la de la app y la de Descargas— se las pasa quien llama. Así se puede probar
 * entero con `node tests/run.js`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cuántas líneas se guardan en memoria. Medido: una corrida de 13 clases con el
// criterio encendido anota del orden de 400 líneas, así que 3000 son varias
// corridas enteras y ocupan menos de un mega.
const TOPE = 3000;

// Y cuántas en disco, que es donde vive la historia. Más alto porque ahí no
// compite con el modelo por la memoria, y porque el diagnóstico de un problema
// que aparece cada tanto sale de comparar la corrida de hoy con la de ayer.
// Treinta mil líneas son del orden de diez megas: una carpeta de aplicación con
// diez megas de diario no le molesta a nadie, y perder la corrida de ayer sí.
const TOPE_EN_DISCO = 30000;

// Cada cuánto se vuelca lo pendiente. Escribir en cada `anotar` serían miles de
// escrituras por corrida para nada; juntarlas un segundo no pierde nada, porque
// lo que de verdad no se puede perder —los errores— se vuelca en el acto.
const CADA_CUANTO_MS = 1000;

// Un evento que huele a problema se vuelca sin esperar al temporizador. Es
// justamente el caso en el que puede no haber una próxima vuelta del bucle: si
// el proceso se está cayendo, el segundo que faltaba para el volcado no llega.
const HUELE_A_PROBLEMA = /(error|falla|no-arranca|no-se-pudo|se-cayo|se-cae|cancelada)/i;

// Campos cuyo contenido no se escribe nunca, se llamen como se llamen adentro.
const SECRETOS = /(clave|key|token|secret|password|contrase|authorization|bearer)/i;

// Texto con forma de credencial, por si viaja dentro de un mensaje de error en
// vez de en un campo con nombre.
const PARECE_CLAVE = /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

const OCULTO = '‹oculto›';

// Un valor de texto largo no aporta más que sus primeros caracteres, y sí
// engorda el archivo: un transcript entero en una línea de log no se lee.
const MAX_TEXTO = 240;

const lineas = [];
let descartadas = 0;
let empezoEn = Date.now();

// El diario en disco. `null` hasta que alguien diga dónde: las pruebas y los
// scripts anotan sin archivo y no pasa nada, se comportan como antes.
let archivoDiario = null;
let pendientes = [];
let temporizador = null;
let fallaAlVolcar = null;

/** Los dos últimos tramos de una ruta: `…/Clase 03/Live-Mix.wav`. */
function acortarRuta(texto) {
    const partes = String(texto).split(path.sep).filter(Boolean);
    if (partes.length <= 2) return texto;
    return `…/${partes.slice(-2).join('/')}`;
}

function pareceRuta(texto) {
    return texto.startsWith('/') || texto.startsWith('~/') || texto.includes(`${path.sep}`);
}

function sanearTexto(texto) {
    let limpio = String(texto).replace(PARECE_CLAVE, OCULTO);
    // La carpeta del usuario aparece en cada ruta y en cada mensaje de error del
    // sistema; sacarla es lo que hace que el archivo se pueda mandar sin leerlo.
    const casa = os.homedir();
    if (casa && casa.length > 3) limpio = limpio.split(casa).join('~');
    if (pareceRuta(limpio) && !limpio.includes(' ')) limpio = acortarRuta(limpio);
    return limpio.length > MAX_TEXTO ? `${limpio.slice(0, MAX_TEXTO)}…` : limpio;
}

/**
 * Los datos de una línea, sin nada que no se pueda compartir.
 *
 * Va en profundidad pero con freno: un objeto que se anida más de tres niveles
 * es un artefacto entero, y eso no es una línea de log.
 */
function sanear(valor, nivel) {
    const profundidad = nivel || 0;
    if (valor == null) return null;
    if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
    if (typeof valor === 'string') return sanearTexto(valor);
    if (profundidad >= 3) return '…';

    if (Array.isArray(valor)) {
        // Diez alcanzan para ver de qué se habla; una lista de trece clases
        // entera por línea no.
        const corta = valor.slice(0, 10).map(v => sanear(v, profundidad + 1));
        return valor.length > 10 ? [...corta, `… y ${valor.length - 10} más`] : corta;
    }
    if (typeof valor !== 'object') return String(valor);

    const salida = {};
    for (const [clave, v] of Object.entries(valor)) {
        salida[clave] = SECRETOS.test(clave) ? OCULTO : sanear(v, profundidad + 1);
    }
    return salida;
}

/**
 * Anota algo que pasó.
 *
 * @param {string} origen 'main' o 'ventana': de qué lado se hizo
 * @param {string} evento qué pasó, en dos palabras ('carpeta.agregada')
 * @param {object} [datos] lo que haga falta para entenderlo
 * @returns {object} la línea, ya saneada
 */
function anotar(origen, evento, datos) {
    const linea = {
        ts: Date.now(),
        origen: String(origen || '?'),
        evento: String(evento || '?'),
        datos: datos == null ? null : sanear(datos, 0)
    };
    lineas.push(linea);
    // Se recorta de a una y no de golpe: así el tope es un techo de verdad y no
    // "el techo más lo que se acumule hasta la próxima limpieza".
    while (lineas.length > TOPE) {
        lineas.shift();
        descartadas++;
    }

    if (archivoDiario) {
        pendientes.push(linea);
        if (HUELE_A_PROBLEMA.test(linea.evento)) volcar();
        else programarVolcado();
    }
    return linea;
}

// ─── El diario en disco ──────────────────────────────────────────────

/**
 * Empezar a guardar en disco, y quedarse con la historia que ya hubiera.
 *
 * Se llama una vez al arrancar, con la carpeta de la aplicación. Lo de recortar
 * al abrir y no al escribir es a propósito: recortar es leer el archivo entero y
 * volver a escribirlo, y hacer eso cada vez que se anota una línea convertiría
 * el diario en la parte más cara de la app. Una vez por arranque alcanza, porque
 * lo que crece el archivo dentro de una sesión tiene un techo conocido.
 *
 * @param {string} dir la carpeta de datos de la app
 * @returns {{ok: boolean, archivo?: string, teniamos?: number, error?: string}}
 */
function abrirDiario(dir) {
    if (!dir) return { ok: false, error: 'No se sabe dónde guardar el diario.' };
    try {
        fs.mkdirSync(dir, { recursive: true });
        archivoDiario = path.join(dir, 'diario.ndjson');
        const habia = leerDelDisco();
        if (habia.length > TOPE_EN_DISCO) {
            const cola = habia.slice(-TOPE_EN_DISCO);
            escribirAtomico(archivoDiario, `${cola.map(l => JSON.stringify(l)).join('\n')}\n`);
            return { ok: true, archivo: archivoDiario, teniamos: cola.length };
        }
        return { ok: true, archivo: archivoDiario, teniamos: habia.length };
    } catch (err) {
        // Que no se pueda guardar la historia no puede impedir que la app abra:
        // se sigue anotando en memoria, que es como funcionaba antes.
        archivoDiario = null;
        fallaAlVolcar = err.message;
        return { ok: false, error: err.message };
    }
}

function programarVolcado() {
    if (temporizador) return;
    temporizador = setTimeout(volcar, CADA_CUANTO_MS);
    // Un temporizador de un segundo que se renueva solo mantendría vivo el bucle
    // de eventos y la app tardaría en cerrar. Esto no es trabajo por el que valga
    // la pena esperar: si el proceso se va, `volcar` corre igual en el cierre.
    if (typeof temporizador.unref === 'function') temporizador.unref();
}

/** Manda a disco lo que haya pendiente. Silencioso: anotar no puede tirar. */
function volcar() {
    if (temporizador) { clearTimeout(temporizador); temporizador = null; }
    if (!archivoDiario || !pendientes.length) return { ok: true, escritas: 0 };
    const iban = pendientes;
    pendientes = [];
    try {
        fs.appendFileSync(archivoDiario, `${iban.map(l => JSON.stringify(l)).join('\n')}\n`);
        fallaAlVolcar = null;
        return { ok: true, escritas: iban.length };
    } catch (err) {
        // No se reencolan: si el disco no acepta, reintentar para siempre haría
        // crecer `pendientes` sin límite, que es la fuga que el tope evita. Se
        // guarda el motivo, y sale en la descarga para que se sepa que falta algo.
        fallaAlVolcar = err.message;
        return { ok: false, error: err.message };
    }
}

/** Lo que haya en el diario de disco, incluidas las corridas de otros días. */
function leerDelDisco() {
    if (!archivoDiario || !fs.existsSync(archivoDiario)) return [];
    let crudo;
    try {
        crudo = fs.readFileSync(archivoDiario, 'utf8');
    } catch (err) {
        return [];
    }
    const salida = [];
    for (const renglon of crudo.split('\n')) {
        if (!renglon.trim()) continue;
        try {
            salida.push(JSON.parse(renglon));
        } catch (err) {
            // Una línea cortada por la mitad —un cierre justo en medio de un
            // `appendFileSync`— no puede tirar abajo la lectura de las otras
            // veinte mil. Se saltea, que es lo único sensato que se puede hacer.
        }
    }
    return salida;
}

/** Todo lo anotado, en orden. Copia: nadie de afuera edita el registro. */
function todo() {
    return lineas.slice();
}

function estado() {
    return {
        lineas: lineas.length,
        descartadas,
        tope: TOPE,
        empezoEn,
        enDisco: Boolean(archivoDiario),
        pendientes: pendientes.length,
        fallaAlVolcar
    };
}

/** Vaciar. Lo usan las pruebas; la app no borra su propio diario. */
function limpiar() {
    lineas.length = 0;
    descartadas = 0;
    empezoEn = Date.now();
    pendientes = [];
    if (temporizador) { clearTimeout(temporizador); temporizador = null; }
    archivoDiario = null;
    fallaAlVolcar = null;
}

/**
 * La hora, en la hora de quien mira.
 *
 * En UTC, que es lo que da `toISOString`, una caída de las cuatro de la tarde
 * figura a las nueve de la noche. Quien reporta un problema lo ubica por la hora
 * de su reloj —"lo apreté recién", "fue después de almorzar"— y buscar esa hora
 * en el archivo no debería requerir hacer una resta.
 */
function reloj(ts) {
    const d = new Date(ts);
    const pad = (n, cuantos) => String(n).padStart(cuantos || 2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Una línea, tal como se lee en el archivo. */
function comoTexto(linea) {
    const base = `[${reloj(linea.ts)}] ${linea.origen.padEnd(7)} ${linea.evento}`;
    if (linea.datos == null) return base;
    if (typeof linea.datos !== 'object') return `${base} · ${linea.datos}`;
    const partes = Object.entries(linea.datos).map(([k, v]) =>
        `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return partes.length ? `${base} · ${partes.join(' ')}` : base;
}

/** Si una línea cuenta algo que salió mal. */
function esUnProblema(linea) {
    if (HUELE_A_PROBLEMA.test(linea.evento)) return true;
    const d = linea.datos;
    return Boolean(d && typeof d === 'object' && (d.error || d.ok === false));
}

/**
 * El archivo entero, en markdown.
 *
 * El orden no es cronológico a propósito. Quien abre esto está buscando por qué
 * algo no anduvo, y lo que necesita primero es la lista de lo que se rompió; el
 * relato completo lo va a leer después, y solo alrededor de esa línea. Con el
 * relato arriba, diagnosticar empieza por leer dos mil líneas para encontrar la
 * que importa.
 *
 * El relato va en un bloque de código y no en tabla ni en viñetas: son líneas
 * pegadas a un formato de ancho fijo, y markdown se las comería.
 *
 * @param {object} [cabecera] { version, electron, plataforma, arquitectura }
 * @param {object[]} [cuales] qué líneas contar; por omisión, las de esta sesión
 */
function texto(cabecera, cuales) {
    const c = cabecera || {};
    const todas = cuales || lineas;
    const problemas = todas.filter(esUnProblema);
    // El arranque parte la historia en corridas, que es como uno se acuerda de lo
    // que hizo: "ayer a la tarde", no "hace mil doscientas líneas".
    const arranques = todas.filter(l => l.evento === 'app.arranca').length;

    const cuantas = `${todas.length} línea(s)`
        + (descartadas ? ` · se descartaron ${descartadas} por el tope de ${TOPE} en memoria` : '');

    const partes = [
        '# Class Cut — registro',
        '',
        '| | |',
        '|---|---|',
        `| Generado | ${reloj(Date.now())} |`,
        `| App | ${c.version || '?'} · Electron ${c.electron || '?'} · ${c.plataforma || '?'} ${(c.arquitectura || '').trim()} |`,
        `| Desde | ${todas.length ? reloj(todas[0].ts) : reloj(empezoEn)} |`,
        `| Corridas | ${arranques || 1} |`,
        `| Líneas | ${cuantas} |`,
        '',
        'Sin claves ni rutas completas: mirá `engine/registro.js`.',
        ''
    ];

    if (fallaAlVolcar) {
        partes.push(`> Faltan líneas: el diario no se pudo guardar en disco (${fallaAlVolcar}).`, '');
    }

    partes.push(`## Lo que salió mal (${problemas.length})`, '');
    if (problemas.length) {
        partes.push('```', ...problemas.map(comoTexto), '```', '');
    } else {
        partes.push('Ninguna línea quedó marcada como error. Si igual algo no anduvo,',
            'está abajo en el relato: lo que se rompió sin decirlo es lo más difícil',
            'de encontrar, y por eso conviene contar qué se esperaba que pasara.', '');
    }

    partes.push('## Qué pasó', '', '```', ...todas.map(comoTexto), '```');
    return `${partes.join('\n')}\n`;
}

/** El nombre del archivo lleva la fecha para que dos descargas no se pisen. */
function nombreDeArchivo(cuando) {
    const d = new Date(cuando || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return `class-cut-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`;
}

/**
 * Escribe el registro en una carpeta. Atómico, como todo lo que escribe la app:
 * un cierre a mitad deja el archivo anterior y no medio archivo que se reporta
 * como si fuera entero.
 *
 * @param {string} dir carpeta destino (Descargas, se la pasa `main.js`)
 * @param {object} [cabecera] lo que va arriba del archivo
 * @returns {{ok: boolean, archivo?: string, lineas?: number, error?: string}}
 */
function escribir(dir, cabecera) {
    if (!dir) return { ok: false, error: 'No se sabe dónde escribir el registro.' };
    // Primero lo pendiente, si no la descarga se pierde justo el último segundo,
    // que es donde suele estar lo que se venía a mirar.
    volcar();
    // De disco cuando hay, que trae todas las corridas y no solo la de ahora;
    // de memoria cuando no, que es el caso de las pruebas y de los scripts.
    const guardadas = leerDelDisco();
    const cuales = guardadas.length ? guardadas : lineas;

    const destino = path.join(dir, nombreDeArchivo());
    try {
        fs.mkdirSync(dir, { recursive: true });
        escribirAtomico(destino, texto(cabecera, cuales));
        return { ok: true, archivo: destino, lineas: cuales.length };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Escritura atómica: temporal al lado y rename.
 *
 * Un cierre a mitad deja el archivo anterior y no medio archivo que se reporta
 * como si fuera entero, que en un diario sería especialmente cruel: se manda
 * pidiendo ayuda y lo que llega está cortado donde nadie sabe.
 */
function escribirAtomico(destino, contenido) {
    const temporal = `${destino}.tmp-${process.pid}`;
    fs.writeFileSync(temporal, contenido);
    fs.renameSync(temporal, destino);
    return destino;
}

module.exports = {
    TOPE, TOPE_EN_DISCO, OCULTO,
    anotar, todo, estado, limpiar, sanear, texto, comoTexto, escribir, nombreDeArchivo,
    abrirDiario, volcar, leerDelDisco
};
