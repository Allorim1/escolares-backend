import { Request, Response } from 'express';
import argon2 from 'argon2';
import { database } from '../config/database';
import { User } from '../models';
import { jwtConfig } from '../config/jwt';
import { AuthRequest } from '../middlewares/auth.middleware';

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    try {
      const { username, email, password } = req.body;

      if (!username || !email || !password) {
        res.status(400).json({ error: 'Todos los campos son requeridos' });
        return;
      }

      const existingUser = await database.getCollection<User>('users').findOne({ email });
      if (existingUser) {
        res.status(400).json({ error: 'El email ya está registrado' });
        return;
      }

      const hashedPassword = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      const newUser: User = {
        id: Date.now().toString(),
        username,
        email,
        password: hashedPassword,
        isAdmin: false,
        rol: 'usuario',
      };

      await database.getCollection<User>('users').insertOne(newUser);

      const tokens = jwtConfig.generateTokens({
        userId: newUser.id,
        email: newUser.email,
        rol: newUser.rol || 'usuario',
      });

      res.cookie('accessToken', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000,
      });

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const { password: _, ...userWithoutPassword } = newUser;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error('Error en register:', error);
      res.status(500).json({ error: 'Error al registrar usuario' });
    }
  }

  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, username, password } = req.body;
      const identifier = email || username;

      if (!identifier || !password) {
        res.status(400).json({ error: 'Email/username y contraseña son requeridos' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({
        $or: [{ email: identifier }, { username: identifier }],
      });

      if (!user || !user.password) {
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
      }

      let validPassword = false;

      if (user.password.startsWith('$argon2')) {
        validPassword = await argon2.verify(user.password, password);
      } else {
        validPassword = user.password === password;
        if (validPassword && password.length >= 6) {
          const hashedPassword = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 4,
          });
          await database
            .getCollection<User>('users')
            .updateOne({ id: user.id }, { $set: { password: hashedPassword } });
        }
      }

      if (!validPassword) {
        res.status(401).json({ error: 'Credenciales inválidas' });
        return;
      }

      const tokens = jwtConfig.generateTokens({
        userId: user.id,
        email: user.email,
        rol: user.rol || 'usuario',
      });

      res.cookie('accessToken', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000,
      });

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const { password: _, ...userWithoutPassword } = user;
      res.json({ ...userWithoutPassword, accessToken: tokens.accessToken });
    } catch (error) {
      console.error('Error en login:', error);
      res.status(500).json({ error: 'Error al iniciar sesión' });
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    try {
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');

      res.json({ message: 'Sesión cerrada correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al cerrar sesión' });
    }
  }

  async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

      if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token requerido' });
        return;
      }

      const payload = jwtConfig.verifyRefreshToken(refreshToken);
      if (!payload) {
        res.status(401).json({ error: 'Refresh token inválido o expirado' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({ id: payload.userId });
      if (!user) {
        res.status(401).json({ error: 'Usuario no encontrado' });
        return;
      }

      const tokens = jwtConfig.generateTokens({
        userId: user.id,
        email: user.email,
        rol: user.rol || 'usuario',
      });

      res.cookie('accessToken', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000,
      });

      res.cookie('refreshToken', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({ accessToken: tokens.accessToken });
    } catch (error) {
      res.status(500).json({ error: 'Error al refresh token' });
    }
  }

  async getProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({ id: userId });
      if (!user) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const { password: _, ...userWithoutPassword } = user;
      res.json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener perfil' });
    }
  }

  async getAll(req: Request, res: Response): Promise<void> {
    try {
      const users = await database.getCollection<User>('users').find({}).toArray();
      const usersWithoutPassword = users.map(({ password, ...user }) => user);
      res.json(usersWithoutPassword);
    } catch (error) {
      res.status(500).json({ error: 'Error al obtener usuarios' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    try {
      const { userId, username, email, nombreCompleto, direccion, telefono } = req.body;

      if (!userId) {
        res.status(400).json({ error: 'ID de usuario requerido' });
        return;
      }

      const updateData: Partial<User> = {};
      if (username) updateData.username = username;
      if (email) updateData.email = email;
      if (nombreCompleto !== undefined) updateData.nombreCompleto = nombreCompleto;
      if (direccion !== undefined) updateData.direccion = direccion;
      if (telefono !== undefined) updateData.telefono = telefono;

      const result = await database
        .getCollection<User>('users')
        .findOneAndUpdate({ id: userId }, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const { password: _, ...userWithoutPassword } = result;
      res.json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  }

  async updateRol(req: Request, res: Response): Promise<void> {
    try {
      const { targetUserId, rol } = req.body;
      const solicitanteRol = (req as any).userRol;

      if (!targetUserId || !rol) {
        res.status(400).json({ error: 'ID de usuario y rol requeridos' });
        return;
      }

      if (rol === 'owner') {
        res.status(403).json({ error: 'No se puede asignar rol de owner' });
        return;
      }

      if (rol === 'admin' && solicitanteRol !== 'owner') {
        res.status(403).json({ error: 'Solo el owner puede asignar rol de admin' });
        return;
      }

      if (rol === 'empleado' && solicitanteRol === 'usuario') {
        res.status(403).json({ error: 'No tienes permisos para asignar roles' });
        return;
      }

      if (solicitanteRol === 'admin' && rol === 'admin') {
        res.status(403).json({ error: 'Un admin no puede asignar rol de admin' });
        return;
      }

      const result = await database
        .getCollection<User>('users')
        .findOneAndUpdate(
          { id: targetUserId },
          { $set: { rol, isAdmin: rol === 'admin' } },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const { password: _, ...userWithoutPassword } = result;
      res.json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar rol' });
    }
  }
}

export const authController = new AuthController();
