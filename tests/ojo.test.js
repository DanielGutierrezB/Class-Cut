'use strict';
/**
 * El monitor de video de la pantalla Grabar (`src/js/grabar/ojo.js`).
 *
 * Lo que se prueba acá es cuándo la cámara tiene que estar prendida, y no es un
 * detalle de comportamiento: es LA regla. Una cámara que queda abierta se come
 * batería y CPU en medio de una grabación y deja su luz encendida en la sala, y
 * el fallo no se ve —la pantalla se ve igual de bien con la cámara olvidada que
 * sin ella—. La única señal es física, así que la regla vive en una función pura
 * y se la puede interrogar acá con los casos que de otro modo piden desenchufar
 * un cable a mano: el paso que cambia, el dispositivo que se va, la vista que se
 * cierra mientras el `getUserMedia` todavía no contestó.
 *
 * Que la luz se apague de verdad no lo puede probar esto: eso se miró con la
 * cámara delante. Lo que esto cuida es que la decisión no se olvide de un caso.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** El módulo es ESM porque vive en la ventana; desde acá se importa a mano. */
async function cargar() {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', 'grabar', 'ojo.js')).href);
}

/** La situación buena: hay fuente, la vista está abierta y el paso en pantalla. */
function mirando(cambios) {
    return Object.assign({
        fuente: 'cam-1',
        abierta: true,
        enPantalla: true,
        caido: '',
        prendida: false
    }, cambios || {});
}

module.exports = async t => {
    const ojo = await cargar();

    t.group('el monitor de video · cuándo la cámara está prendida');

    t.test('con todo dado y sin cámara abierta, se abre', () => {
        t.eq(ojo.queHacer(mirando()), 'abrir');
    });

    t.test('con todo dado y la cámara ya abierta, no se toca nada', () => {
        // Repintar no puede reabrir: sería cortar la imagen a cada rato.
        t.eq(ojo.queHacer(mirando({ prendida: true })), 'nada');
    });

    t.test('cerrar la vista suelta la cámara, no la esconde', () => {
        t.eq(ojo.queHacer(mirando({ abierta: false, prendida: true })), 'soltar');
    });

    t.test('dejar el selector en «Ninguna» también suelta', () => {
        t.eq(ojo.queHacer(mirando({ fuente: '', prendida: true })), 'soltar');
    });

    t.test('irse a otro paso suelta', () => {
        // Nadie puede estar mirando un monitor que no está en pantalla, y la
        // grabación sigue corriendo: es justo cuando menos sobra la CPU.
        t.eq(ojo.queHacer(mirando({ enPantalla: false, prendida: true })), 'soltar');
    });

    t.test('el dispositivo que se cayó suelta lo que quedara y no reabre', () => {
        const porque = 'Se desconectó la entrada de video.';
        t.eq(ojo.queHacer(mirando({ caido: porque, prendida: true })), 'soltar');
        t.eq(ojo.queHacer(mirando({ caido: porque })), 'nada',
            'sin esto se le pide la cámara cada segundo a algo que no está');
    });

    t.test('sin nada elegido y sin nada abierto no hay nada que hacer', () => {
        t.eq(ojo.queHacer(mirando({ fuente: '' })), 'nada');
    });

    t.test('no se abre nunca si falta cualquiera de las cuatro condiciones', () => {
        // El barrido entero y no cuatro casos sueltos: el fallo que importa es
        // olvidarse de UNA, y escribirlas a mano es la misma clase de olvido.
        const abre = situaciones(false).filter(s => ojo.queHacer(s) === 'abrir');
        t.eq(abre.length, 1, `abre en ${abre.length} situaciones`);
        t.deep(abre[0], mirando(), 'la única es con las cuatro dadas');
    });

    t.test('y con la cámara prendida, cualquier condición que falte la suelta', () => {
        const suelta = situaciones(true).filter(s => ojo.queHacer(s) === 'soltar');
        // Las dieciséis menos la única en la que corresponde seguir mirando.
        t.eq(suelta.length, 15);
    });

    t.test('una situación a medio armar no enciende nada', () => {
        // Llega de un `estado` recién creado, antes de saber qué hay enchufado.
        t.eq(ojo.queHacer({}), 'nada');
        t.eq(ojo.queHacer(null), 'nada');
    });

    t.group('el monitor de video · la lista de cámaras');

    t.test('solo las de video, con su nombre', () => {
        const { lista, sinPermiso } = ojo.listar([
            { kind: 'audioinput', deviceId: 'mic', label: 'Rodecaster Pro II' },
            { kind: 'videoinput', deviceId: 'v1', label: 'Rodecaster Video' },
            { kind: 'audiooutput', deviceId: 'out', label: 'AirPods' },
            { kind: 'videoinput', deviceId: 'v2', label: 'FaceTime HD' }
        ]);
        t.deep(lista, [
            { id: 'v1', nombre: 'Rodecaster Video' },
            { id: 'v2', nombre: 'FaceTime HD' }
        ]);
        t.eq(sinPermiso, 0);
    });

    t.test('la misma cámara vista dos veces entra una sola', () => {
        // Dos opciones idénticas en el selector no se distinguen entre sí, así
        // que elegir sería adivinar.
        const { lista } = ojo.listar([
            { kind: 'videoinput', deviceId: 'v1', label: 'Rodecaster Video' },
            { kind: 'videoinput', deviceId: 'v1', label: 'Rodecaster Video' }
        ]);
        t.eq(lista.length, 1);
    });

    t.test('sin permiso, las cámaras vienen sin id y se cuentan aparte', () => {
        // No es lo mismo "no hay cámaras" que "hay y todavía no sabemos cuáles":
        // con lo segundo hay algo que ofrecer —pedir el permiso— y con lo
        // primero no. En la lista cruda los dos casos se ven igual.
        const { lista, sinPermiso } = ojo.listar([
            { kind: 'videoinput', deviceId: '', label: '' },
            { kind: 'videoinput', deviceId: '', label: '' }
        ]);
        t.deep(lista, []);
        t.eq(sinPermiso, 2);
    });

    t.test('sin cámaras no hay nada que pedir', () => {
        const { lista, sinPermiso } = ojo.listar([
            { kind: 'audioinput', deviceId: 'mic', label: 'Rodecaster Pro II' }
        ]);
        t.deep(lista, []);
        t.eq(sinPermiso, 0, 'sin esto la pantalla ofrecería un permiso para nada');
    });

    t.test('una cámara con el nombre en blanco igual se puede elegir', () => {
        const { lista } = ojo.listar([
            { kind: 'videoinput', deviceId: 'v1', label: '' },
            { kind: 'videoinput', deviceId: 'v2', label: '' }
        ]);
        t.deep(lista.map(c => c.nombre), ['Cámara 1', 'Cámara 2']);
    });

    t.test('y no se cae con lo que el navegador no devolvió', () => {
        t.deep(ojo.listar(undefined), { lista: [], sinPermiso: 0 });
        t.deep(ojo.listar([null, { kind: 'videoinput', deviceId: 'v1', label: 'Cam' }]).lista,
            [{ id: 'v1', nombre: 'Cam' }]);
    });
};

/** Las dieciséis combinaciones de las cuatro condiciones, con la cámara dada. */
function situaciones(prendida) {
    const todas = [];
    for (const fuente of ['', 'cam-1']) {
        for (const abierta of [false, true]) {
            for (const enPantalla of [false, true]) {
                for (const caido of ['', 'se fue']) {
                    todas.push({ fuente, abierta, enPantalla, caido, prendida });
                }
            }
        }
    }
    return todas;
}
