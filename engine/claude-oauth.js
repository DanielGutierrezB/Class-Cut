'use strict';
/**
 * claude-oauth.js — Iniciar sesión con Claude para no copiar claves a mano.
 *
 * El flujo es el "modo consola" del OAuth de Anthropic (código de autorización
 * con PKCE): se abre el navegador, el editor autoriza con su cuenta, pega el
 * código que le muestran, y con ese permiso la app **crea una API key** en su
 * consola y la guarda en el Llavero. A partir de ahí todo funciona con una
 * clave normal — sin tokens que refrescar ni sesiones que se venzan.
 *
 * Se pide el código PEGADO en vez de levantar un servidor local de callback:
 * son dos pasos visibles que funcionan igual con cualquier navegador, y no hay
 * puerto que pedir ni firewall que explique por qué no volvió nadie.
 *
 * PKCE en dos palabras: se manda el hash de un secreto al autorizar y el
 * secreto entero al canjear, así un código interceptado no sirve sin el
 * secreto que nunca viajó.
 */

const crypto = require('crypto');

// El cliente público del ecosistema de herramientas de línea de comandos de
// Anthropic; el flujo de consola existe para esto: autorizar la creación de
// una clave propia, que es lo único que esta app se lleva.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTORIZAR = 'https://console.anthropic.com/oauth/authorize';
const REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
// El canje vive en la plataforma nueva; el host viejo queda de repuesto para
// no romper si el despliegue va por partes.
const CANJES = [
    'https://platform.claude.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token'
];
const CREAR_CLAVE = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';

const base64url = buffer => buffer.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Arma la URL para el navegador y el secreto que hay que retener para el canje.
 * @returns {{url: string, verifier: string}}
 */
function empezar() {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
        code: 'true',
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT,
        scope: 'org:create_api_key user:profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: verifier
    });
    return { url: `${AUTORIZAR}?${params}`, verifier };
}

/**
 * El código que el editor pega viene como "código#estado" (o una URL que lo
 * trae). Se separa y se comprueba que el estado sea el nuestro: un código de
 * otra sesión no se canjea.
 */
function partirCodigo(pegado, verifier) {
    const crudo = String(pegado || '').trim();
    if (!crudo) return { error: 'No llegó ningún código.' };

    let texto = crudo;
    // Si pegaron la URL entera, el código viaja en la consulta.
    if (/^https?:\/\//i.test(crudo)) {
        try {
            const url = new URL(crudo);
            texto = url.searchParams.get('code') || '';
            const estado = url.searchParams.get('state');
            if (estado) texto = `${texto}#${estado}`;
        } catch (err) {
            return { error: 'Eso parece una URL pero no se pudo leer.' };
        }
    }

    const [code, estado] = texto.split('#');
    if (!code) return { error: 'El código llegó vacío.' };
    if (estado && verifier && estado !== verifier) {
        return { error: 'El código es de otra sesión de inicio: abrí el navegador de nuevo y usá el último.' };
    }
    return { code, estado: estado || verifier };
}

async function canjear(code, estado, verifier) {
    let ultimo = 'no se pudo canjear el código';
    for (const url of CANJES) {
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'authorization_code',
                    code,
                    state: estado,
                    client_id: CLIENT_ID,
                    redirect_uri: REDIRECT,
                    code_verifier: verifier
                }),
                signal: AbortSignal.timeout(20000)
            });
        } catch (err) {
            ultimo = `no se pudo hablar con Anthropic: ${err.message}`;
            continue;
        }
        if (!response.ok) {
            const detalle = await response.text().catch(() => '');
            ultimo = `Anthropic contestó ${response.status} al canjear. ${detalle.slice(0, 160)}`.trim();
            // Un 4xx del host bueno no se arregla probando el host viejo, pero
            // probarlo tampoco rompe nada y sí salva el caso del despliegue a
            // medias.
            continue;
        }
        try {
            return { tokens: await response.json() };
        } catch (err) {
            ultimo = 'el canje devolvió algo que no es JSON';
        }
    }
    return { error: ultimo };
}

async function crearClave(accessToken) {
    let response;
    try {
        response = await fetch(CREAR_CLAVE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(20000)
        });
    } catch (err) {
        return { error: `no se pudo crear la clave: ${err.message}` };
    }
    if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        return { error: `Anthropic contestó ${response.status} al crear la clave. ${detalle.slice(0, 160)}`.trim() };
    }
    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        return { error: 'la creación de la clave devolvió algo que no es JSON' };
    }
    const clave = payload.raw_key || payload.api_key || payload.key;
    if (!clave) return { error: 'Anthropic no devolvió ninguna clave.' };
    return { clave };
}

/**
 * El flujo entero después de pegar el código: canjear y crear la clave.
 * Nunca lanza: contesta `{clave}` o `{error}`.
 */
async function terminar(pegado, verifier) {
    const partido = partirCodigo(pegado, verifier);
    if (partido.error) return partido;

    const canje = await canjear(partido.code, partido.estado, verifier);
    if (canje.error) return canje;

    const token = canje.tokens && canje.tokens.access_token;
    if (!token) return { error: 'El canje no trajo ningún token.' };

    return crearClave(token);
}

module.exports = { empezar, partirCodigo, terminar, CLIENT_ID };
