import { MongoClient, Db, Collection, Document } from 'mongodb';

const mongoUrl: string = process.env.DB_URL as string;

if (!mongoUrl) {
  throw new Error('DB_URL no configurada en variables de entorno');
}

const DB_NAME = process.env['mongodb_dbname'] || 'main';

let dbInstance: Db | null = null;

class Database {
  private client: MongoClient | null = null;
  private _db: Db | null = null;

  get db(): Db | null {
    return this._db;
  }

  async connect(): Promise<boolean> {
    if (this._db) return true;

    try {
      this.client = new MongoClient('mongodb://127.0.0.1:27017/main', { family: 4, connectTimeoutMS: 10000 });
      await this.client.connect();
      this._db = this.client.db(DB_NAME);
      dbInstance = this._db;
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
    if (!this._db) return;

    const collections = await this._db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);

    const requiredCollections = ['marcas', 'lineas', 'ofertas', 'users', 'products', 'costos', 'registros', 'facturas', 'home'];

    for (const name of requiredCollections) {
      if (!collectionNames.includes(name)) {
        await this._db.createCollection(name);
        console.log(`Colección '${name}' creada`);
      }
    }

    await this.seedData();
  }

  private async seedData(): Promise<void> {
    if (!this._db) return;

    const marcasCount = await this._db.collection('marcas').countDocuments();
    if (marcasCount === 0) {
      await this._db.collection('marcas').insertMany([
        { id: '1', name: 'Nike', image: '' },
        { id: '2', name: 'Adidas', image: '' },
        { id: '3', name: 'Puma', image: '' },
        { id: '4', name: 'Apple', image: '' },
        { id: '5', name: 'Samsung', image: '' },
      ]);
    }

    const lineasCount = await this._db.collection('lineas').countDocuments();
    if (lineasCount === 0) {
      await this._db.collection('lineas').insertMany([
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
    if (!this._db) throw new Error('Base de datos no conectada');
    return this._db.collection<T>(name);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this._db = null;
    }
  }
}

export const database = new Database();
