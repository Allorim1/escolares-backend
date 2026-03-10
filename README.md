# Escolares API - Backend

API REST para la aplicación Escolares desarrollada con Express.js y MongoDB.

## Requisitos

- Node.js 20+
- npm 10+
- MongoDB (local o Atlas)

## Desarrollo local

```bash
cd server
npm install
npm run dev
```

La API estará disponible en `http://localhost:3000`

## Variables de entorno

Crear archivo `.env` en la raíz del proyecto:

```env
PORT=3000
NODE_ENV=development
DB_URL=mongodb://localhost:27017/escolares
```

O usar MongoDB Atlas:

```env
DB_URL=mongodb+srv://<usuario>:<password>@<cluster>/escolares
```

## Scripts

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Inicia el servidor en modo desarrollo |
| `npm run build` | Compila el código TypeScript |
| `npm start` | Inicia el servidor en producción |
| `npm run swagger` | Genera documentación Swagger |

## Docker

### Build de imagen

```bash
docker build -t escolares-api .
```

### Run con Docker Compose

```bash
docker-compose up api
```

La API estará disponible en `http://localhost:3000`

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/marcas` | Listar marcas |
| GET | `/api/lineas` | Listar líneas |
| GET | `/api/ofertas` | Listar ofertas |
| POST | `/api/auth/register` | Registrar usuario |
| POST | `/api/auth/login` | Iniciar sesión |
| GET | `/api/tasas` | Obtener tasas del dólar |
| POST | `/api/costos` | Guardar costos |
| GET | `/api/costos` | Listar costos |

## Documentación Swagger

Acceder a `http://localhost:3000/api-docs` cuando el servidor esté corriendo.

## Estructura

```
server/
├── src/
│   ├── config/          # Configuración de DB y Swagger
│   ├── controllers/     # Controladores de rutas
│   ├── models/          # Modelos de MongoDB
│   ├── routes/          # Definición de rutas
│   └── server.ts        # Punto de entrada
└── dist/                # Compilación TypeScript
```
