'use strict';
/**
 * pcm-worklet.js — El audio que entra, pasado a 16 bits y mandado afuera.
 *
 * Corre en el hilo de audio, que es el único lugar donde no se pierde una
 * muestra: un `ScriptProcessorNode` en el hilo principal se salta pedazos en
 * cuanto la ventana dibuja algo grande, y acá lo que se está grabando no se
 * puede repetir.
 *
 * Convierte a 16 bits ACÁ y no del otro lado del puente por dos razones: es la
 * mitad de tráfico, y es el formato en el que el WAV se va a escribir igual
 * (`engine/captura.js`), así que la cuenta se hace una sola vez.
 *
 * No acumula: junta hasta llenar un pedazo y lo suelta. Guardar audio en el hilo
 * de audio esperando a que alguien lo pida es la forma de perderlo si algo se
 * traba.
 */

/**
 * Cuántas muestras se juntan antes de mandar.
 *
 * A 48 kHz son unos 85 ms. Más chico llena el puente de mensajes; más grande
 * hace que el medidor y la claqueta lleguen tarde, y la claqueta es un golpe de
 * milisegundos.
 */
const PEDAZO = 4096;

class PcmProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Int16Array(PEDAZO);
        this.escritas = 0;
    }

    process(inputs) {
        const canal = inputs[0] && inputs[0][0];
        // Sin entrada el nodo sigue vivo: el dispositivo puede estar arrancando,
        // o desconectarse y volver. Devolver `false` acá lo mataría para siempre.
        if (!canal) return true;

        for (let i = 0; i < canal.length; i++) {
            // Recortado a mano: una muestra por encima de 1 daría la vuelta y un
            // pico se oiría como un chasquido en el otro extremo de la escala.
            const v = Math.max(-1, Math.min(1, canal[i]));
            this.buffer[this.escritas++] = v < 0 ? v * 0x8000 : v * 0x7fff;

            if (this.escritas === PEDAZO) {
                // Se manda una copia porque el buffer se sigue usando; se
                // transfiere el ArrayBuffer para no copiarlo otra vez al pasar.
                const copia = this.buffer.slice(0);
                this.port.postMessage(copia, [copia.buffer]);
                this.escritas = 0;
            }
        }
        return true;
    }
}

registerProcessor('pcm-processor', PcmProcessor);
