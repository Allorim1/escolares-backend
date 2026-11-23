import { NextFunction, Request, Response } from 'express';

type SchemaRule = {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  enum?: readonly unknown[];
  pattern?: RegExp;
  custom?: (value: unknown, body: any) => string | null;
};

export type ValidationSchema = Record<string, SchemaRule>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateBody(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = isObject(req.body) ? req.body : {};
    const errors: string[] = [];

    for (const [field, rule] of Object.entries(schema)) {
      const value = body[field];
      const missing = value === undefined || value === null || value === '';
      if (rule.required && missing) {
        errors.push(`${field} es requerido`);
        continue;
      }
      if (missing) continue;

      if (rule.type === 'string' && typeof value !== 'string') { errors.push(`${field} debe ser texto`); continue; }
      if (rule.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) { errors.push(`${field} debe ser número`); continue; }
      if (rule.type === 'boolean' && typeof value !== 'boolean') { errors.push(`${field} debe ser booleano`); continue; }
      if (rule.type === 'object' && !isObject(value)) { errors.push(`${field} debe ser objeto`); continue; }
      if (rule.type === 'array' && !Array.isArray(value)) { errors.push(`${field} debe ser arreglo`); continue; }

      if (typeof value === 'string') {
        if (rule.minLength !== undefined && value.trim().length < rule.minLength) errors.push(`${field} es muy corto`);
        if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${field} es muy largo`);
        if (rule.pattern && !rule.pattern.test(value)) errors.push(`${field} tiene formato inválido`);
      }
      if (typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) errors.push(`${field} es menor al mínimo`);
        if (rule.max !== undefined && value > rule.max) errors.push(`${field} es mayor al máximo`);
      }
      if (rule.enum && !rule.enum.includes(value)) errors.push(`${field} no es válido`);
      if (rule.custom) {
        const msg = rule.custom(value, body);
        if (msg) errors.push(msg);
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Datos inválidos', details: errors });
      return;
    }
    next();
  };
}
