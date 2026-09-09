'use strict';
/**
 * maqueta.js — La interfaz entera en el navegador, llena de datos de mentira.
 *
 *   node tools/maqueta.js            (y abrir http://localhost:4321)
 *   node tools/maqueta.js --puerto=5000 --abrir
 *
 * Para qué: mirar el diseño no debería pedir un Rodecaster, una carpeta de curso
 * de 15 GB y media hora de proceso. Antes, opinar sobre cómo se ve la tabla de
 * clases o el panel del guion obligaba a tener el material de verdad a mano, así
 * que las pantallas que no fueran la que uno estaba usando ese día no se miraban
 * nunca — y las que se miraban, se miraban con UN caso, el que hubiera.
 *
 * Acá se ven las cinco pantallas, cada una con casos elegidos a propósito para
 * que se vea lo que en el uso normal aparece de a poco: una clase que ya se
 * procesó al lado de una que no se puede, una carpeta con avisos, bloques de
 * confianza baja, hallazgos de repetición, comentarios encima del transcript.
 *
 * Cómo funciona, y por qué así:
 *
 *   · Se sirve `src/` TAL CUAL. No hay una copia de la interfaz que mantener al
 *     día: lo que se mira acá es el archivo que se instala, y si alguien cambia
 *     el HTML esto lo refleja sin tocar nada. Lo único que se reescribe al vuelo
 *     es la línea de CSP —el navegador no tiene el protocolo `clase:`— y una
 *     etiqueta de script que se cuela antes de `app.js`.
 *
 *   · Ese script es el puente de mentira (`tools/maqueta/cc.js`): pone un
 *     `window.cc` con las mismas ~45 funciones que expone `preload.js` pero
 *     contestando de memoria. La interfaz no sabe que no está en Electron.
 *
 *   · El video y el audio son de verdad, generados con ffmpeg: sin ellos el
 *     reproductor es un rectángulo negro y no se puede opinar del recuadro, de
 *     la onda ni del karaoke. Llevan el tiempo quemado en la imagen para poder
 *     ver de un vistazo si lo que suena y lo que se resalta van juntos.
 *
 * Lo que NO se puede juzgar acá: nada que dependa del contenido real —si un
 * corte cae bien, si el transcript dice lo que se dijo—. Eso es la app con su
 * material. Esto es para el diseño.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('./../engine/paths');
const { pedazoPedido } = require('./../engine/media-server');
const vivo = require('./../engine/notas-vivo');
const workspace = require('./../engine/workspace');
const lengua = require('./../engine/lengua');
const grabacion = require('./../engine/grabacion');
const empalme = require('./../engine/empalme');
const cli = require('./lib/cli');
const plan = require('./maqueta/plan');

const RAIZ = path.join(__dirname, '..');
const FUENTE = path.join(RAIZ, 'src');
const NAVEGADOR = path.join(__dirname, 'maqueta');
const MEDIOS = path.join(RAIZ, '.maqueta');

/** Cuánto dura el material de relleno. Es el largo de la clase de la maqueta. */
const DURACION_SEC = plan.DURACION_SEC;

const TIPOS = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav'
};

/* ─── El material de relleno ─────────────────────────────────────────────
 *
 * Dos cámaras y un Live-Mix. Se generan una vez y quedan en `.maqueta/`: son
 * unos pocos MB y armarlos tarda unos segundos, así que rehacerlos en cada
 * arranque sería pagar la espera para siempre a cambio de nada.
 */

/**
 * Una cámara: el patrón de prueba de ffmpeg, apagado y teñido.
 *
 * El patrón trae el tiempo escrito en la esquina, y eso es lo que hace que esto
 * sirva para algo: sin un reloj en la imagen, dos videos no dicen si el
 * reproductor saltó a donde decía, ni si la palabra que se resalta es la que
 * suena. Se ve "algo de video" y se termina opinando de la caja.
 *
 * Se tiñe y se le baja el contraste por dos motivos. Uno, que crudo es un
 * arcoíris que tapa la interfaz que hay que mirar. Dos, que el tinte separa las
 * dos cámaras con los colores que la app ya usa —azul la del profesor, rosa la
 * de pantalla—, así que el recuadro y la tira de bloques se leen de un vistazo.
 *
 * No se usa `drawtext`, que sería más claro: el ffmpeg que la app incluye viene
 * sin libfreetype y ese filtro no existe ahí.
 */
function camara(salida, tono) {
    const verse = `hue=s=0,eq=contrast=0.35:brightness=-0.12,colorize=hue=${tono}:saturation=0.45:lightness=0.15`;
    return correr(salida, [
        '-f', 'lavfi', '-i', `testsrc2=s=960x540:r=25:d=${DURACION_SEC}`,
        '-vf', verse,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-pix_fmt', 'yuv420p',
        // El índice al principio: sin esto Chromium pide los últimos bytes para
        // encontrarlo y el primer salto tarda de más. Es lo mismo que hace la
        // app de verdad con el material del Rodecaster.
        '-movflags', '+faststart',
        salida
    ]);
}

/**
 * El Live-Mix, que es de donde sale la onda.
 *
 * Suena fuerte dentro de cada bloque y casi nada en los huecos, con los bordes
 * EXACTOS del plan (`maqueta/plan.js`). Eso es lo que hace que lo que se oye y
 * lo que se dibuja sean lo mismo: con un tono parejo, o con una envolvente
 * cualquiera, al reproducir habría silencio donde la onda muestra sonido y todo
 * lo que se mirara acá —el karaoke, la tira de bloques— parecería descuadrado.
 */
function liveMix(salida) {
    const voz = `sine=frequency=220:sample_rate=44100:duration=${DURACION_SEC}`;
    // Una suma de `between`: vale 1 dentro de un bloque y 0 fuera. `eval=frame`
    // porque sin eso la expresión se calcula una sola vez, al empezar.
    const dentro = plan.segmentos()
        .map(s => `between(t,${s.sourceStartSec},${s.sourceEndSec})`)
        .join('+');
    const puerta = `volume=volume='0.03+0.45*(${dentro})':eval=frame`;
    return correr(salida, [
        '-f', 'lavfi', '-i', voz,
        // El trémolo le da relieve al tono para que la onda no sea un rectángulo
        // macizo; la puerta es la que decide dónde hay clase y dónde no.
        '-af', `tremolo=f=6:d=0.5,${puerta}`,
        '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
        salida
    ]);
}

function correr(salida, args) {
    const bin = paths.ffmpeg();
    if (!bin || !bin.path) {
        throw new Error('No encuentro ffmpeg. Corré tools/bundle-binaries.sh, o poné uno en el PATH.');
    }
    const r = spawnSync(bin.path, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`ffmpeg no pudo armar ${path.basename(salida)}:\n${r.stderr || r.error}`);
    }
    return salida;
}

/** @returns {boolean} si hubo que generar algo */
function prepararMedios() {
    const piezas = [
        { archivo: 'camara-1.mp4', hacer: f => camara(f, 210) },   // azul, el profesor
        { archivo: 'camara-2.mp4', hacer: f => camara(f, 330) },   // rosa, la pantalla
        { archivo: 'live-mix.wav', hacer: liveMix }
    ];
    const faltan = piezas.filter(p => !fs.existsSync(path.join(MEDIOS, p.archivo)));
    if (!faltan.length) return false;

    fs.mkdirSync(MEDIOS, { recursive: true });
    for (const pieza of faltan) {
        process.stdout.write(`  armando ${pieza.archivo}… `);
        // A un archivo aparte y recién entonces al suyo: si esto se corta a la
        // mitad —Ctrl-C, la terminal que se cierra— lo que queda es basura con el
        // nombre bueno, y el arranque siguiente la da por hecha y sirve un video
        // roto. Pasó, y el síntoma era un reproductor en negro sin explicación.
        const destino = path.join(MEDIOS, pieza.archivo);
        // La extensión va al final igual: es de donde ffmpeg saca el formato.
        const enCurso = path.join(MEDIOS, `a-medias-${pieza.archivo}`);
        try {
            pieza.hacer(enCurso);
            fs.renameSync(enCurso, destino);
        } finally {
            if (fs.existsSync(enCurso)) fs.unlinkSync(enCurso);
        }
        process.stdout.write('listo\n');
    }
    return true;
}

/* ─── Servir ─────────────────────────────────────────────────────────────── */

/**
 * El `index.html` de la app con los dos cambios que pide un navegador.
 *
 * Se reescribe al vuelo y no se guarda una copia a propósito: una copia se
 * queda vieja el primer día que alguien toca el HTML de verdad, y entonces la
 * maqueta muestra una interfaz que ya no existe. Los cambios son mínimos y
 * están acotados a lo que Electron da y el navegador no.
 */
function indexParaElNavegador() {
    const html = fs.readFileSync(path.join(FUENTE, 'index.html'), 'utf8');
    const conCsp = html.replace(
        /media-src clase:;/,
        // `clase:` es el protocolo que registra `main.js`; acá los medios salen
        // de este mismo servidor.
        "media-src 'self' blob:;"
    );
    if (conCsp === html) {
        throw new Error('No encontré la línea de CSP en src/index.html: revisá tools/maqueta.js.');
    }
    return conCsp.replace(
        '<script type="module" src="js/app.js"></script>',
        // Antes de `app.js` y no después: los módulos corren apenas cargan, y
        // `app.js` llama a `window.cc` de entrada. Las vistas primero y el plan
        // detrás, que es de donde el puente saca los bloques.
        '<script src="maqueta/vistas.js"></script>\n' +
        '<script src="maqueta/plan.js"></script>\n' +
        '<script src="maqueta/cc.js"></script>\n' +
        '<script type="module" src="js/app.js"></script>'
    );
}

/**
 * Lo que el motor sabe y la maqueta necesita, servido como un script más: las
 * vistas y la forma de la carpeta de notas.
 *
 * No hay archivo en el disco a propósito: la maqueta tenía su propia copia de la
 * lista de vistas —con sus nombres, sus colores y su tabla de fuentes— y se
 * quedó vieja, así que el diseño se miraba con vistas que la app ya no ofrecía.
 * Esto es la lista de verdad pasada por JSON, que es lo más parecido a un
 * `require` que tiene un navegador sin empaquetador.
 */
function vistasParaElNavegador() {
    const { VISTAS, VISTA_POR_DEFECTO, MAPA_DE_VISTAS } = vivo;
    return 'window.maquetaVistas = ' +
        JSON.stringify({ VISTAS, VISTA_POR_DEFECTO, MAPA_DE_VISTAS }) + ';\n' +
        'window.maquetaNotas = ' + JSON.stringify(formaDeLaCarpeta()) + ';\n' +
        // Las bandas con las que un número entra en zona o no. Estaban copiadas a
        // mano en la maqueta con el argumento de que un navegador pelado no puede
        // importar el motor — que dejó de ser cierto el día que esto existió.
        'window.maquetaLengua = ' + JSON.stringify({ BANDAS: lengua.BANDAS }) + ';\n' +
        'window.maquetaMotor = ' + JSON.stringify(numerosDelMotor()) + ';\n';
}

/**
 * Los números con los que el motor se mueve, y con los que la maqueta se tiene
 * que mover para que verificar contra ella valga algo.
 *
 * `CICLO_MS` es cada cuánto el motor empuja el estado a la ventana. La maqueta lo
 * necesita porque manda el mismo empujón, y llega servido por lo mismo que las
 * bandas: copiado, la maqueta podía empujar a otro ritmo que la app y el arnés
 * estaría verificando un mundo que no existe.
 *
 * Los del empalme son los dos mínimos con los que un ajuste se puede ofrecer y
 * cuántas palabras del arranque se subrayan. Estaban escritos a mano en `cc.js`,
 * así que la maqueta podía ofrecer un ajuste que la app no ofrece.
 */
function numerosDelMotor() {
    return {
        CICLO_MS: grabacion.CICLO_MS,
        empalme: {
            MINIMO_PALABRAS: empalme.MINIMO_PALABRAS,
            MINIMO_RECORTE_MS: empalme.MINIMO_RECORTE_MS,
            MINIMO_QUEDA_MS: empalme.MINIMO_QUEDA_MS,
            CABEZA_PALABRAS: empalme.CABEZA_PALABRAS
        }
    };
}

/**
 * Cómo se reparte la carpeta de notas: las subcarpetas y el sufijo del sidecar.
 *
 * Por lo mismo que las vistas. La maqueta armaba esas rutas a mano y planas
 * —todo suelto en la raíz de la carpeta—, así que enseñaba una estructura que la
 * app dejó de usar cuando el XML bajó a `xml/`. No se copian los nombres: se le
 * preguntan a `workspace.js`, que es quien los decide, con una carpeta y un
 * nombre de mentira, y se le saca la parte que cuelga.
 */
function formaDeLaCarpeta() {
    const base = '/base';
    const { xml, json } = workspace.notasArchivos(base, 'clase');
    return {
        xml: path.dirname(xml).slice(base.length + 1),
        datos: path.dirname(json).slice(base.length + 1),
        sufijo: workspace.SUFIJO_SIDECAR
    };
}

/** Un archivo del disco, por pedazos si lo piden así (video y audio). */
function servirArchivo(req, res, archivo) {
    let size;
    try {
        size = fs.statSync(archivo).size;
    } catch (e) {
        return responder(res, 404, 'text/plain', 'no está');
    }

    const tipo = TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream';
    // La misma cuenta que usa la app de verdad (`engine/media-server.js`), que ya
    // tiene sus pruebas: acá no hay una segunda versión de cómo se lee un rango.
    const rango = pedazoPedido(req.headers.range, size);

    if (rango && rango.fueraDeRango) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
        return res.end();
    }

    const desde = rango ? rango.desde : 0;
    const hasta = rango ? rango.hasta : size - 1;
    res.writeHead(rango ? 206 : 200, Object.assign({
        'Content-Type': tipo,
        'Content-Length': String(hasta - desde + 1),
        'Accept-Ranges': 'bytes',
        // Para que el elemento se pueda conectar a Web Audio y el volumen pase
        // del 100%. Sin esto Chromium no falla: lo silencia.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
    }, rango ? { 'Content-Range': `bytes ${desde}-${hasta}/${size}` } : {}));
    fs.createReadStream(archivo, { start: desde, end: hasta }).pipe(res);
}

function responder(res, codigo, tipo, cuerpo) {
    res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
    res.end(cuerpo);
}

/**
 * Nada de subir por el árbol: `..` en la url no puede sacar del directorio.
 *
 * Esto sirve archivos del disco a un navegador, así que la frontera va acá
 * aunque escuche solo en local — es la misma regla que en `media-server.js`.
 */
function dentroDe(base, pedido) {
    const destino = path.resolve(base, '.' + path.posix.normalize('/' + pedido));
    return destino.startsWith(base + path.sep) || destino === base ? destino : null;
}

function manejar(req, res) {
    const ruta = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (ruta === '/' || ruta === '/index.html') {
        return responder(res, 200, TIPOS['.html'], indexParaElNavegador());
    }
    if (ruta === '/maqueta/vistas.js') {
        return responder(res, 200, TIPOS['.js'], vistasParaElNavegador());
    }
    if (ruta.startsWith('/maqueta/')) {
        const archivo = dentroDe(NAVEGADOR, ruta.slice('/maqueta'.length));
        if (!archivo || !fs.existsSync(archivo)) return responder(res, 404, 'text/plain', 'no está');
        return responder(res, 200, TIPOS['.js'], fs.readFileSync(archivo, 'utf8'));
    }
    if (ruta.startsWith('/media/')) {
        const archivo = dentroDe(MEDIOS, ruta.slice('/media'.length));
        return archivo ? servirArchivo(req, res, archivo) : responder(res, 403, 'text/plain', 'no');
    }

    const archivo = dentroDe(FUENTE, ruta);
    if (!archivo) return responder(res, 403, 'text/plain', 'no');
    if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
        return responder(res, 404, 'text/plain', 'no está');
    }
    servirArchivo(req, res, archivo);
}

function main() {
    const puerto = Number(cli.arg('puerto') || 4321);

    console.log('Class Cut · maqueta');
    if (prepararMedios()) console.log('');

    const server = http.createServer((req, res) => {
        try {
            manejar(req, res);
        } catch (e) {
            responder(res, 500, 'text/plain', String(e && e.stack || e));
        }
    });

    server.listen(puerto, '127.0.0.1', () => {
        const url = `http://localhost:${puerto}`;
        console.log(`  ${url}`);
        console.log('  Ctrl-C para parar. Recargá el navegador para ver los cambios del HTML.');
        // `includes` y no `cli.arg`: `--abrir` no lleva valor, y `arg` devolvería
        // lo que venga detrás.
        if (process.argv.includes('--abrir')) spawnSync('open', [url]);
    });
}

if (require.main === module) main();

module.exports = { indexParaElNavegador, vistasParaElNavegador, dentroDe, prepararMedios, DURACION_SEC };
