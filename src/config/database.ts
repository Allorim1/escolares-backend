import { MongoClient, Db, Collection, Document } from 'mongodb';

const MONGODB_URL = process.env["DB_URL"] || 'mongodb+srv://escolares_test:u0k8aKhXvjG0IzLD@escolares.p5nmwji.mongodb.net/?appName=escolares';
const DB_NAME = process.env['mongodb_dbname'] || 'main';

let dbInstance: Db | null = null;

class Database {
  private client: MongoClient | null = null;
  private db: Db | null = null;

  async connect(): Promise<boolean> {
    if (this.db) return true;

    try {
      this.client = new MongoClient(MONGODB_URL, { family: 4, connectTimeoutMS: 10000 });
      await this.client.connect();
      this.db = this.client.db(DB_NAME);
      dbInstance = this.db;
      console.log('Conectado a MongoDB');

      await this.initCollections();
      return true;
    } catch (error) {
      console.error('Error conectando a MongoDB:', error);
      console.warn('Iniciando servidor sin conexión a MongoDB (modo desarrollo)');
      return false;
    }
  }

  private async initCollections(): Promise<void> {
    if (!this.db) return;

    const collections = await this.db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);

    const requiredCollections = ['marcas', 'lineas', 'ofertas', 'users', 'products', 'costos', 'registros', 'facturas'];

    for (const name of requiredCollections) {
      if (!collectionNames.includes(name)) {
        await this.db.createCollection(name);
        console.log(`Colección '${name}' creada`);
      }
    }

    await this.seedData();
  }

  private async seedData(): Promise<void> {
    if (!this.db) return;

    const marcasCount = await this.db.collection('marcas').countDocuments();
    if (marcasCount === 0) {
      await this.db.collection('marcas').insertMany([
        { id: '1', name: 'Nike', image: '' },
        { id: '2', name: 'Adidas', image: '' },
        { id: '3', name: 'Puma', image: '' },
        { id: '4', name: 'Apple', image: '' },
        { id: '5', name: 'Samsung', image: '' },
      ]);
    }

    const lineasCount = await this.db.collection('lineas').countDocuments();
    if (lineasCount === 0) {
      await this.db.collection('lineas').insertMany([
        {
          id: '1',
          name: 'Bolsos y Cartuchera',
          image: '/lineas/BOLSOS-Y-CARTUCHERA.png',
          productIds: [],
        },
        {
          id: '2',
          name: 'Línea de Papelería',
          image: '/lineas/manchas-LINEA-DE-PAPELERIA.png',
          productIds: [],
        },
        {
          id: '3',
          name: 'Línea de Geometría',
          image: '/lineas/manchas-LIBEA-DE-GEOMETRIA.png',
          productIds: [],
        },
        {
          id: '4',
          name: 'Línea de Manualidades',
          image: '/lineas/MANCHAS-PARA-LINEA-DE-MANUALIDADES.png',
          productIds: [],
        },
        {
          id: '5',
          name: 'Línea Escolar',
          image: '/lineas/MANCHA-PARA-LINEA-ESCOLAR.png',
          productIds: [],
        },
        {
          id: '6',
          name: 'Higiene Personal',
          image: '/lineas/MANCHA-DE-HIGIENE-PERSONAL.png',
          productIds: [],
        },
        {
          id: '7',
          name: 'Línea de Oficina',
          image: '/lineas/MANCHA-LINEA-DE-OFICINA.png',
          productIds: [],
        },
        {
          id: '8',
          name: 'Línea de Escritura',
          image: '/lineas/MANCHA-LINEA-DE-ESCRITURA-V1.png',
          productIds: [],
        },
      ]);
    }
  }

  getCollection<T extends Document>(name: string): Collection<T> {
    if (!this.db) throw new Error('Base de datos no conectada');
    return this.db.collection<T>(name);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}

export const database = new Database();
