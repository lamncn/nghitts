interface Env {
  piper: R2Bucket;
  ASSETS: Fetcher;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: corsHeaders,
  });
}

function decodeSegment(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function contentType(fileName: string): string {
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (fileName.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

async function serveR2Object(
  request: Request,
  bucket: R2Bucket,
  key: string,
  fileName: string,
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) return new Response('Model file not found', { status: 404, headers: corsHeaders });

  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', contentType(fileName));
  headers.set('Content-Length', object.size.toString());
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);

  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function listPiperModels(bucket: R2Bucket, lang: string): Promise<Response> {
  const prefix = `piper/${lang}/`;
  const objects = await bucket.list({ prefix });
  const models = objects.objects
    .filter((object) => object.key.endsWith('.onnx.json'))
    .map((object) => object.key.slice(prefix.length, -'.onnx.json'.length))
    .filter(Boolean)
    .sort();

  return json({ models });
}

async function listAsrModels(bucket: R2Bucket): Promise<Response> {
  const prefix = 'asr/';
  const objects = await bucket.list({ prefix, delimiter: '/' });
  const models = (objects.delimitedPrefixes ?? [])
    .map((item) => item.slice(prefix.length).replace(/\/$/, ''))
    .filter(Boolean)
    .sort();

  return json({ models: [...new Set(models)] });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const { pathname } = new URL(request.url);
  const parts = pathname.split('/').filter(Boolean);

  // /api/models — Vietnamese Piper model list.
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'models') {
    return listPiperModels(env.piper, 'vi');
  }

  // /api/asr/models
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'asr' && parts[2] === 'models') {
    return listAsrModels(env.piper);
  }

  // /api/piper/:lang/models
  if (
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'piper' &&
    parts[3] === 'models'
  ) {
    const lang = decodeSegment(parts[2]);
    if (!lang) return json({ error: 'Invalid language code' }, 400);
    return listPiperModels(env.piper, lang);
  }

  // /api/model/asr/:model/:name
  if (
    parts.length === 5 &&
    parts[0] === 'api' &&
    parts[1] === 'model' &&
    parts[2] === 'asr'
  ) {
    const model = decodeSegment(parts[3]);
    const fileName = decodeSegment(parts[4]);
    if (!model || !fileName) return json({ error: 'Invalid model file path' }, 400);
    return serveR2Object(request, env.piper, `asr/${model}/${fileName}`, fileName);
  }

  // /api/model/piper/:lang/:name
  if (
    parts.length === 5 &&
    parts[0] === 'api' &&
    parts[1] === 'model' &&
    parts[2] === 'piper'
  ) {
    const lang = decodeSegment(parts[3]);
    const fileName = decodeSegment(parts[4]);
    if (!lang || !fileName) return json({ error: 'Invalid model file path' }, 400);
    return serveR2Object(request, env.piper, `piper/${lang}/${fileName}`, fileName);
  }

  // /api/model/:name — backwards-compatible Vietnamese model route.
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'model') {
    const fileName = decodeSegment(parts[2]);
    if (!fileName) return json({ error: 'Invalid model file name' }, 400);
    return serveR2Object(request, env.piper, `piper/vi/${fileName}`, fileName);
  }

  return json({ error: 'API route not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleApi(request, env);
    } catch (error) {
      console.error('API request failed:', error);
      return json(
        {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
