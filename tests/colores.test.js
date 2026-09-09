'use strict';
/**
 * Cada vista tiene dos colores, y esta prueba fija cuál es cuál.
 *
 * `colorDeMarcador` es lo que se escribe en el XML y es lo que se va a ver en
 * Premiere. `colorEnLaApp` es de qué color se ve la toma en la pantalla de tomar
 * notas. No son el mismo dato y no se derivan uno del otro: el por qué está en
 * `VISTAS`, en `engine/notas-vivo.js`.
 *
 * Hacen falta tres cosas distintas de acá, y las tres se rompen en silencio:
 *
 * 1. Que el hexadecimal de la hoja de estilo sea el `colorEnLaApp` de su vista.
 *    Están escritos dos veces porque el CSS no se puede leer desde el motor, y
 *    separarlos no rompe nada: solo hace que la pantalla muestre un color y el
 *    resto de la app otro. Ya pasó —acá el profesor se veía violeta y a la
 *    secuencia llegaba azul—.
 *
 * 2. Que `PV` y `R` sigan siendo DISTINTOS de su marcador. Es una decisión, no un
 *    descuido, y sin una prueba que lo diga el próximo que lea los dos campos va
 *    a "arreglarlo" igualándolos.
 *
 * 3. Que encima de cada color se pueda leer. La tinta estuvo escrita a mano dos
 *    veces y las dos veces quedó apuntando a los colores equivocados.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const vivo = require('../engine/notas-vivo');
const fcpXml = require('../engine/fcp-xml');

const CSS = path.join(__dirname, '..', 'src', 'css', 'grabar.css');
const CSS_VISOR = path.join(__dirname, '..', 'src', 'css', 'visor.css');

// La tinta oscura y la clara de la hoja, que son las dos únicas que se ofrecen.
const OSCURA = '#14171f';
const CLARA = '#ffffff';

// Las dos vistas que se ven de un color distinto al de su marcador, y por qué.
const A_PROPOSITO = {
    PV: 'la cámara es cerúleo en todo el resto de la app',
    R: 'el grabador de pantalla es rosa en todo el resto de la app'
};

/** El entero de Premiere a lo que se escribe en una hoja de estilo. */
function aHex(entero) {
    const { red, green, blue } = fcpXml.componentesDePremiere(entero);
    return '#' + [red, green, blue].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Las variables `--prefijo-nombre: #hex;` de `grabar.css`, por nombre de vista. */
function deLaHoja(prefijo) {
    const texto = fs.readFileSync(CSS, 'utf8');
    const encontradas = new Map();
    const busca = new RegExp(`--${prefijo}-([a-z0-9]+)\\s*:\\s*(#[0-9a-f]{3,8})\\s*;`, 'gi');
    for (const m of texto.matchAll(busca)) {
        encontradas.set(m[1].toUpperCase(), m[2].toLowerCase());
    }
    return encontradas;
}

/**
 * Los colores de fuente del reproductor: `.cam-0 { --cam: #…; }` en `visor.css`.
 *
 * El índice va en la clase y no en el nombre de la variable —todas se llaman
 * `--cam`, y la que gana es la de la clase que tenga el elemento—, así que no se
 * pueden leer con el mismo lector que las de `grabar.css`.
 */
function delReproductor() {
    const texto = fs.readFileSync(CSS_VISOR, 'utf8');
    const encontradas = new Map();
    for (const m of texto.matchAll(/\.cam-(\d+)\s*\{\s*--cam:\s*(#[0-9a-f]{3,8})\s*;/gi)) {
        encontradas.set(m[1], m[2].toLowerCase());
    }
    return encontradas;
}

/** Cuánto contrasta un hexadecimal contra otro, como lo define WCAG. */
function contraste(unHex, otroHex) {
    const luz = hex => {
        const canal = i => {
            const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
    };
    const [alta, baja] = [luz(unHex), luz(otroHex)].sort((a, b) => b - a);
    return (alta + 0.05) / (baja + 0.05);
}

module.exports = async function (t) {
    // `formato.js` es ESM porque vive en la ventana, igual que en `ojo.test.js`.
    const formato = await import(
        pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'formato.js')).href);

    t.group('colores · el marcador de Premiere');

    t.test('el entero de Premiere se lee como color de hoja de estilo', () => {
        // `pproColor` viene ABGR: el byte de más peso después del alfa es el azul.
        // Estos dos son de un XML de verdad del Rodecaster, y el segundo es el que
        // las notas de formatos de OpenTimelineIO listan como el naranja de
        // Premiere. Leídos al revés dan dos azules casi iguales.
        t.eq(aHex(4281740498), '#d22c36', 'el PV del Rodecaster es el rojo de Premiere');
        t.eq(aHex(4280578025), '#e96f24', 'el R del Rodecaster es el naranja de Premiere');
        t.eq(aHex(4294967295), '#ffffff', 'el blanco es el mismo en cualquier orden');
    });

    t.test('cada vista lleva su entero de Premiere y no un hexadecimal', () => {
        // El XML quiere el entero nativo: sin él Premiere ajusta el RGB al color
        // más parecido de su paleta y el marcador cambia solo al reimportarlo.
        const raros = vivo.VISTAS
            .filter(v => !Number.isFinite(v.colorDeMarcador))
            .map(v => v.nombre);
        t.deep(raros, [], 'el color del marcador se escribe como `pproColor`');
    });

    t.group('colores · el color de la vista en la pantalla');

    t.test('la hoja declara una variable por cada vista, y ninguna de más', () => {
        const hoja = deLaHoja('vista');
        const vistas = vivo.VISTAS.map(v => v.nombre).sort();
        t.deep([...hoja.keys()].sort(), vistas,
            'cada vista de `notas-vivo.js` necesita su `--vista-…` en `grabar.css`');
    });

    t.test('el color de la hoja es el `colorEnLaApp` de su vista', () => {
        const hoja = deLaHoja('vista');
        const distintas = vivo.VISTAS
            .filter(v => hoja.get(v.nombre) !== v.colorEnLaApp)
            .map(v => `${v.nombre}: la hoja dice ${hoja.get(v.nombre)} y la vista ${v.colorEnLaApp}`);
        t.deep(distintas, [], 'la hoja y la lista de vistas tienen que decir lo mismo');
    });

    /* Lo de abajo es la parte que se va a querer "arreglar". */

    t.test('la cámara y el grabador de pantalla NO se ven del color de su marcador', () => {
        // A propósito: en la app estos dos colores ya significan de qué fuente es
        // algo, y quien graba mirando esta lista es quien después abre el
        // reproductor. Igualarlos al marcador es lo que hay que no hacer.
        for (const [nombre, porque] of Object.entries(A_PROPOSITO)) {
            const v = vivo.VISTAS.find(x => x.nombre === nombre);
            t.ok(v, `falta la vista ${nombre}`);
            t.ok(v.colorEnLaApp !== aHex(v.colorDeMarcador),
                `${nombre} tiene que verse distinto de su marcador: ${porque}`);
        }
    });

    t.test('la cámara es el cerúleo y la pantalla el rosa del reproductor', () => {
        // Los mismos dos de `.cam-0` y `.cam-1` en `visor.css`, que son las dos
        // primeras etiquetas de clip del XML. Reusados y no parecidos: "parecido"
        // es lo que hace que el usuario dude de si son la misma fuente.
        const camaras = delReproductor();
        const pv = vivo.VISTAS.find(v => v.nombre === 'PV');
        const r = vivo.VISTAS.find(v => v.nombre === 'R');
        t.eq(pv.colorEnLaApp, camaras.get('0'), 'el profesor va del cerúleo de la cámara');
        t.eq(r.colorEnLaApp, camaras.get('1'), 'la pantalla va del rosa del grabador');
    });

    t.test('las demás vistas sí coinciden con su marcador', () => {
        // También por elección: no tienen color propio en el reproductor con el
        // que chocar, así que el de Premiere es el que más información da.
        const distintas = vivo.VISTAS
            .filter(v => !A_PROPOSITO[v.nombre])
            .filter(v => v.colorEnLaApp !== aHex(v.colorDeMarcador))
            .map(v => `${v.nombre}: en la app ${v.colorEnLaApp} y en el marcador ${aHex(v.colorDeMarcador)}`);
        t.deep(distintas, [], 'sin un motivo, la vista se ve del color con el que va a llegar');
    });

    t.group('colores · encima de cada uno hay texto');

    t.test('cada vista declara la tinta que se lee encima de su color', () => {
        const tintas = deLaHoja('tinta');
        const vistas = vivo.VISTAS.map(v => v.nombre).sort();
        t.deep([...tintas.keys()].sort(), vistas,
            'cada vista necesita su `--tinta-…`: encima de su color va texto');
    });

    t.test('la tinta de cada vista es la que más contrasta contra su color', () => {
        const tintas = deLaHoja('tinta');
        const malas = [];
        for (const v of vivo.VISTAS) {
            const fondo = v.colorEnLaApp;
            const mejor = contraste(fondo, OSCURA) >= contraste(fondo, CLARA) ? OSCURA : CLARA;
            if (tintas.get(v.nombre) !== mejor) {
                malas.push(`${v.nombre} (${fondo}): la hoja pone ${tintas.get(v.nombre)} ` +
                    `y se lee mejor ${mejor}`);
            }
        }
        t.deep(malas, [], 'sobre el color de la vista el texto tiene que leerse');
    });

    t.test('ninguna vista queda con texto ilegible encima', () => {
        // 3:1, que es lo que WCAG pide para texto grande y para elementos de
        // interfaz. No llega a 4,5:1 y no puede: son colores elegidos para
        // distinguir fuentes de un vistazo, no para poner texto encima, y sobre el
        // cerúleo el techo de cualquier tinta es 4,3:1. Por eso la cabecera usa la
        // tinta ENTERA y separa la hora del número por peso y no por transparencia:
        // apagarla un 25% la bajaba de 4,3:1 a 3,1:1.
        const flojas = vivo.VISTAS
            .map(v => ({
                nombre: v.nombre,
                fondo: v.colorEnLaApp,
                razon: Math.max(contraste(v.colorEnLaApp, OSCURA), contraste(v.colorEnLaApp, CLARA))
            }))
            .filter(x => x.razon < 3)
            .map(x => `${x.nombre} (${x.fondo}): lo mejor que se consigue es ${x.razon.toFixed(2)}:1`);
        t.deep(flojas, [], 'con menos de 3:1 la cabecera no se lee con ninguna tinta');
    });

    t.group('colores · el cartelito de la vista en las pantallas de después');

    t.test('las tres pantallas preguntan en el mismo lugar de qué color va', () => {
        // Acá el color no dice qué vista es —el nombre está escrito al lado— sino
        // con qué fuente se grabó, y por eso solo `PV` y `R` tienen el suyo. La
        // respuesta estaba escrita en tres pantallas y dos se habían quedado con
        // la de cuando las vistas eran dos: cualquier cosa que no fuera `PV` salía
        // rosa, así que un bloque `S` se dibujaba con el nombre de una vista y el
        // color de otra. No lo agarraba ninguna prueba porque las tres andaban.
        const pantallas = ['src/js/visor/guion.js', 'src/js/visor/index.js', 'src/js/vista-clases.js'];
        for (const pantalla of pantallas) {
            const texto = fs.readFileSync(path.join(__dirname, '..', pantalla), 'utf8');
            t.ok(texto.includes('claseDeVista('), `${pantalla} lo pregunta`);
            t.ok(!/'badge-pv'|'badge-r'/.test(texto), `${pantalla} no se lo contesta solo`);
        }
    });

    t.test('y ahí solo PV y R llevan color, que son las dos fuentes', () => {
        const conColor = vivo.VISTAS
            .filter(v => formato.claseDeVista(v.nombre) !== 'badge-info')
            .map(v => v.nombre);
        t.deep(conColor, ['PV', 'R'],
            'las demás se graban con el grabador de pantalla: darles color inventa una fuente');
    });
};
