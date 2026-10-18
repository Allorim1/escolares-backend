import { existsSync, readFileSync, statSync } from 'fs';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { database } from '../config/database';
import { CreditoUsuario } from '../models';

let inicializado = false;

/** Errores de FCM que significan que el token ya no sirve (desinstaló la app, etc.). Otros
 *  errores (credencial de otro proyecto, FCM caído...) no son culpa del token: si se
 *  borraran por eso, un problema de configuración dejaría al usuario sin tokens para siempre. */
const ERRORES_TOKEN_INVALIDO = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * Se activa solo si hay cuenta de servicio del proyecto Firebase "escolares-online" (el mismo
 * del google-services.json de la app): FIREBASE_SERVICE_ACCOUNT_PATH con la ruta al JSON, o
 * FIREBASE_SERVICE_ACCOUNT con el JSON como string. Sin eso, enviarPush() no hace nada más que
 * loguear — la app funciona igual, solo sin avisos en segundo plano. Mismo patrón que el
 * envío de emails por SMTP (creditos.controller.ts): se degrada con gracia si falta config.
 */
function inicializar(): boolean {
  // Solo la app por defecto: la de autorizaciones (con nombre) no cuenta aquí.
  if (inicializado) return getApps().some((a) => a.name === '[DEFAULT]');
  inicializado = true;

  const ruta = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!ruta && !json) {
    console.log('Push: FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT no configuradas, las notificaciones push están desactivadas.');
    return false;
  }

  try {
    const cuenta = JSON.parse(ruta ? readFileSync(ruta, 'utf8') : json!);
    initializeApp({ credential: cert(cuenta) });
    console.log(`Push: firebase-admin inicializado para el proyecto ${cuenta.project_id}.`);
    return true;
  } catch (error) {
    console.error('Push: no se pudo inicializar firebase-admin:', error);
    return false;
  }
}

let appAutorizaciones: App | null | undefined;

/**
 * La app de supervisores (ion/escolares-pro) es OTRO proyecto de Firebase ("escolares-pro"),
 * así que usa su propia cuenta de servicio en una app de firebase-admin con nombre, aparte
 * de la de "escolares-online": AUTORIZACIONES_FIREBASE_SERVICE_ACCOUNT_PATH (ruta al JSON) o
 * AUTORIZACIONES_FIREBASE_SERVICE_ACCOUNT (el JSON como string). Sin ella, la app de
 * supervisores solo recibe avisos mientras está abierta (socket.io).
 */
function appDeAutorizaciones(): App | null {
  if (appAutorizaciones !== undefined) return appAutorizaciones;
  appAutorizaciones = null;

  const ruta = process.env.AUTORIZACIONES_FIREBASE_SERVICE_ACCOUNT_PATH;
  const json = process.env.AUTORIZACIONES_FIREBASE_SERVICE_ACCOUNT;
  // Docker crea una carpeta vacía si el archivo montado no existe: por eso isFile().
  if (!json && (!ruta || !existsSync(ruta) || !statSync(ruta).isFile())) {
    console.log('Push (autorizaciones): sin AUTORIZACIONES_FIREBASE_SERVICE_ACCOUNT_PATH, la app de supervisores no recibe push en 2do plano.');
    return null;
  }
  try {
    const cuenta = JSON.parse(json || readFileSync(ruta!, 'utf8'));
    appAutorizaciones = initializeApp({ credential: cert(cuenta) }, 'autorizaciones');
    console.log(`Push (autorizaciones): firebase-admin inicializado para el proyecto ${cuenta.project_id}.`);
  } catch (error) {
    console.error('Push (autorizaciones): no se pudo inicializar firebase-admin:', error);
  }
  return appAutorizaciones;
}

/**
 * Envía a una lista de tokens de la app de supervisores (ver
 * autorizaciones-vinculos.service.ts) y devuelve los que ya no sirven para que quien los
 * guarda los borre. Canal "autorizaciones" con prioridad alta: hay una caja esperando.
 */
export async function enviarPushATokens(
  tokens: string[],
  payload: { title: string; body: string; data?: Record<string, string> },
): Promise<string[]> {
  const app = tokens.length ? appDeAutorizaciones() : null;
  if (!app) return [];
  try {
    const respuesta = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: { priority: 'high', notification: { sound: 'default', channelId: 'autorizaciones' } },
    });
    const invalidos: string[] = [];
    respuesta.responses.forEach((r, i) => {
      if (r.success) return;
      const codigo = r.error?.code ?? '';
      if (ERRORES_TOKEN_INVALIDO.has(codigo)) invalidos.push(tokens[i]);
      else console.error(`Push: FCM rechazó el envío (${codigo}):`, r.error?.message);
    });
    return invalidos;
  } catch (error) {
    console.error('Push: error enviando notificación:', error);
    return [];
  }
}

/** Manda una notificación a todos los dispositivos del usuario; limpia los tokens que ya no
 *  sirven (desinstaló la app, etc.) en vez de reintentarlos para siempre. */
export async function enviarPush(usuarioId: string, titulo: string, cuerpo: string, ruta?: string): Promise<void> {
  if (!inicializar()) return;

  const usuario = await database.getCollection<CreditoUsuario>('creditos_usuarios').findOne({ id: usuarioId });
  const tokens = usuario?.pushTokens;
  if (!tokens?.length) return;

  try {
    const respuesta = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: titulo, body: cuerpo },
      data: ruta ? { ruta } : undefined,
    });

    const tokensInvalidos: string[] = [];
    respuesta.responses.forEach((r, i) => {
      if (r.success) return;
      const codigo = r.error?.code ?? '';
      if (ERRORES_TOKEN_INVALIDO.has(codigo)) tokensInvalidos.push(tokens[i]);
      else console.error(`Push: FCM rechazó el envío (${codigo}):`, r.error?.message);
    });

    if (tokensInvalidos.length) {
      await database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $pull: { pushTokens: { $in: tokensInvalidos } } as any });
    }
  } catch (error) {
    console.error('Push: error enviando notificación:', error);
  }
}
