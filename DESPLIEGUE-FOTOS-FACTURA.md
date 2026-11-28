# Despliegue: foto de factura desde el celular

Este paquete agrega al relay `/api/autorizaciones` la solicitud de foto para el módulo
**Facturas Escaneadas** de EscolaresPRO. No hay migración de base de datos: la petición y el JPEG
viven en memoria solo unos minutos, igual que las solicitudes de pantalla.

Archivo: `despliegue-fotos-factura.zip` (contiene `dist/`, `package.json` y `package-lock.json`).

## En el servidor (test.escolaresonline.com)

1. Entrar al directorio donde está la API y guardar una copia de lo que hay ahora:

   ```bash
   cd /var/www/escolares-backend        # <-- ruta real de la API en el servidor
   cp -r dist dist.bak-fotos-factura
   ```

2. Subir el ZIP y descomprimirlo **en la raíz de la API** (no dentro de `dist`):

   ```bash
   unzip -o despliegue-fotos-factura.zip -d /var/www/escolares-backend
   ```

   No hace falta `npm install`: no se agregaron dependencias nuevas.

3. Reiniciar el servicio. Si usa PM2 (importante: **una sola instancia**, porque las solicitudes
   están en memoria, igual que las autorizaciones actuales):

   ```bash
   pm2 restart escolares-api && pm2 save
   pm2 list        # debe mostrar 1 instancia, no cluster
   ```

   Si usa systemd:

   ```bash
   sudo systemctl restart escolares-api
   sudo systemctl status escolares-api
   ```

4. Comprobar que el relay respondió (el endpoint nuevo no aparece en Swagger, pero está montado):

   ```bash
   curl -i -H "x-api-key: LA_CLAVE_DE_LA_TIENDA" \
     https://test.escolaresonline.com/api/autorizaciones/caja/fotos-factura/prueba
   ```

   Debe dar **404 con `{"message":"Esa solicitud de foto ya no existe"}`** (no 404 de Express ni
   502). Eso confirma que la ruta nueva está activa.

5. Probar desde la caja: Facturas Escaneadas → proveedor → **＋ Agregar factura** → escribir el
   número → elegir celular en **📷 Tomar foto con celular**. El celular debe mostrar el aviso
   **"📷 Foto de factura"**, abrir la cámara y, al enviar, la foto aparece seleccionada en la bandeja.

## Rutas nuevas

- `POST /api/autorizaciones/caja/fotos-factura` — la caja pide la foto (`usuarioId`, `proveedor`, `numeroFactura`, `solicitante`).
- `GET /api/autorizaciones/caja/fotos-factura/:id` — estado mientras espera.
- `GET /api/autorizaciones/caja/fotos-factura/:id/archivo` — descarga del JPEG/PNG/WebP.
- `DELETE /api/autorizaciones/caja/fotos-factura/:id` — cancela la solicitud.
- `GET /api/autorizaciones/movil/fotos-factura` — pedidos pendientes al conectar la app.
- `POST /api/autorizaciones/movil/fotos-factura/:id/foto` — sube la foto cruda.
- `POST /api/autorizaciones/movil/fotos-factura/:id/rechazar` — no tomó la foto.

Eventos socket en `/autorizaciones`: `foto:pedida` y `foto:cancelada`.
Push FCM: `data.tipo = 'foto_factura'`.
