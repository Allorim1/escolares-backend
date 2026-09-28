import { readFileSync } from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
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
  if (inicializado) return getApps().length > 0;
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
