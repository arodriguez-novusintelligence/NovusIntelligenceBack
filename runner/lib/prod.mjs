// Operaciones sobre PROD con el rol de despliegue de la empresa (solo con el rol nadf-runner-*).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { CloudFrontClient, CreateInvalidationCommand, GetInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'public, max-age=0, must-revalidate';
const MISC = 'public, max-age=86400';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.ts': 'text/plain; charset=utf-8',
};

const ext = (p) => {
  const m = /\.[a-z0-9]+$/i.exec(p);
  return m ? m[0].toLowerCase() : '';
};
export const contentType = (p) => TYPES[ext(p)];

export async function assumeProd(app, sessionName, sessionPolicy) {
  const sts = new STSClient({});
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: app.prod.deployRoleArn,
      ExternalId: app.prod.externalId,
      RoleSessionName: sessionName.slice(0, 64),
      DurationSeconds: 3600,
      Policy: sessionPolicy ? JSON.stringify(sessionPolicy) : undefined,
    }),
  );
  const c = out.Credentials;
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

/** Política de sesión para la vista previa: solo agrega archivos nuevos con hash y el index oculto; nunca toca el index público. */
export function previewPolicy(bucket) {
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::${bucket}/*` },
      { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: `arn:aws:s3:::${bucket}` },
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: [`arn:aws:s3:::${bucket}/assets/*`, `arn:aws:s3:::${bucket}/mf-entry-bootstrap-*`, `arn:aws:s3:::${bucket}/__nadf/*`],
      },
    ],
  };
}

export function prodClients(app, credentials) {
  return {
    s3: new S3Client({ region: app.prod.region, credentials }),
    cloudfront: new CloudFrontClient({ region: 'us-east-1', credentials }),
    cloudtrail: new CloudTrailClient({ region: 'us-east-1', credentials }),
  };
}

export async function getText(s3, bucket, key) {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { body: await out.Body.transformToString('utf-8'), etag: out.ETag, lastModified: out.LastModified?.toISOString() };
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404 || error.$metadata?.httpStatusCode === 403) return null;
    throw error;
  }
}

export async function exists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404 || error.name === 'NotFound') return false;
    throw error;
  }
}

/** Quién y cuándo invalidó por última vez la distribución (CloudTrail, us-east-1). */
export async function lastInvalidation(cloudtrail, distributionId) {
  try {
    const out = await cloudtrail.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: 'CreateInvalidation' }],
        StartTime: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        MaxResults: 50,
      }),
    );
    const match = (out.Events ?? []).find((e) => (e.CloudTrailEvent ?? '').includes(distributionId));
    if (!match) return null;
    return { by: match.Username ?? 'desconocido', at: match.EventTime?.toISOString() };
  } catch {
    return null;
  }
}

export async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dir);
  return out.map((full) => ({ full, rel: relative(dir, full).split(sep).join(posix.sep) }));
}

async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

export async function put(s3, bucket, key, body, cacheControl) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, CacheControl: cacheControl, ContentType: contentType(key) }));
}

/**
 * Plan de subida equivalente a infrastructure/aws/deploy-prod.ps1 de DoEventsWEB:
 * shell en la raíz y mfe-auth en /mfe-auth/; assets inmutables; index.html al final y sin caché.
 */
export async function uploadPlan(shellDist, authDist) {
  const plan = [];
  for (const f of await listFiles(shellDist)) {
    if (f.rel === 'index.html') continue;
    const hashed = f.rel.startsWith('assets/') || /\.(js|mjs|css)$/.test(f.rel);
    plan.push({ full: f.full, key: f.rel, cache: hashed ? IMMUTABLE : MISC, order: f.rel.startsWith('assets/') ? 0 : 1 });
  }
  if (authDist) {
    for (const f of await listFiles(authDist)) {
      if (f.rel.startsWith('.dev-server/') || f.rel.startsWith('@mf-types/') || f.rel.startsWith('assets/@mf-types/')) continue;
      if (f.rel === 'index.html') {
        plan.push({ full: f.full, key: 'mfe-auth/index.html', cache: NO_CACHE, order: 2 });
        continue;
      }
      const hashed = f.rel.startsWith('assets/') || /\.(js|mjs|css)$/.test(f.rel);
      plan.push({ full: f.full, key: `mfe-auth/${f.rel}`, cache: hashed ? IMMUTABLE : MISC, order: f.rel.startsWith('assets/') ? 0 : 1 });
    }
  }
  plan.push({ full: join(shellDist, 'index.html'), key: 'index.html', cache: NO_CACHE, order: 9 });
  return plan.sort((a, b) => a.order - b.order);
}

export async function uploadAll(s3, bucket, plan, onProgress) {
  let done = 0;
  for (const order of [...new Set(plan.map((p) => p.order))]) {
    const group = plan.filter((p) => p.order === order);
    await pool(group, 16, async (item) => {
      await put(s3, bucket, item.key, await readFile(item.full), item.cache);
      done += 1;
      if (onProgress && done % 100 === 0) await onProgress(done, plan.length);
    });
  }
  return done;
}

/** Vista previa: sube solo archivos con hash que aún no existan (nunca sobrescribe nada de PROD). */
export async function uploadPreview(s3, bucket, shellDist, previewKey, previewHtml) {
  let uploaded = 0;
  let skipped = 0;
  const files = (await listFiles(shellDist)).filter(
    (f) => f.rel.startsWith('assets/') || /^mf-entry-bootstrap-[^/]+\.(js|mjs)$/.test(f.rel),
  );
  await pool(files, 16, async (f) => {
    if (await exists(s3, bucket, f.rel)) {
      skipped += 1;
      return;
    }
    await put(s3, bucket, f.rel, await readFile(f.full), IMMUTABLE);
    uploaded += 1;
  });
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: previewKey, Body: previewHtml, CacheControl: 'no-store', ContentType: 'text/html; charset=utf-8' }),
  );
  return { uploaded, skipped };
}

export async function backupObject(s3, bucket, key, backupKey) {
  await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: backupKey, CopySource: `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`, MetadataDirective: 'COPY' }));
}

export async function invalidate(cloudfront, distributionId, ref) {
  const out = await cloudfront.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: ref, Paths: { Quantity: 1, Items: ['/*'] } },
    }),
  );
  return out.Invalidation.Id;
}

export async function waitInvalidation(cloudfront, distributionId, id, timeoutMs = 12 * 60 * 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const out = await cloudfront.send(new GetInvalidationCommand({ DistributionId: distributionId, Id: id }));
    if (out.Invalidation?.Status === 'Completed') return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

export async function fileSize(path) {
  return (await stat(path)).size;
}
