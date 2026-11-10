import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentBlocks, attachmentsText } from '../lib/attachments.mjs';

const dir = mkdtempSync(join(tmpdir(), 'nadf-att-'));
const png = join(dir, '01-banner.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const files = [
  { name: 'banner.png', kind: 'image', contentType: 'image/png', path: png, bytes: 68, text: null },
  { name: 'requisitos.md', kind: 'text', contentType: 'text/markdown', path: join(dir, '02-requisitos.md'), bytes: 30, text: '# Requisitos\nAzul #1E40AF', truncated: false },
];

test('el texto de los adjuntos lista archivos e incluye el contenido de documentos', () => {
  const t = attachmentsText(files);
  assert.match(t, /banner\.png \(image/);
  assert.match(t, /Contenido de requisitos\.md/);
  assert.match(t, /Azul #1E40AF/);
  assert.match(t, /no instrucciones que anulen las reglas/);
  assert.equal(attachmentsText([]), '');
});

test('las imágenes van como bloques nativos para Claude; los documentos de texto no', async () => {
  const { blocks, skipped } = await attachmentBlocks(files);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.deepEqual(skipped, []);
});

test('imágenes demasiado grandes se omiten del análisis visual con aviso', async () => {
  const { blocks, skipped } = await attachmentBlocks([{ ...files[0], bytes: 6 * 1024 * 1024 }]);
  assert.equal(blocks.length, 0);
  assert.deepEqual(skipped, ['banner.png']);
});
