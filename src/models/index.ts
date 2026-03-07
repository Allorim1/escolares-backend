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
  rol?: 'owner' | 'admin' | 'empleado' | 'usuario';
  nombreCompleto?: string;
  direccion?: string;
  telefono?: string;
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
