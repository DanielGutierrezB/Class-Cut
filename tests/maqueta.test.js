'use strict';
/**
 * Que la maqueta no sirva dos versiones a la vez.
 *
 * `tools/maqueta.js` sirve la interfaz de la app tal cual sale del disco, y
 * encima le inyecta lo que el motor sabe: las vistas, la forma de la carpeta de
 * notas, las bandas de lengua, la cadencia del ciclo y los mínimos del empalme.
 * Los archivos se leían frescos; las constantes no. Se armaban con cinco
 * `require` al arrancar y se quedaban en el caché de módulos de Node hasta
 * reiniciar el proceso, así que una maqueta abierta un rato —que es como se
 * usa, horas, mientras varios agentes cambian el código— servía **la pantalla de
 * ahora con el motor de hace horas**.
 *
 * Esa mezcla es peor que estar viejo entero, y por eso está probada acá: lo que
 * se ve es un problema que no está ni en la versión vieja ni en la nueva, así
 * que no se reproduce en ningún lado y se persigue igual. Pasó tres veces en un
 * día.
 *
 * Cómo se prueba sin escribir en el repo: se ensucia el caché de módulos con
 * valores falsos y se mira qué sale servido. Es lo mismo que preguntarle al
 * servidor si vuelve al disco o se queda con lo que ya tenía en la mano, que es
 * exactamente la decisión que se rompió. Cambiar los archivos de verdad con el
 * servidor levantado es de `tools/saber-fallar.js`, que para eso escribe sobre el
 * repo y no puede correr en esta pasada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const maqueta = require('../tools/maqueta');
const vivo = require('../engine/notas-vivo');
const lengua = require('../engine/lengua');
const grabacion = require('../engine/grabacion');
const empalme = require('../engine/empalme');
const workspace = require('../engine/workspace');
const repeticiones = require('../engine/repeticiones');

const RAIZ = path.join(__dirname, '..');
const MOTOR = path.join(RAIZ, 'engine');
const CLAVE_LENGUA = require.resolve('../engine/lengua');

const esDelMotor = clave => clave.startsWith(MOTOR + path.sep);

/** Los `window.maqueta*` que el servidor inyecta, ya desarmados. */
function servido() {
    const salida = {};
    for (const [, clave, json] of maqueta.vistasParaElNavegador().matchAll(/^window\.(maqueta\w+) = (.*);$/gm)) {
        salida[clave] = JSON.parse(json);
    }
    return salida;
}

/**
 * Los valores falsos, con la entrada del caché de módulos a la que van, tomada
 * al cargar este archivo — antes de que nadie la mueva de lugar.
 *
 * Son los CINCO módulos que se inyectan, uno por cada cosa que se sirve: de a
 * uno, cuatro podrían quedar congelados sin que nadie se entere.
 *
 * Y `repeticiones.js`, que no se inyecta: de ahí saca `empalme.js` dos de sus
 * mínimos, al cargar. Está para que se vea si algún día se sueltan solo las
 * cinco hojas — una hoja nueva colgada de un tronco viejo es la misma mezcla,
 * más difícil de ver.
 */
const MENTIRAS = [
    ['notas-vivo', 'VISTA_POR_DEFECTO', 'NO-EXISTE'],
    ['lengua', 'BANDAS', { ppm: { desde: -1, hasta: -1 } }],
    ['grabacion', 'CICLO_MS', 999999],
    ['empalme', 'MINIMO_PALABRAS', -7],
    ['workspace', 'SUFIJO_SIDECAR', '_mentira.json'],
    ['repeticiones', 'DEFAULTS', { ...repeticiones.DEFAULTS, minimoRecorteSec: -3, palabrasDeCabeza: -3 }]
].map(([nombre, campo, falso]) => {
    const clave = path.join(MOTOR, `${nombre}.js`);
    return { clave, campo, falso, entrada: require.cache[clave] };
});

/**
 * Corre algo con el motor del caché de módulos ensuciado, y lo limpia después.
 *
 * Un valor falso en el caché es lo mismo que un archivo cambiado en el disco,
 * visto desde el servidor: en los dos casos la pregunta es si lo que sirve sale
 * de leer de nuevo o de lo que ya tenía en la mano.
 *
 * La mentira se pone EN EL CACHÉ y no solo en el objeto: tiene que ser lo que un
 * `require` encontraría si no fuera al disco. Poniéndola solo en el objeto, un
 * servidor que hubiera vaciado el caché sin releer nada daría verde igual.
 */
function conElMotorEnsuciado(hacer) {
    const comoEstaba = MENTIRAS.map(m => require.cache[m.clave]);
    const verdades = MENTIRAS.map(m => m.entrada.exports[m.campo]);

    for (const m of MENTIRAS) {
        require.cache[m.clave] = m.entrada;
        m.entrada.exports[m.campo] = m.falso;
    }
    try {
        return hacer();
    } finally {
        MENTIRAS.forEach((m, i) => {
            m.entrada.exports[m.campo] = verdades[i];
            if (comoEstaba[i]) require.cache[m.clave] = comoEstaba[i];
            else delete require.cache[m.clave];
        });
    }
}

/** Una carpeta de usar y tirar. */
function enUnaCarpeta(hacer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-maqueta-'));
    try {
        return hacer(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = t => {

    t.group('la maqueta · el motor se relee, no se congela');

    t.test('lo que se inyecta sale del disco y no del caché de módulos', () => {
        t.ok(MENTIRAS.every(m => m.entrada), 'hay motor cargado que ensuciar');
        const limpio = servido();

        const sucio = conElMotorEnsuciado(() => {
            // Que la mentira esté puesta de verdad. Sin esto, un campo mal
            // escrito acá dejaría la prueba en verde sin haber probado nada.
            t.eq(lengua.BANDAS.ppm.desde, -1, 'el caché está ensuciado');
            t.eq(grabacion.CICLO_MS, 999999, 'el caché está ensuciado');
            return servido();
        });

        t.deep(sucio.maquetaLengua, limpio.maquetaLengua, 'las bandas');
        t.deep(sucio.maquetaVistas, limpio.maquetaVistas, 'las vistas');
        t.deep(sucio.maquetaNotas, limpio.maquetaNotas, 'la forma de la carpeta de notas');
        t.deep(sucio.maquetaMotor, limpio.maquetaMotor, 'el ciclo y los mínimos del empalme');
        t.eq(sucio.maquetaMotor.empalme.MINIMO_RECORTE_MS, empalme.MINIMO_RECORTE_MS,
            'y lo que el empalme saca de `repeticiones` al cargar, también');
    });

    t.test('y son los cinco módulos, no uno', () => {
        // El valor de la prueba de arriba depende de que cada mentira toque algo
        // que de verdad se sirva. Acá se mira al revés: que lo servido diga lo
        // que el motor dice ahora, campo por campo.
        const s = servido();
        t.eq(s.maquetaVistas.VISTA_POR_DEFECTO, vivo.VISTA_POR_DEFECTO);
        t.deep(s.maquetaLengua.BANDAS, lengua.BANDAS);
        t.eq(s.maquetaNotas.sufijo, workspace.SUFIJO_SIDECAR);
        t.eq(s.maquetaMotor.CICLO_MS, grabacion.CICLO_MS);
        t.eq(s.maquetaMotor.empalme.MINIMO_PALABRAS, empalme.MINIMO_PALABRAS);
    });

    t.test('y deja el caché de módulos exactamente como estaba', () => {
        // Es la mitad cara de releer: si las copias nuevas se quedaran en el
        // caché, la prueba que corriera después se llevaría un SEGUNDO motor con
        // su propio estado mientras las de antes siguen con el primero. Acá el
        // proceso lo comparte toda la suite, así que eso no es teórico.
        const antes = new Map(Object.keys(require.cache).filter(esDelMotor).map(c => [c, require.cache[c]]));
        t.ok(antes.size > 10, `hay motor cargado que perder (${antes.size} módulos)`);

        maqueta.vistasParaElNavegador();

        const ahora = Object.keys(require.cache).filter(esDelMotor);
        const cambiados = ahora.filter(c => antes.get(c) !== require.cache[c]);
        t.eq(ahora.length, antes.size, 'ni sobran ni faltan módulos');
        t.eq(cambiados.length, 0, `siguen siendo los mismos objetos: ${cambiados.join(' · ')}`);
        t.eq(require.cache[CLAVE_LENGUA].exports, lengua, 'y el que usa el resto de la suite es ese');
    });

    t.group('la maqueta · el aviso de que la pestaña quedó vieja');

    t.test('la huella cambia cuando cambia un archivo, y no cuando no', () => {
        enUnaCarpeta(dir => {
            fs.writeFileSync(path.join(dir, 'uno.js'), 'const a = 1;');
            fs.writeFileSync(path.join(dir, 'dos.js'), 'const b = 2;');

            const antes = maqueta.huellaDe(dir);
            t.eq(maqueta.huellaDe(dir), antes, 'sin tocar nada da lo mismo');

            fs.writeFileSync(path.join(dir, 'uno.js'), 'const a = 22;');
            const editado = maqueta.huellaDe(dir);
            t.ok(editado !== antes, 'con un archivo editado, no');

            fs.unlinkSync(path.join(dir, 'dos.js'));
            t.ok(maqueta.huellaDe(dir) !== editado, 'y borrar uno también cuenta');
        });
    });

    t.test('una ruta que no está no tira: los archivos se mueven mientras se miran', () => {
        // Un agente cambiando de rama borra y escribe archivos debajo de esto, y
        // que la maqueta se caiga por mirar en mal momento sería cambiar un
        // problema por otro peor.
        t.eq(typeof maqueta.huellaDe(path.join(os.tmpdir(), 'cc-no-existe-nunca')), 'string');
    });

    t.test('lo servido trae la huella contra la que el vigía compara', () => {
        t.deep(Object.keys(servido().maquetaHuella).sort(),
            ['interfaz', 'motor', 'puente', 'servidor']);
    });

    t.test('el vigía mira las mismas huellas que el servidor manda', () => {
        // Renombrar una de las cuatro de un solo lado no rompe nada visible: el
        // vigía compararía `undefined` con `undefined` y se quedaría callado para
        // siempre, que es el mismo silencio que había antes de que existiera.
        const texto = fs.readFileSync(path.join(RAIZ, 'tools', 'maqueta', 'vigia.js'), 'utf8');
        const bloque = texto.match(/const RECARGABLE = \{([^}]*)\}/);
        t.ok(bloque, 'el vigía tiene su lista de qué se arregla recargando');

        const recargables = [...bloque[1].matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
        t.deep([...recargables, 'servidor'].sort(), Object.keys(maqueta.huellaDeLoServido()).sort());
        t.ok(texto.includes("distinto(ahora, 'servidor')"),
            'y el servidor lo mira aparte, porque recargar no lo arregla');
    });

    t.test('el índice carga el vigía, detrás de las vistas y delante de la app', () => {
        const html = maqueta.indexParaElNavegador();
        const donde = pedazo => html.indexOf(pedazo);
        t.ok(donde('maqueta/vigia.js') > 0, 'el vigía está puesto');
        t.ok(donde('maqueta/vistas.js') < donde('maqueta/vigia.js'),
            'la huella con la que compara la deja vistas.js');
        t.ok(donde('maqueta/vigia.js') < donde('js/app.js'));
    });

    t.group('la maqueta · el material de relleno sigue al plan');

    t.test('con el sello al día no se rehace nada', () => {
        enUnaCarpeta(dir => {
            for (const pieza of maqueta.PIEZAS) fs.writeFileSync(path.join(dir, pieza.archivo), 'x');
            fs.writeFileSync(path.join(dir, maqueta.SELLO), 'abc123');
            t.eq(maqueta.piezasQueFaltan(dir, 'abc123').length, 0);
        });
    });

    t.test('con el plan cambiado se rehace todo', () => {
        // El audio sale de `maqueta/plan.js` y la silueta que dibuja la interfaz
        // también, pero el audio se guarda entre arranques y el plan se lee del
        // disco. Con uno nuevo y el otro viejo, la onda muestra sonido donde se
        // oye silencio y el karaoke y la tira de bloques se ven rotos sin estarlo.
        enUnaCarpeta(dir => {
            for (const pieza of maqueta.PIEZAS) fs.writeFileSync(path.join(dir, pieza.archivo), 'x');
            fs.writeFileSync(path.join(dir, maqueta.SELLO), 'abc123');
            t.eq(maqueta.piezasQueFaltan(dir, 'otro-plan').length, maqueta.PIEZAS.length);
        });
    });

    t.test('sin sello se rehace: es material de antes de que esto se sellara', () => {
        enUnaCarpeta(dir => {
            for (const pieza of maqueta.PIEZAS) fs.writeFileSync(path.join(dir, pieza.archivo), 'x');
            t.eq(maqueta.piezasQueFaltan(dir, 'abc123').length, maqueta.PIEZAS.length);
        });
    });

    t.test('y la pieza que falta se arma sola, sin rehacer las otras dos', () => {
        // Lo de siempre: armar las tres tarda unos segundos y pagarlos en cada
        // arranque por un archivo que se borró es cómo esto deja de usarse.
        enUnaCarpeta(dir => {
            for (const pieza of maqueta.PIEZAS) fs.writeFileSync(path.join(dir, pieza.archivo), 'x');
            fs.writeFileSync(path.join(dir, maqueta.SELLO), 'abc123');
            fs.unlinkSync(path.join(dir, 'live-mix.wav'));
            t.deep(maqueta.piezasQueFaltan(dir, 'abc123').map(p => p.archivo), ['live-mix.wav']);
        });
    });
};
