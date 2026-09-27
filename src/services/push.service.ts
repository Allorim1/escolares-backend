import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { database } from '../config/database';
import { CreditoUsuario } from '../models';

let inicializado = false;

/**
 * Se activa solo si FIREBASE_SERVICE_ACCOUNT está configurada (el JSON de la cuenta de
 * servicio del proyecto Firebase, como string). Sin eso, enviarPush() no hace nada más que
 * loguear — la app funciona igual, solo sin avisos en segundo plano. Mismo patrón que el
 * envío de emails por SMTP (creditos.controller.ts): se degrada con gracia si falta config.
 */
function inicializar(): boolean {
  if (inicializado) return getApps().length > 0;
  inicializado = true;

  const credencial = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credencial) {
    console.log('Push: FIREBASE_SERVICE_ACCOUNT no configurada, las notificaciones push están desactivadas.');
    return false;
  }

  try {
    initializeApp({ credential: cert(JSON.parse(credencial)) });
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

    const tokensInvalidos = respuesta.responses
      .map((r, i) => (!r.success ? tokens[i] : null))
      .filter((t): t is string => t !== null);

    if (tokensInvalidos.length) {
      await database
        .getCollection<CreditoUsuario>('creditos_usuarios')
        .updateOne({ id: usuarioId }, { $pull: { pushTokens: { $in: tokensInvalidos } } as any });
    }
  } catch (error) {
    console.error('Push: error enviando notificación:', error);
  }
}
