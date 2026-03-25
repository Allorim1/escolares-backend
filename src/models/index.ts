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
  productId: number;
  precioOferta: number;
}

export interface User {
  _id?: string;
  id: string;
  username: string;
  email: string;
  password?: string;
  isAdmin: boolean;
  isOwner?: boolean;
  rol?: 'root' | 'owner' | 'usuario';
  rolId?: string;
  nombreCompleto?: string;
  apellido?: string;
  direccion?: string;
  telefono?: string;
  cedula?: string;
  tipoPersona?: 'natural' | 'juridica';
  comentarios?: string;
  direcciones?: Direccion[];
}

export interface Direccion {
  id: string;
  nombre: string;
  direccion: string;
}

export interface Product {
  _id?: string;
  id: number;
  name: string;
  description: string;
  price: number;
  image: string;
  marcaId?: string;
  lineaId?: string;
  stock: number;
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
  metodoPago: string;
  referencia: string;
  fotoComprobante?: string;
  status: OrderStatus;
  historial: OrderHistorial[];
  createdAt: Date;
  updatedAt: Date;
}

export type OrderStatus = 'confirmar' | 'pendiente' | 'procesando' | 'enviado' | 'entregado' | 'cancelado';

export interface OrderHistorial {
  status: OrderStatus;
  fecha: Date;
  observaciones?: string;
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
