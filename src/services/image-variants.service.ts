import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export interface ImageVariants {
  image: string;
  imageThumb?: string;
  imageMedium?: string;
  imageHash?: string;
}

const uploadsRoot = process.env.UPLOADS_PATH
  ? path.resolve(process.env.UPLOADS_PATH)
  : path.resolve(process.cwd(), 'uploads');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeBaseName(name: string) {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'img';
}

function removeOldVariants(dir: string, prefix: string, keep: Set<string>) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix) && !keep.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

async function writeWebpVariant(input: Buffer, outPath: string, width: number, quality: number) {
  await sharp(input)
    .rotate()
    .resize({ width, withoutEnlargement: true, fit: 'inside' })
    .webp({ quality, effort: 4 })
    .toFile(outPath);
}

export async function processImageBuffer(opts: {
  buffer: Buffer;
  folder: string; // subfolder inside uploads
  baseName: string;
  hashHint?: string | null;
}): Promise<ImageVariants> {
  const folder = opts.folder.replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(uploadsRoot, folder);
  ensureDir(dir);
  const hash = (opts.hashHint && /^[a-f0-9]{8,64}$/i.test(opts.hashHint))
    ? opts.hashHint.toLowerCase().slice(0, 16)
    : crypto.createHash('sha1').update(opts.buffer).digest('hex').slice(0, 12);
  const base = safeBaseName(opts.baseName);
  const thumbName = `${base}-${hash}-thumb.webp`;
  const mediumName = `${base}-${hash}-medium.webp`;
  const mainName = `${base}-${hash}.webp`;
  const thumbPath = path.join(dir, thumbName);
  const mediumPath = path.join(dir, mediumName);
  const mainPath = path.join(dir, mainName);

  await Promise.all([
    writeWebpVariant(opts.buffer, thumbPath, 480, 72),
    writeWebpVariant(opts.buffer, mediumPath, 1200, 78),
    writeWebpVariant(opts.buffer, mainPath, 1600, 80),
  ]);

  removeOldVariants(dir, `${base}-`, new Set([thumbName, mediumName, mainName]));

  const urlBase = `/api/uploads/${folder}`;
  return {
    image: `${urlBase}/${mainName}`,
    imageThumb: `${urlBase}/${thumbName}`,
    imageMedium: `${urlBase}/${mediumName}`,
    imageHash: hash,
  };
}

export async function processDataUrlImage(opts: {
  dataUrl: string;
  folder: string;
  baseName: string;
  hashHint?: string | null;
  maxBytes?: number;
}): Promise<ImageVariants> {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(opts.dataUrl || '');
  if (!m) throw new Error('Imagen inválida');
  const buffer = Buffer.from(m[2], 'base64');
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  if (!buffer.length || buffer.length > maxBytes) throw new Error('La imagen está vacía o excede el tamaño máximo');
  return processImageBuffer({ buffer, folder: opts.folder, baseName: opts.baseName, hashHint: opts.hashHint });
}

export function deleteImageVariantsByPrefix(folder: string, baseName: string) {
  const dir = path.join(uploadsRoot, folder.replace(/[^a-zA-Z0-9_-]/g, ''));
  removeOldVariants(dir, `${safeBaseName(baseName)}-`, new Set());
}

export function resolveUploadPathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('?')[0];
  const idx = clean.indexOf('/api/uploads/');
  const rel = idx >= 0 ? clean.slice(idx + '/api/uploads/'.length) : (clean.startsWith('/uploads/') ? clean.slice('/uploads/'.length) : null);
  if (!rel) return null;
  const abs = path.resolve(uploadsRoot, rel);
  if (!abs.startsWith(path.resolve(uploadsRoot))) return null;
  return abs;
}
