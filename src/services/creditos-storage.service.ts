import fs from 'fs';
import path from 'path';
import { CreditoDocumentoArchivo } from '../models';

// Misma carpeta que usan las imágenes de productos (products.routes.ts): la que ya
// tiene permisos de escritura otorgados en el servidor y la que persiste el volumen
// de Docker, en vez de una ruta nueva sin aprovisionar.
const uploadsRoot = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.resolve(process.cwd(), 'uploads');

/**
 * Los documentos de verificación (cédula, selfie, comprobantes) viven dentro de
 * `uploads/creditos/`, pero esa subcarpeta se bloquea explícitamente en server.ts antes
 * de llegar a express.static: nunca se sirve como el resto de `uploads/`. Solo se leen
 * desde el controlador, que verifica que quien las pide sea el propio usuario o un
 * admin con permiso de créditos.
 */
export const PRIVATE_UPLOADS_ROOT = path.join(uploadsRoot, 'creditos');

const EXTENSION_POR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export function extensionParaMime(mimetype: string): string {
  return EXTENSION_POR_MIME[mimetype] || '';
}

export function guardarDocumento(
  usuarioId: string,
  campo: string,
  file: { buffer: Buffer; mimetype: string; size: number },
): CreditoDocumentoArchivo {
  const carpetaUsuario = path.join(PRIVATE_UPLOADS_ROOT, usuarioId);
  fs.mkdirSync(carpetaUsuario, { recursive: true });

  const nombreArchivo = `${campo}-${Date.now()}${extensionParaMime(file.mimetype)}`;
  const rutaAbsoluta = path.join(carpetaUsuario, nombreArchivo);
  fs.writeFileSync(rutaAbsoluta, file.buffer);

  return {
    path: path.join(usuarioId, nombreArchivo),
    mimetype: file.mimetype,
    size: file.size,
    subidoEn: new Date(),
  };
}

/** Ruta absoluta a partir de la ruta relativa guardada en Mongo, validando que no se salga de la carpeta. */
export function rutaAbsolutaSegura(rutaRelativa: string): string | null {
  const resuelta = path.join(PRIVATE_UPLOADS_ROOT, rutaRelativa);
  if (!resuelta.startsWith(PRIVATE_UPLOADS_ROOT)) return null;
  return resuelta;
}
