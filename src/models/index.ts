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

  export interface CreditoUsuario {
    _id?: string;
    id: string;
    nombre: string;
    telefono: string;
    email?: string;
    passwordHash: string;
    nivel: number;
    status: CreditoEstadoVerificacion;
    tutorialVisto: boolean;
    verificacion?: CreditoVerificacion;
    createdAt: Date;
    updatedAt: Date;
  }

  export type CreditoFrecuencia = 'semanal' | 'quincenal' | 'mensual';
  export type CreditoSolicitudStatus = 'solicitado' | 'activo' | 'pagado' | 'rechazado';

  export interface CreditoFactura {
    numero: string;
    emitidaEn: Date;
    subtotal: number;
    iva: number;
    total: number;
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
    factura?: CreditoFactura;
    cuotasPagadas: number;
    createdAt: Date;
    activadoEn?: Date;
    revisadoPor?: string;
    motivoRechazo?: string;
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
    updatedAt: Date;
  }
