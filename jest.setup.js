// src/config/database.ts lanza un error al importarse si falta DB_URL (para fallar rápido en
// producción). En tests unitarios de funciones puras que ni siquiera tocan la base de datos,
// esto solo hace falta para que el import no explote.
process.env.DB_URL = process.env.DB_URL || 'mongodb://localhost:27017/test';
