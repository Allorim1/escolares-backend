export const swaggerConfig = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'API Escolares',
      version: '1.0.0',
      description: 'API REST para la aplicación Escolares con MongoDB',
      contact: {
        name: 'API Support',
        email: 'soporte@escolares.com',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Servidor de desarrollo',
      },
    ],
    components: {
      schemas: {
        Marca: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1' },
            name: { type: 'string', example: 'Nike' },
            image: { type: 'string', example: '/marcas/nike.png' },
          },
        },
        Linea: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1' },
            name: { type: 'string', example: 'Línea Escolar' },
            image: { type: 'string', example: '/lineas/linea-escolar.png' },
            productIds: {
              type: 'array',
              items: { type: 'number' },
              example: [1, 2, 3],
            },
          },
        },
        Oferta: {
          type: 'object',
          properties: {
            productId: { type: 'number', example: 1 },
            precioOferta: { type: 'number', example: 9.99 },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '1' },
            username: { type: 'string', example: 'johndoe' },
            email: { type: 'string', example: 'john@example.com' },
            isAdmin: { type: 'boolean', example: false },
          },
        },
        Product: {
          type: 'object',
          properties: {
            id: { type: 'number', example: 1 },
            name: { type: 'string', example: 'Cuaderno' },
            description: { type: 'string', example: 'Cuaderno de 100 hojas' },
            price: { type: 'number', example: 15.99 },
            image: { type: 'string', example: '/products/cuaderno.png' },
            marcaId: { type: 'string', example: '1' },
            lineaId: { type: 'string', example: '1' },
            stock: { type: 'number', example: 50 },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Mensaje de error' },
          },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/*.ts', './src/controllers/*.ts'],
};

export const schemas = swaggerConfig.definition.components?.schemas;

export const responses = {
  notFound: {
    description: 'Recurso no encontrado',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
  badRequest: {
    description: 'Solicitud inválida',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
  internalError: {
    description: 'Error interno del servidor',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
};
