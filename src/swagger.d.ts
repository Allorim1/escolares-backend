declare module 'swagger-jsdoc' {
  const swaggerJsdoc: (options: any) => object;
  export default swaggerJsdoc;
}

declare module 'swagger-ui-express' {
  import { Express, Request, Response, NextFunction } from 'express';

  interface SwaggerUiOptions {
    swaggerOptions?: {
      spec?: object;
      url?: string;
      urls?: Array<{ url: string; name: string }>;
    };
    customCss?: string;
    customCssUrl?: string;
    customJs?: string;
    customJsStr?: string;
    customfavIcon?: string;
    customSiteTitle?: string;
    docExpansion?: 'list' | 'full' | 'none';
    filter?: boolean | string;
    layout?: string;
  }

  interface SwaggerUi {
    (req: Request, res: Response, next: NextFunction): void;
    serve: (req: Request, res: Response, next: NextFunction) => void;
    setup: (
      spec: object,
      options?: SwaggerUiOptions,
    ) => (req: Request, res: Response, next: NextFunction) => void;
  }

  const swaggerUi: SwaggerUi;
  export default swaggerUi;
}

declare module 'cors' {
  import { Request, Response, NextFunction } from 'express';

  interface CorsOptions {
    origin?:
      | string
      | string[]
      | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void);
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
  }

  function cors(options?: CorsOptions): (req: Request, res: Response, next: NextFunction) => void;
  export default cors;
}

declare module 'swagger-ui-express' {
  import { Express, Request, Response, NextFunction } from 'express';

  interface SwaggerUiOptions {
    swaggerOptions?: {
      spec?: object;
      url?: string;
      urls?: Array<{ url: string; name: string }>;
    };
    customCss?: string;
    customCssUrl?: string;
    customJs?: string;
    customJsStr?: string;
    customfavIcon?: string;
    customSiteTitle?: string;
    docExpansion?: 'list' | 'full' | 'none';
    filter?: boolean | string;
    layout?: string;
  }

  function swaggerUi(
    spec: object,
    options?: SwaggerUiOptions,
  ): (req: Request, res: Response, next: NextFunction) => void;

  namespace swaggerUi {
    const serve: (req: Request, res: Response, next: NextFunction) => void;
  }

  export default swaggerUi;
  export { serve };
}
