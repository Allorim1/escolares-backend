import { ObjectId } from 'mongodb';

export interface Marca {
  _id?: string;
  id: string;
  name: string;
  image?: string;
}

export interface Linea {
  _id?: string;
  id: string;
  name: string;
  image: string;
  productIds: number[];
}

export interface Oferta {
  _id?: string;
  productId: string | number;
  precioOferta: number;
}

export interface User {
    _id?: string;
    id: string;
    username: string;
    email: string;
    password?: string;
    isAdmin: boolean;
    rol?: 'root' | 'usuario' | 'repartidor';
    rolId?: string;
    deliveryPersonId?: string;
    nombreCompleto?: string;
    apellido?: string;
    direccion?: string;
    telefono?: string;
    cedula?: string;
    tipoPersona?: 'natural' | 'juridica';
    comentarios?: string;
    direcciones?: Direccion[];
    metodosPago?: MetodoPago[];
    supervisorKey?: string;
    activo?: boolean;
  }

export interface Direccion {
   id: string;
   nombre: string;
   direccion?: string;
   alias?: string;
   calle?: string;
   ciudad?: string;
   estado?: string;
   codigoPostal?: string;
   principal?: boolean;
   // Google Maps fields
   latitud?: number;
   longitud?: number;
   placeId?: string;
  }

export interface MetodoPago {
  id: string;
  alias: string;
  tipo: 'zelle' | 'efectivo' | 'transferencia' | 'pago_movil';
  titular?: string;
  referencia?: string;
  banco?: string;
  telefono?: string;
  principal?: boolean;
}

export interface Color {
  id: string;
  nombre: string;
  codigoHex: string;
  imagen: string; // Imagen requerida para cada color
}

export interface Product {
  _id?: string;
  id: number;
  name: string;
  description: string;
  price: number;
  image: string;
  images?: string[];
  marcaId?: string;
  lineaId?: string;
  categoriaId?: string;
  colorido?: boolean;
  colores?: Color[];
  codigo?: string;
  views: number;
  purchases: number;
}

export interface InvProducto {
  _id?: string;
  codigo: string;
  nombre: string;
  descrip?: string;
  costo?: number;
  precio?: number;
  iva?: number;
  stock?: number;
  codgrupo1?: string;
  borrado?: number;
}

export interface ProductCategoria {
  _id?: string;
  id: string;
  nombre: string;
  descripcion?: string;
  imagen?: string;
  orden: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  productId: number | string;
  title: string;
  price: number;
  quantity: number;
  image: string;
}

export interface Order {
  _id?: string;
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  nombre: string;
  cedula: string;
  telefono: string;
  direccion: string;
  placeId?: string;
  direccionCompleta?: string;
  latitud?: number;
  longitud?: number;
  metodoPago: string;
  referencia: string;
  fotoComprobante?: string;
  facturaImage?: string;
  productImage?: string;
  bancoEmisor?: string;
  cedulaTitular?: string;
  correo?: string;
  status: OrderStatus;
  historial: OrderHistorial[];
  autorizadoPor?: string;
  autorizadoNombre?: string;
  deliveryPersonId?: string;
  deliveryPersonName?: string;
  repartidorUbicacion?: {
    lat: number;
    lng: number;
    timestamp: Date;
  };
  tiempoEstimadoLlegada?: string;
  propina?: number;
  comision?: number;
  createdAt: Date;
  updatedAt: Date;
  mensajes?: OrderMessage[];
}

export type OrderStatus = 'confirmar' | 'pendiente' | 'procesando' | 'procesado' | 'enviado' | 'entregado' | 'cancelado';

export interface OrderHistorial {
  status: OrderStatus;
  fecha: Date;
  observaciones?: string;
}

export interface OrderMessage {
  _id?: ObjectId;
  orderId: string;
  emisorId: string;
  emisorNombre: string;
  emisorRol: string;
  mensaje: string;
  leido: boolean;
  fecha: Date;
}

export interface Permiso {
  id: string;
  nombre: string;
  descripcion: string;
  modulo: string;
}

export interface Rol {
  _id?: string;
  id: string;
  nombre: string;
  descripcion: string;
  permisos: string[];
  esDefault: boolean;
  esVendedor: boolean;
  comision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoriaMenu {
  _id?: string;
  id: string;
  nombre: string;
  expanded: boolean;
  orden: number;
  items: CategoriaItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryPerson {
    _id?: string;
    id: string;
    nombre: string;
    telefono?: string;
    activo: boolean;
    userId?: string;
    fotoDNI?: string; // Base64 data URI (data:image/...;base64,...)
    // Google Maps fields
   placeId?: string;
   direccionCompleta?: string;
   latitud?: number;
   longitud?: number;
   ultimaUbicacion?: {
     lat: number;
     lng: number;
     timestamp: Date;
   };
   createdAt: Date;
   updatedAt: Date;
  }

export interface CategoriaItem {
  label: string;
  route: string;
  to: string;
  permiso?: string;
}

export interface RedSocial {
  _id?: string;
  id: string;
  plataforma: string;
  usuario: string;
  token: string;
  habilitada: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MensajeRedSocial {
  _id?: string;
  id: string;
  plataforma: string;
  usuario: string;
  texto: string;
  fecha: Date;
  leido: boolean;
  respondido: boolean;
  respuesta?: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video' | 'sticker';
  mediaUrl?: string;
  mediaCaption?: string;
  mediaFilename?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RespuestaAutomatica {
  _id?: string;
  id: string;
  palabraClave: string;
  respuesta: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificacionRedSocial {
   _id?: string;
   id: string;
   tipo: string;
   canal: string;
   activa: boolean;
   createdAt: Date;
   updatedAt: Date;
 }

  export interface UserNotificacion {
    _id?: string;
    id: string;
    userId: string;
    noticiaId: string;
    leido: boolean;
    createdAt: Date;
    updatedAt: Date;
  }

  export interface UserSession {
    _id?: string;
    id: string;
    userId: string;
    username: string;
    email: string;
    rol: string;
    ip?: string;
    userAgent?: string;
    device?: string;
    browser?: string;
    os?: string;
    location?: string;
    active: boolean;
    createdAt: Date;
    lastActive: Date;
    expiresAt?: Date;
    closedReason?: 'logout' | 'expired' | 'admin' | 'user';
  }

  export interface Supervisor {
    _id?: string;
    id: string;
    nombre: string;
    apellido?: string;
    cedula?: string;
    telefono?: string;
    planta?: string;
    createdAt: Date;
    updatedAt: Date;
  }

  export interface ContrasenaAuditoria {
    _id?: string;
    id: string;
    userId: string;
    username: string;
    email: string;
    contrasena: string;
    rol: string;
    fecha: Date;
    accion: 'crear' | 'cambiar';
  }

  /**
   * Créditos Escolares — usuarios y datos de la app Escolares Online (Android).
   * Son cuentas independientes de `User` (tienda web): se registran con teléfono,
   * no con usuario/email, y no comparten sesión ni permisos con el panel admin.
   */
  export type CreditoEstadoVerificacion = 'sin_verificar' | 'en_revision' | 'verificado' | 'rechazado';

  export const CREDITO_DOCUMENTOS = [
    'fotoComprobantePago',
    'fotoCedula',
    'fotoConstanciaTrabajo',
    'fotoReferenciaBancaria',
    'fotoSoporteBeneficio',
    'fotoSelfie',
  ] as const;

  export type CreditoDocumentoCampo = (typeof CREDITO_DOCUMENTOS)[number];

  export interface CreditoDocumentoArchivo {
    path: string; // ruta relativa dentro de private-uploads/creditos, nunca pública
    mimetype: string;
    size: number;
    subidoEn: Date;
  }

  export interface CreditoVerificacion {
    nombreCompleto: string;
    documento: string; // número de cédula
    fechaNacimiento: string;
    direccion: string;
    ciudad: string;
    referenciaNombre: string;
    referenciaTelefono: string;
    ocupacion: string;
    lugarTrabajo?: string;
    documentos: Partial<Record<CreditoDocumentoCampo, CreditoDocumentoArchivo>>;
    enviadoEn: Date;
    revisadoPor?: string;
    revisadoEn?: Date;
    motivoRechazo?: string;
  }

  export interface CreditoUbicacion {
    lat: number;
    lng: number;
    actualizadaEn: Date;
  }

  export interface CreditoUsuario {
    _id?: string;
    id: string;
    nombre: string;
    telefono: string;
    email?: string;
    passwordHash: string;
    nivel: number;
    /** Cuotas pagadas en total (histórico acumulado), lo que sube de nivel automáticamente
     *  según CreditoReglas.cuotasParaNivel. */
    cuotasPagadasTotal?: number;
    /** Crédito adicional otorgado a mano a este cliente puntual, por encima de lo que le
     *  daría su nivel. Ver módulo "Ampliar Crédito" del panel admin. */
    extensionCredito?: number;
    status: CreditoEstadoVerificacion;
    tutorialVisto: boolean;
    verificacion?: CreditoVerificacion;
    /**
     * Última posición reportada por el teléfono al aceptar una compra o declarar un pago
     * (verificación puntual de presencia, no un rastreo continuo). Ver módulo "Ubicación de
     * clientes" del panel admin.
     */
    ultimaUbicacion?: CreditoUbicacion;
    /** Presente mientras el cliente tiene una solicitud de eliminación de cuenta sin resolver.
     *  No se elimina de una vez: si tiene un crédito activo con saldo pendiente, el staff debe
     *  rechazarla hasta que lo salde. */
    solicitudEliminacion?: {
      motivo?: string;
      solicitadaEn: Date;
      estado: 'pendiente' | 'rechazada';
      motivoRechazo?: string;
    };
    /** Presente cuando el staff aprobó la eliminación: la cuenta queda anonimizada (nombre,
     *  teléfono, email, documentos y contraseña ya no son los reales) y no puede volver a
     *  iniciar sesión. El historial de facturas/pagos se conserva para contabilidad. */
    eliminadoEn?: Date;
    /** El cliente no tiene email registrado, así que "olvidé mi contraseña" no puede mandarle
     *  un OTP: queda esta marca para que el staff lo llame y le restablezca la contraseña a
     *  mano desde el panel (ver 'Cuentas por restablecer'). */
    solicitudRestablecimiento?: { solicitadaEn: Date };
    /** Tokens FCM de los dispositivos donde inició sesión (puede tener más de uno). Vacío si
     *  nunca dio permiso de notificaciones o si las notificaciones push no están configuradas
     *  en el servidor (ver services/push.service.ts). */
    pushTokens?: string[];
    createdAt: Date;
    updatedAt: Date;
  }

  export type CreditoFrecuencia = 'semanal' | 'quincenal' | 'mensual';

  /**
   * 'pendiente_aceptacion': el staff armó la factura (o el cliente la generó vía QR) y
   * espera que el cliente la acepte o la rechace desde la app. 'esperando_pago': el
   * cliente ya eligió cuánto paga de inicial y confirmó, pero el staff todavía no marcó
   * que recibió ese pago (efectivo/transferencia) — el crédito no arranca hasta entonces.
   * 'solicitado' sigue siendo el crédito libre (sin producto) que el propio usuario pide
   * desde la app.
   */
  export type CreditoSolicitudStatus =
    | 'pendiente_aceptacion'
    | 'esperando_pago'
    | 'solicitado'
    | 'activo'
    | 'pagado'
    | 'rechazado';

  export interface CreditoFactura {
    numero: string;
    emitidaEn: Date;
    subtotal: number;
    iva: number;
    total: number;
  }

  /** Línea de una compra armada por el staff desde inv_productos (snapshot al momento de la venta). */
  export interface CreditoSolicitudItem {
    productoId: string;
    codigo: string;
    nombre: string;
    precioUnitario: number;
    cantidad: number;
    ivaPorcentaje: number;
  }

  export interface CreditoSolicitud {
    _id?: string;
    id: string;
    usuarioId: string;
    monto: number;
    cuotas: number;
    frecuencia: CreditoFrecuencia;
    cuotaMonto: number;
    total: number;
    proposito: string;
    status: CreditoSolicitudStatus;
    productoId?: string;
    productoNombre?: string;
    /** Presente cuando la compra la armó el staff con productos de inv_productos. */
    items?: CreditoSolicitudItem[];
    registradoPor?: string;
    factura?: CreditoFactura;
    /** Cuánto eligió pagar de inicial (mínimo factura.iva); presente desde 'esperando_pago'. */
    pagoInicial?: number;
    /** Solo en compras armadas manualmente por root (sin QR): el inicial ya viene fijo y el
     *  cliente solo puede aceptarlo o rechazarlo, sin elegir otro monto. */
    pagoInicialAsignado?: number;
    /**
     * Cuánto se ha pagado en total de factura.total (arranca en pagoInicial al activarse el
     * crédito). El crédito disponible del cliente se recupera a medida que esto sube:
     * disponible = factura.total - montoPagado en vez del monto original completo.
     */
    montoPagado?: number;
    cuotasPagadas: number;
    createdAt: Date;
    activadoEn?: Date;
    revisadoPor?: string;
    motivoRechazo?: string;
  }

  /**
   * Un abono a una factura ya activa (cuota o "otro monto"), pagado por Pago Móvil o
   * Transferencia fuera de la app. El cliente declara que lo hizo; el staff lo verifica
   * contra el estado de cuenta del banco antes de que se refleje en la solicitud.
   */
  export type CreditoPagoStatus = 'pendiente_verificacion' | 'verificado' | 'rechazado';
  export type CreditoMetodoPago = 'pago_movil' | 'transferencia';

  export interface CreditoPago {
    _id?: string;
    id: string;
    solicitudId: string;
    usuarioId: string;
    monto: number;
    metodo: CreditoMetodoPago;
    status: CreditoPagoStatus;
    createdAt: Date;
    verificadoPor?: string;
    verificadoEn?: Date;
    motivoRechazo?: string;
    /** Pago declarado desde la app con sus datos (Pago Móvil o transferencia): se verificó
     *  en el momento contra la API de conciliación de BDV (ver creditos.controller.ts > crearPago). */
    datosPago?: CreditoDatosPagoBdv;
  }

  export interface CreditoDatosPagoBdv {
    cedulaPagador: string;
    telefonoPagador: string;
    /** Últimos 6 dígitos, tal como los pide la app. */
    referencia: string;
    /** YYYY-MM-DD */
    fechaPago: string;
    bancoOrigen: string;
    /** Bolívares realmente pagados (lo que se consultó a BDV). */
    importeBs: number;
    /** Tasa BCV con la que se comprobó que importeBs corresponde a `monto` en $. */
    tasa: number;
  }

  export type CreditoTicketEstado = 'abierto' | 'en_proceso' | 'cerrado';
  /** 'pago_atrasado': lo abre el staff contra un cliente con una cuota vencida hace más de 7
   *  días (ver diasAtrasoDe en creditos-reglas.service). 'consulta': lo abre el cliente por
   *  cualquier otro motivo desde "Centro de ayuda". */
  export type CreditoTicketTipo = 'consulta' | 'pago_atrasado';
  export type CreditoTicketAutor = 'cliente' | 'staff';

  export interface CreditoTicketMensaje {
    autor: CreditoTicketAutor;
    autorNombre?: string;
    texto: string;
    createdAt: Date;
  }

  export interface CreditoTicket {
    _id?: string;
    id: string;
    usuarioId: string;
    /** Presente cuando el ticket es sobre una compra puntual (típicamente pago_atrasado). */
    solicitudId?: string;
    tipo: CreditoTicketTipo;
    asunto: string;
    estado: CreditoTicketEstado;
    creadoPor: CreditoTicketAutor;
    mensajes: CreditoTicketMensaje[];
    createdAt: Date;
    actualizadoEn: Date;
    cerradoEn?: Date;
  }

  export interface CreditoProducto {
    _id?: string;
    id: string;
    nombre: string;
    descripcion: string;
    categoria: string;
    precio: number;
    icono: string;
    activo: boolean;
    createdAt: Date;
    updatedAt: Date;
  }

  /** Documento único (id fijo 'reglas') con los parámetros del negocio de crédito. */
  export interface CreditoReglas {
    _id?: string;
    id: 'reglas';
    nivelBase: number;
    factorNivel: number;
    nivelMaximo: number;
    cuotas: number;
    diasEntreCuotas: number;
    tasaQuincenal: number;
    ivaTasa: number;
    montoMinimo: number;
    categorias: string[];
    /** Nombre configurable de cada nivel (índice 0 = nivel 1, ...). */
    nombresNiveles?: string[];
    /**
     * Cuotas que hay que pagar, estando en cada nivel, para subir al siguiente (longitud
     * nivelMaximo - 1). cuotasParaNivel[0] = cuotas para pasar de nivel 1 a 2,
     * cuotasParaNivel[1] = cuotas para pasar de 2 a 3, etc. Se compara contra
     * CreditoUsuario.cuotasPagadasTotal (acumulado, no reinicia al subir de nivel).
     */
    cuotasParaNivel?: number[];
    updatedAt: Date;
  }

// ===== WhatsApp (Empresas > WhatsApp) =====

export type WhatsAppDireccion = 'entrante' | 'saliente';

export type WhatsAppTipoMensaje =
  | 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker'
  | 'location' | 'contacts' | 'unsupported';

/** Estados de un mensaje saliente según los webhooks de Meta; 'recibido' es el de los entrantes. */
export type WhatsAppEstadoMensaje = 'enviando' | 'enviado' | 'entregado' | 'leido' | 'fallido' | 'recibido';

export interface WhatsAppMedia {
  /** Ruta relativa dentro de uploads/whatsapp (nunca se sirve pública: solo vía /api/whatsapp/media/:id). */
  archivo?: string;
  mimetype: string;
  nombre?: string;
  size?: number;
  /** 'pendiente' mientras se descarga desde Meta un adjunto entrante. */
  estado: 'pendiente' | 'listo' | 'error';
  /** Id del adjunto en Meta (entrantes), para reintentar la descarga. */
  metaMediaId?: string;
}

/** Resumen del mensaje citado, copiado al guardar para no tener que buscarlo al pintar. */
export interface WhatsAppCita {
  id: string;
  direccion: WhatsAppDireccion;
  tipo: WhatsAppTipoMensaje;
  texto?: string;
}

export interface WhatsAppMensaje {
  _id?: string;
  id: string;
  /** wamid de Meta. Único: Meta reintenta los webhooks y así no se duplican mensajes. */
  waMessageId?: string;
  waId: string;
  direccion: WhatsAppDireccion;
  tipo: WhatsAppTipoMensaje;
  texto?: string;
  media?: WhatsAppMedia;
  ubicacion?: { latitud: number; longitud: number; nombre?: string; direccion?: string };
  estado: WhatsAppEstadoMensaje;
  error?: string;
  cita?: WhatsAppCita;
  reaccion?: string;
  /** Quién lo envió desde el panel; ausente si vino del teléfono (app WhatsApp Business). */
  enviadoPor?: { userId: string; nombre: string };
  fecha: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WhatsAppConversacion {
  _id?: string;
  /** Número del cliente tal como lo da Meta (wa_id, sin "+"). */
  waId: string;
  /** Nombre del perfil de WhatsApp del cliente. */
  nombre?: string;
  /** Nombre puesto a mano desde el panel; tiene prioridad sobre `nombre`. */
  alias?: string;
  /** Cliente de Relación de Cuentas (abonos-polar) con ese teléfono, si existe. */
  cliente?: { nombre?: string; empresa?: string; planta?: string; cedula?: string };
  clienteBuscado?: boolean;
  ultimoMensaje?: Pick<WhatsAppMensaje, 'id' | 'direccion' | 'tipo' | 'texto' | 'estado' | 'fecha'>;
  noLeidos: number;
  /** Último mensaje del cliente: define la ventana de 24 h en la que se puede escribir texto libre. */
  ultimoEntranteEn?: Date;
  createdAt: Date;
  updatedAt: Date;
}
