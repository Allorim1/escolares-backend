import { MongoClient } from 'mongodb';
import path from 'path';
import fs from 'fs';
import { processImageFile } from '../src/services/image-variants.service';

const uri = process.env.DB_URL || process.env.MONGO_URL || 'mongodb://localhost:27017';
const dbName = process.env.DB_NAME || 'escolares';
const uploadsRoot = process.env.UPLOADS_PATH ? path.resolve(process.env.UPLOADS_PATH) : path.resolve(process.cwd(), 'uploads');

function toLocal(fileUrl?: string|null) {
  if (!fileUrl) return null;
  const m = String(fileUrl).match(/\/api\/uploads\/(.+)$/);
  if (!m) return null;
  return path.join(uploadsRoot, m[1].replace(/\//g, path.sep));
}

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('products');
  const cursor = col.find({ $or: [{ image: { $type: 'string', $ne: '' } }, { 'imagenes.url': { $exists: true } }] });
  let updated = 0;
  while (await cursor.hasNext()) {
    const p:any = await cursor.next();
    let changed = false;
    const images: string[] = Array.isArray(p.images) && p.images.length ? p.images : (p.image ? [p.image] : []);
    const thumbs: string[] = Array.isArray(p.imageThumbs) ? [...p.imageThumbs] : [];
    const mediums: string[] = Array.isArray(p.imageMediums) ? [...p.imageMediums] : [];
    for (let i=0;i<images.length;i++) {
      const img = images[i]; const thumb = thumbs[i]; const med = mediums[i];
      if (thumb && med) continue;
      const local = toLocal(med || thumb || img);
      if (!local || !fs.existsSync(local)) continue;
      try {
        const base = path.parse(local).name.replace(/-(thumb|medium|main)$/,'');
        const folder = path.dirname(path.relative(uploadsRoot, local)).split(path.sep).join('/');
        const out = await processImageFile({ inputPath: local, folder, baseName: base });
        images[i] = out.image; thumbs[i] = out.imageThumb || out.image; mediums[i] = out.imageMedium || out.image; changed = true;
      } catch (e) { console.warn('skip', p.id, img, e); }
    }
    if (changed) {
      const main = Number(p.imageMainIndex || 0);
      await col.updateOne({ _id: p._id }, { $set: { images, imageThumbs: thumbs, imageMediums: mediums, image: images[main] || images[0] || p.image, imageThumb: thumbs[main] || thumbs[0] || p.imageThumb, imageMedium: mediums[main] || mediums[0] || p.imageMedium, updatedAt: new Date() } });
      updated++;
      console.log('updated', p.id || p._id);
    }
  }
  console.log('done', { updated });
  await client.close();
}
run().catch(e=>{ console.error(e); process.exit(1); });
