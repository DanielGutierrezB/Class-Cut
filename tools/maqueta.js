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
 *   · Y lo que el motor sabe se le pregunta al motor EN CADA PEDIDO, releyéndolo
 *     del disco (ver `motorAlDia`). Los archivos ya salían frescos, pero las
 *     constantes se armaban una vez al arrancar y quedaban en el caché de
 *     módulos de Node, así que una maqueta abierta un rato servía la pantalla de
 *     ahora con el motor de hace horas. Mezclar dos versiones es peor que estar
 *     viejo entero: el problema que se ve no está en ninguna de las dos.
 *
 *   · Aun así, una pestaña abierta corre el JS de cuando se abrió. Por eso va
 *     `maqueta/vigia.js`, que mira una huella del disco y pone un cartel cuando
 *     lo servido dejó de ser lo que esa pestaña está corriendo.
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

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('./../engine/paths');
// El único pedazo del motor que la maqueta usa como CÓDIGO y no como dato: es su
// propia cuenta de rangos HTTP, no algo que se le inyecte a la página. Por eso
// no pasa por `motorAlDia`: es una función pura de (cabecera, tamaño) con sus
// pruebas en `media-server.test.js`, se llama una vez por pedazo de video —el
// camino caliente— y servirla vieja no puede desencajar nada de lo que se mira.
const { pedazoPedido } = require('./../engine/media-server');
const cli = require('./lib/cli');
const plan = require('./maqueta/plan');

const RAIZ = path.join(__dirname, '..');
const FUENTE = path.join(RAIZ, 'src');
const MOTOR = path.join(RAIZ, 'engine');
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

/* ─── El motor, releído ──────────────────────────────────────────────────
 *
 * Los archivos de la interfaz salen del disco en cada pedido. Las constantes del
 * motor no salían: se armaban con cinco `require` al arrancar y vivían en el
 * caché de módulos de Node hasta reiniciar el proceso. Con la maqueta abierta
 * horas —que es como se usa— eso servía la pantalla de ahora con las vistas, las
 * bandas, la cadencia del ciclo y los mínimos del empalme de hace horas.
 *
 * El síntoma es el peor que hay: no se ve nada raro. La maqueta enseña una vista
 * que la app ya no ofrece, o deja de ofrecer un ajuste que la app sí hace, y lo
 * que se reporta es un problema de la app que en la app no existe. Pasó tres
 * veces en un día.
 */

/**
 * El motor tal como está en el disco AHORA.
 *
 * Se lo saca del caché de módulos, se lo vuelve a pedir —eso lo lee del disco de
 * nuevo, con todo lo que cuelgue de él— y se deja el caché exactamente como
 * estaba. Lo último es lo que hace que esto sea seguro:
 *
 *   · Hay estado a nivel de módulo en el motor (`grabacion.js` se guarda la
 *     sesión abierta, `paths.js` memoriza dónde encontró cada binario). Acá no
 *     se pierde nada porque la maqueta no maneja el motor: es un servidor de
 *     archivos, el motor lo maneja el navegador de mentira. Solo se le leen
 *     constantes, y se las copia a JSON en el acto.
 *
 *   · Dejar la copia nueva en el caché sí sería un problema, y no acá sino en la
 *     suite: `tests/lengua.test.js` pide este módulo, y ahí el proceso lo
 *     comparte con todas las pruebas. Una prueba que corriera después se llevaría
 *     una SEGUNDA copia del motor, con su propio estado, mientras las de antes
 *     siguen con la primera — la clase de fallo que después tarda una tarde. Por
 *     eso el `finally` devuelve el caché como estaba y de la copia recién leída
 *     no sobrevive nada más que los números ya serializados.
 *
 * Si el motor no compila —un agente a mitad de guardar— esto tira, la respuesta
 * sale en 500 y el error va a la terminal. Es lo que corresponde: la maqueta
 * gritando que el motor está roto es información, y servir los valores viejos
 * calladita es justamente lo que se vino a arreglar.
 */
function motorAlDia() {
    const guardado = olvidarElMotor();
    try {
        // `require` adentro de la función y con la ruta armada: es el punto de
        // todo esto. Importarlos arriba es lo que los congelaba.
        return {
            vivo: require(path.join(MOTOR, 'notas-vivo')),
            lengua: require(path.join(MOTOR, 'lengua')),
            grabacion: require(path.join(MOTOR, 'grabacion')),
            empalme: require(path.join(MOTOR, 'empalme')),
            workspace: require(path.join(MOTOR, 'workspace'))
        };
    } finally {
        olvidarElMotor();
        Object.assign(require.cache, guardado);
    }
}

/**
 * Saca del caché de módulos todo lo que cuelgue de `engine/`, y devuelve lo que
 * sacó para poder dejarlo como estaba.
 *
 * El árbol entero y no los cinco de arriba: `empalme.js` saca sus mínimos de
 * `repeticiones.js`, así que soltar solo la hoja devolvería una hoja nueva
 * colgada de un tronco viejo, que es la misma mezcla en chiquito.
 */
function olvidarElMotor() {
    const sacado = {};
    for (const clave of Object.keys(require.cache)) {
        if (clave.startsWith(MOTOR + path.sep)) {
            sacado[clave] = require.cache[clave];
            delete require.cache[clave];
        }
    }
    return sacado;
}

/* ─── La huella ──────────────────────────────────────────────────────────── */

/**
 * Un resumen corto de en qué estado está un archivo o una carpeta.
 *
 * Tamaño y fecha de escritura, no el contenido: esto se pide cada dos segundos
 * desde cada pestaña abierta, y leer el megabyte del motor entero para eso sería
 * pagar por una precisión que no cambia ninguna decisión. Lo peor que puede pasar
 * con la fecha es un cartel de más cuando algo se tocó sin cambiar —un checkout
 * que devuelve lo mismo—, y avisar de más acá no cuesta nada.
 *
 * Lo que desaparece mientras se mira se saltea en vez de tirar: un agente
 * cambiando de rama borra y escribe archivos, y que la maqueta se caiga por eso
 * sería cambiar un problema por otro.
 */
function huellaDe(ruta) {
    const suma = crypto.createHash('sha1');

    const mirar = (r) => {
        let st;
        try { st = fs.statSync(r); } catch (e) { return; }
        if (!st.isDirectory()) return suma.update(`${r}|${st.size}|${st.mtimeMs}\n`);
        let dentro;
        try { dentro = fs.readdirSync(r); } catch (e) { return; }
        for (const nombre of dentro.sort()) mirar(path.join(r, nombre));
    };

    mirar(ruta);
    return suma.digest('hex').slice(0, 12);
}

/**
 * Las cuatro huellas de lo que la maqueta sirve, separadas por lo que hay que
 * hacer con cada una.
 *
 * Las tres primeras se arreglan recargando la pestaña. La cuarta no: si cambió
 * el servidor, lo que hay que hacer es reiniciarlo, y un cartel que dijera
 * "recargá" mandaría a apretar un botón que no cambia nada.
 */
function huellaDeLoServido() {
    return {
        interfaz: huellaDe(FUENTE),
        puente: huellaDe(NAVEGADOR),
        motor: huellaDe(MOTOR),
        servidor: huellaDe(__filename)
    };
}

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

const PIEZAS = [
    { archivo: 'camara-1.mp4', hacer: f => camara(f, 210) },   // azul, el profesor
    { archivo: 'camara-2.mp4', hacer: f => camara(f, 330) },   // rosa, la pantalla
    { archivo: 'live-mix.wav', hacer: liveMix }
];

/** El archivito que dice con qué plan se armó lo que hay en `.maqueta/`. */
const SELLO = 'del-plan.txt';

/**
 * Con qué plan se armó esto: el contenido de `maqueta/plan.js`, resumido.
 *
 * Por contenido y no por fecha, al revés que `huellaDe`: acá equivocarse cuesta
 * los segundos de ffmpeg, y un `git checkout` que deja el archivo igual no tiene
 * por qué pagarlos.
 */
function selloDelPlan() {
    const crudo = fs.readFileSync(path.join(NAVEGADOR, 'plan.js'));
    return crypto.createHash('sha1').update(crudo).digest('hex').slice(0, 12);
}

/**
 * Qué piezas hay que armar: las que no están, y TODAS si el plan cambió.
 *
 * El material se guarda entre arranques —son unos MB y unos segundos, rehacerlo
 * siempre sería pagar la espera para nada—, y esa memoria es la misma trampa que
 * el caché de módulos: `plan.js` decide dónde empieza y termina cada bloque, y el
 * navegador lo lee del disco. Con el plan cambiado y el audio de antes, la onda
 * dibuja sonido donde se oye silencio y todo lo que dependa de la sincronía —el
 * karaoke, la tira de bloques, dónde cae un corte— se ve roto sin estarlo.
 */
function piezasQueFaltan(dir, sello) {
    const marca = path.join(dir, SELLO);
    const alDia = fs.existsSync(marca) && fs.readFileSync(marca, 'utf8') === sello;
    return PIEZAS.filter(p => !alDia || !fs.existsSync(path.join(dir, p.archivo)));
}

/** @returns {boolean} si hubo que generar algo */
function prepararMedios() {
    const sello = selloDelPlan();
    const faltan = piezasQueFaltan(MEDIOS, sello);
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
    // El sello al final y no antes: si esto se corta en la mitad, el arranque que
    // viene tiene que volver a encontrar el material desactualizado.
    fs.writeFileSync(path.join(MEDIOS, SELLO), sello);
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
        // detrás, que es de donde el puente saca los bloques. El vigía al final
        // de los cuatro: lee la huella que dejó `vistas.js` y no lo necesita
        // nadie, así que es el que menos puede estorbar si se cae.
        '<script src="maqueta/vistas.js"></script>\n' +
        '<script src="maqueta/plan.js"></script>\n' +
        '<script src="maqueta/cc.js"></script>\n' +
        '<script src="maqueta/vigia.js"></script>\n' +
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
 *
 * Se arma en cada pedido con el motor recién leído del disco (`motorAlDia`), que
 * es lo que hace que "la lista de verdad" siga siendo la de verdad y no la de
 * cuando se levantó el servidor.
 */
function vistasParaElNavegador() {
    const motor = motorAlDia();
    const { VISTAS, VISTA_POR_DEFECTO, MAPA_DE_VISTAS } = motor.vivo;
    return 'window.maquetaVistas = ' +
        JSON.stringify({ VISTAS, VISTA_POR_DEFECTO, MAPA_DE_VISTAS }) + ';\n' +
        'window.maquetaNotas = ' + JSON.stringify(formaDeLaCarpeta(motor.workspace)) + ';\n' +
        // Las bandas con las que un número entra en zona o no. Estaban copiadas a
        // mano en la maqueta con el argumento de que un navegador pelado no puede
        // importar el motor — que dejó de ser cierto el día que esto existió.
        'window.maquetaLengua = ' + JSON.stringify({ BANDAS: motor.lengua.BANDAS }) + ';\n' +
        'window.maquetaMotor = ' + JSON.stringify(numerosDelMotor(motor)) + ';\n' +
        // Contra qué compara el vigía: cómo estaba el disco cuando esta pestaña
        // se cargó. Va acá y no en una llamada aparte para que sea exactamente el
        // mismo momento del que salieron los números de arriba.
        'window.maquetaHuella = ' + JSON.stringify(huellaDeLoServido()) + ';\n';
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
function numerosDelMotor({ grabacion, empalme }) {
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
function formaDeLaCarpeta(workspace) {
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
    // Lo que el vigía pregunta cada dos segundos. Es un script y no un JSON
    // porque la CSP de la app —la de verdad, la que esto sirve casi tal cual—
    // deja pasar `script-src 'self'` y nada más: sin `connect-src`, un `fetch`
    // desde la página no sale. Abrirle la CSP a la maqueta sería dejarla hacer
    // algo que la app no puede, que es la mentira que acá no se permite.
    if (ruta === '/maqueta/huella.js') {
        return responder(res, 200, TIPOS['.js'],
            `window.maquetaVigia && window.maquetaVigia(${JSON.stringify(huellaDeLoServido())});\n`);
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
            // A la terminal además de a la respuesta: cuando lo que falla es
            // releer el motor, el navegador solo dice "no se pudo cargar el
            // script" y el motivo —el archivo que no compila— está acá.
            console.error(`  ✗ ${req.url}\n${e && e.stack || e}`);
            responder(res, 500, 'text/plain', String(e && e.stack || e));
        }
    });

    server.listen(puerto, '127.0.0.1', () => {
        const url = `http://localhost:${puerto}`;
        console.log(`  ${url}`);
        console.log('  Ctrl-C para parar. La interfaz y el motor se releen en cada pedido;');
        console.log('  recargá el navegador, o esperá el cartel que avisa cuando hace falta.');
        // `includes` y no `cli.arg`: `--abrir` no lleva valor, y `arg` devolvería
        // lo que venga detrás.
        if (process.argv.includes('--abrir')) spawnSync('open', [url]);
    });
}

if (require.main === module) main();

module.exports = {
    indexParaElNavegador,
    vistasParaElNavegador,
    motorAlDia,
    huellaDe,
    huellaDeLoServido,
    piezasQueFaltan,
    PIEZAS,
    SELLO,
    dentroDe,
    prepararMedios,
    DURACION_SEC
};
