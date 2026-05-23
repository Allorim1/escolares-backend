import { Request, Response } from 'express';
import argon2 from 'argon2';
import { database } from '../config/database';
import { User } from '../models';
import { jwtConfig } from '../config/jwt';
import { AuthRequest } from '../middlewares/auth.middleware';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    try {
      const { username, email, password, rif, telefono, direccion, tipoPersona } = req.body;

      if (!username || !email || !password || !rif || !telefono || !direccion) {
        res.status(400).json({ error: 'Todos los campos son requeridos, incluyendo tipo de persona' });
        return;
      }

      const normalizedEmail = email.toLowerCase().trim();

      const existingUser = await database.getCollection<User>('users').findOne({ email: normalizedEmail });
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
        username: username.toLowerCase().trim(),
        email: normalizedEmail,
        password: hashedPassword,
        isAdmin: false,
        rol: 'usuario',
        cedula: rif,
        telefono,
        direccion,
        tipoPersona: tipoPersona as 'natural' | 'juridica' || 'natural',
      };

      await database.getCollection<User>('users').insertOne(newUser);

      const tokens = jwtConfig.generateTokens({
        userId: newUser.id,
        email: newUser.email,
        rol: newUser.rol || 'usuario',
        username: newUser.username,
        nombre: newUser.nombreCompleto || newUser.username,
      });

      res.cookie('accessToken', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      });

      const { password: _, ...userWithoutPassword } = newUser;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error('Error en registro:', error);
      res.status(500).json({ error: 'Error al registrar usuario' });
    }
  }

  async registerSimple(req: Request, res: Response): Promise<void> {
    try {
      const { username, email, password, nombreCompleto, apellido, telefono, direccion, comentarios, rol, rolId } = req.body;

      if (!username || !email || !password) {
        res.status(400).json({ error: 'Usuario, email y contraseña son requeridos' });
        return;
      }

      const normalizedEmail = email.toLowerCase().trim();

      const existingUser = await database.getCollection<User>('users').findOne({ email: normalizedEmail });
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
        username: username.toLowerCase().trim(),
        email: normalizedEmail,
        password: hashedPassword,
        isAdmin: false,
        rol: rol || 'usuario',
        rolId: rolId,
        nombreCompleto: nombreCompleto || '',
        apellido: apellido || '',
        telefono: telefono || '',
        direccion: direccion || '',
        comentarios: comentarios || '',
      };

      if (rol === 'owner') {
        newUser.isAdmin = true;
        newUser.isOwner = true;
      }

      await database.getCollection<User>('users').insertOne(newUser);

      const { password: _, ...userWithoutPassword } = newUser;
      res.status(201).json(userWithoutPassword);
    } catch (error) {
      console.error('Error en registro simple:', error);
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

      const normalizedIdentifier = identifier.toLowerCase().trim();

      const user = await database.getCollection<User>('users').findOne({
        $or: [
          { email: { $regex: new RegExp(`^${normalizedIdentifier}$`, 'i') } },
          { username: { $regex: new RegExp(`^${normalizedIdentifier}$`, 'i') } }
        ],
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
        username: user.username,
        nombre: user.nombreCompleto || user.username,
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
        username: user.username,
        nombre: user.nombreCompleto || user.username,
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

      res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
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

   async update(req: AuthRequest, res: Response): Promise<void> {
     try {
       const userId = req.user?.userId;
      const { username, email, nombreCompleto, direccion, telefono, cedula, tipoPersona, comentarios, direcciones, metodosPago, supervisorKey } = req.body;

       if (!userId) {
         res.status(401).json({ error: 'No autorizado' });
         return;
       }

       const updateData: Partial<User> = {};
       if (username) updateData.username = username;
       if (email) updateData.email = email;
       if (nombreCompleto !== undefined) updateData.nombreCompleto = nombreCompleto;
       if (direccion !== undefined) updateData.direccion = direccion;
       if (telefono !== undefined) updateData.telefono = telefono;
       if (cedula !== undefined) updateData.cedula = cedula;
       if (tipoPersona !== undefined) updateData.tipoPersona = tipoPersona;
       if (comentarios !== undefined) updateData.comentarios = comentarios;
       if (direcciones !== undefined) updateData.direcciones = direcciones;
       if (metodosPago !== undefined) updateData.metodosPago = metodosPago;
       if (supervisorKey !== undefined) updateData.supervisorKey = supervisorKey;

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
      const { targetUserId, rol, rolId } = req.body;
      const solicitanteRol = (req as any).userRol;
      const usuario = (req as any).user?.nombre || (req as any).user?.username || (req as any).user?.email || 'Sistema';

      if (!targetUserId || (!rol && !rolId)) {
        res.status(400).json({ error: 'ID de usuario y rol requeridos' });
        return;
      }

      if (rol === 'root') {
        res.status(403).json({ error: 'No se puede asignar rol de root' });
        return;
      }

      if (rol === 'owner' && solicitanteRol !== 'root') {
        res.status(403).json({ error: 'Solo el usuario root puede asignar rol de owner' });
        return;
      }

      const usuarioActual = await database.getCollection<User>('users').findOne({ id: targetUserId });

const updateData: Partial<User> = {};
       if (rol) {
         updateData.rol = rol as 'owner' | 'usuario';
         updateData.isAdmin = rol === 'owner';
         updateData.isOwner = rol === 'owner';
       }
       if (rolId !== undefined) {
         updateData.rolId = rolId;
         if (!updateData.isAdmin) {
           updateData.isAdmin = true;
         }
       }

      const result = await database
        .getCollection<User>('users')
        .findOneAndUpdate(
          { id: targetUserId },
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const db = database.db;
      if (db) {
        let registrosCollection = db.collection('registros');
        const exists = await db.listCollections().toArray();
        const names = exists.map((c: any) => c.name);
        if (!names.includes('registros')) {
          await db.createCollection('registros');
          registrosCollection = db.collection('registros');
        }
        await registrosCollection.insertOne({
          accion: 'Modificación',
          modulo: 'Usuarios',
          descripcion: `Rol de usuario modificado: ${usuarioActual?.username || targetUserId}`,
          datos: { usuarioId: targetUserId, rolAnterior: usuarioActual?.rol, rolNuevo: rol },
          usuario,
          fecha: new Date(),
        });
      }

      const { password: _, ...userWithoutPassword } = result;
      res.json(userWithoutPassword);
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar rol' });
    }
  }

  async updateEmail(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { email, password } = req.body;

      if (!userId) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }

      if (!email || !password) {
        res.status(400).json({ error: 'Email y contraseña son requeridos' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({ id: userId });
      if (!user || !user.password) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      let validPassword = false;
      if (user.password.startsWith('$argon2')) {
        validPassword = await argon2.verify(user.password, password);
      } else {
        validPassword = user.password === password;
      }

      if (!validPassword) {
        res.status(401).json({ error: 'Contraseña incorrecta' });
        return;
      }

      const existingEmail = await database.getCollection<User>('users').findOne({ email, id: { $ne: userId } });
      if (existingEmail) {
        res.status(400).json({ error: 'El email ya está en uso' });
        return;
      }

      await database.getCollection<User>('users').updateOne(
        { id: userId },
        { $set: { email } }
      );

      const db = database.db;
      if (db) {
        let registrosCollection = db.collection('registros');
        const exists = await db.listCollections().toArray();
        const names = exists.map((c: any) => c.name);
        if (!names.includes('registros')) {
          await db.createCollection('registros');
          registrosCollection = db.collection('registros');
        }
        await registrosCollection.insertOne({
          accion: 'Modificación',
          modulo: 'Usuarios',
          descripcion: `Email de usuario actualizado`,
          datos: { usuarioId: userId, emailAnterior: user.email, emailNuevo: email },
          usuario: user.username || user.email,
          fecha: new Date(),
        });
      }

      res.json({ message: 'Email actualizado correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar email' });
    }
  }

  async updatePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.user?.userId;
      const { currentPassword, newPassword } = req.body;

      if (!userId) {
        res.status(401).json({ error: 'No autorizado' });
        return;
      }

      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Contraseña actual y nueva contraseña son requeridas' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({ id: userId });
      if (!user || !user.password) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      let validPassword = false;
      if (user.password.startsWith('$argon2')) {
        validPassword = await argon2.verify(user.password, currentPassword);
      } else {
        validPassword = user.password === currentPassword;
      }

      if (!validPassword) {
        res.status(401).json({ error: 'Contraseña actual incorrecta' });
        return;
      }

      const hashedPassword = await argon2.hash(newPassword, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      await database.getCollection<User>('users').updateOne(
        { id: userId },
        { $set: { password: hashedPassword } }
      );

      const db = database.db;
      if (db) {
        let registrosCollection = db.collection('registros');
        const exists = await db.listCollections().toArray();
        const names = exists.map((c: any) => c.name);
        if (!names.includes('registros')) {
          await db.createCollection('registros');
          registrosCollection = db.collection('registros');
        }
        await registrosCollection.insertOne({
          accion: 'Modificación',
          modulo: 'Usuarios',
          descripcion: `Contraseña de usuario actualizada`,
          datos: { usuarioId: userId },
          usuario: user.username || user.email,
          fecha: new Date(),
        });
      }

      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar contraseña' });
    }
  }

  async updateUserById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const { username, email, nombreCompleto, telefono, direccion, cedula, tipoPersona, comentarios } = req.body;

      const currentUser = req.user;
      if (!currentUser || (currentUser.userId !== userId && currentUser.rol !== 'root')) {
        res.status(403).json({ error: 'No autorizado para modificar este usuario' });
        return;
      }

      const usersCollection = database.getCollection<User>('users');
      const existingUser = await usersCollection.findOne({ id: userId });
      
      if (!existingUser) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const updateData: any = {};
      if (username) updateData.username = username;
      if (email) updateData.email = email;
      if (nombreCompleto !== undefined) updateData.nombreCompleto = nombreCompleto;
      if (telefono !== undefined) updateData.telefono = telefono;
      if (direccion !== undefined) updateData.direccion = direccion;
      if (cedula !== undefined) updateData.cedula = cedula;
      if (tipoPersona !== undefined) updateData.tipoPersona = tipoPersona;
      if (comentarios !== undefined) updateData.comentarios = comentarios;

      await usersCollection.updateOne(
        { id: userId },
        { $set: updateData }
      );

      const db = database.db;
      if (db) {
        let registrosCollection = db.collection('registros');
        const exists = await db.listCollections().toArray();
        const names = exists.map((c: any) => c.name);
        if (!names.includes('registros')) {
          await db.createCollection('registros');
          registrosCollection = db.collection('registros');
        }
        await registrosCollection.insertOne({
          accion: 'Editar',
          modulo: 'Usuarios',
          descripcion: `Usuario ${username || email} actualizado`,
          datos: { camposActualizados: Object.keys(updateData) },
          usuario: currentUser.username || currentUser.email,
          fecha: new Date(),
        });
      }

      res.json({ message: 'Usuario actualizado correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  }

  async deleteUser(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const currentUser = req.user;

      if (!currentUser || currentUser.rol !== 'root') {
        res.status(403).json({ error: 'Solo el usuario root puede eliminar usuarios' });
        return;
      }

      const userToDelete = await database.getCollection<User>('users').findOne({ id: userId });
      if (!userToDelete) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      if (userToDelete.rol === 'root') {
        res.status(400).json({ error: 'No se puede eliminar al usuario root' });
        return;
      }

      await database.getCollection<User>('users').deleteOne({ id: userId });
      res.json({ message: 'Usuario eliminado correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al eliminar usuario' });
    }
  }

  async updateUserPassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = req.params.id;
      const currentUser = req.user;
      const { newPassword } = req.body;

      if (!currentUser || currentUser.rol !== 'root') {
        res.status(403).json({ error: 'Solo el usuario root puede cambiar contraseñas' });
        return;
      }

      if (!newPassword) {
        res.status(400).json({ error: 'La nueva contraseña es requerida' });
        return;
      }

      const user = await database.getCollection<User>('users').findOne({ id: userId });
      if (!user) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const hashedPassword = await argon2.hash(newPassword, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      await database.getCollection<User>('users').updateOne(
        { id: userId },
        { $set: { password: hashedPassword } }
      );

      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error) {
      res.status(500).json({ error: 'Error al actualizar contraseña' });
    }
  }

  async recoverUsername(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({ error: 'El email o usuario es requerido' });
        return;
      }

      const identifier = email.toLowerCase().trim();
      const user = await database.getCollection<User>('users').findOne({
        $or: [
          { email: { $regex: new RegExp(`^${identifier}$`, 'i') } },
          { username: { $regex: new RegExp(`^${identifier}$`, 'i') } }
        ]
      });

      if (!user) {
        res.status(404).json({ error: 'No se encontró ningún usuario con ese email o usuario' });
        return;
      }

      res.json({ username: user.username, message: 'Usuario encontrado' });
    } catch (error) {
      console.error('Error al recuperar usuario:', error);
      res.status(500).json({ error: 'Error al recuperar usuario' });
    }
  }

  async sendOtpForPasswordReset(req: Request, res: Response): Promise<void> {
    try {
      const { usernameOrEmail } = req.body;

      if (!usernameOrEmail) {
        res.status(400).json({ error: 'Usuario o email son requeridos' });
        return;
      }

      const identifier = usernameOrEmail.toLowerCase().trim();
      const user = await database.getCollection<User>('users').findOne({
        $or: [
          { email: { $regex: new RegExp(`^${identifier}$`, 'i') } },
          { username: { $regex: new RegExp(`^${identifier}$`, 'i') } }
        ],
      });

      if (!user) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await database.getCollection('passwordResetOtp').updateOne(
        { userId: user.id },
        { $set: { otp, expiresAt, userId: user.id, used: false } },
        { upsert: true }
      );

      // Send email if SMTP is configured
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: user.email,
            subject: 'Código de recuperación de contraseña',
            html: `
              <h2>Recuperación de contraseña</h2>
              <p>Tu código de verificación es: <strong>${otp}</strong></p>
              <p>Este código expira en 10 minutos.</p>
            `,
          });
        } catch (emailError) {
          console.error('Error sending email:', emailError);
          // Continue even if email fails - OTP is still valid
        }
      } else {
        console.log(`OTP for ${user.email}: ${otp}`);
      }

      res.json({ message: 'OTP enviado al correo', email: user.email });
    } catch (error) {
      console.error('Error al enviar OTP:', error);
      res.status(500).json({ error: 'Error al enviar OTP' });
    }
  }

  async verifyOtpAndResetPassword(req: Request, res: Response): Promise<void> {
    try {
      const { usernameOrEmail, otp, newPassword } = req.body;

      if (!usernameOrEmail || !otp || !newPassword) {
        res.status(400).json({ error: 'Usuario/email, OTP y nueva contraseña son requeridos', received: { usernameOrEmail: !!usernameOrEmail, otp: !!otp, newPassword: !!newPassword } });
        return;
      }

      const identifier = usernameOrEmail.toLowerCase().trim();
      const user = await database.getCollection<User>('users').findOne({
        $or: [
          { email: { $regex: new RegExp(`^${identifier}$`, 'i') } },
          { username: { $regex: new RegExp(`^${identifier}$`, 'i') } }
        ],
      });

      if (!user) {
        res.status(404).json({ error: 'Usuario no encontrado', identifier });
        return;
      }

      const otpRecord = await database.getCollection('passwordResetOtp').findOne({ userId: user.id });

      if (!otpRecord) {
        res.status(400).json({ error: 'OTP no encontrado', userId: user.id });
        return;
      }

      if (otpRecord.used) {
        res.status(400).json({ error: 'OTP ya utilizado' });
        return;
      }

      if (new Date() > otpRecord.expiresAt) {
        res.status(400).json({ error: 'OTP expirado', expiresAt: otpRecord.expiresAt });
        return;
      }

      if (otpRecord.otp !== otp) {
        res.status(400).json({ error: 'OTP inválido', expected: otpRecord.otp, received: otp });
        return;
      }

      const hashedPassword = await argon2.hash(newPassword, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });

      await database.getCollection<User>('users').updateOne(
        { id: user.id },
        { $set: { password: hashedPassword } }
      );

      await database.getCollection('passwordResetOtp').updateOne(
        { userId: user.id },
        { $set: { used: true } }
      );

      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error) {
      console.error('Error al restablecer contraseña:', error);
      res.status(500).json({ error: 'Error al restablecer contraseña' });
    }
  }
}

export const authController = new AuthController();
