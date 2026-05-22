import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db/pool.js';
import {
  listFormats,
  type ColumnMapping,
} from '../import/formats.js';
import {
  commitImport,
  previewImport,
  ImportError,
} from '../import/importer.js';
import { isUuid } from '../util.js';

interface MultipartParts {
  file?: { filename: string; buffer: Buffer };
  fields: Record<string, string>;
}

async function readMultipart(req: FastifyRequest): Promise<MultipartParts> {
  const fields: Record<string, string> = {};
  let file: MultipartParts['file'];
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      file = { filename: part.filename, buffer: await part.toBuffer() };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { file, fields };
}

function parseMapping(raw: string | undefined): ColumnMapping | undefined {
  if (!raw || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as ColumnMapping;
  } catch {
    throw new ImportError('Invalid column mapping JSON');
  }
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/imports/formats', async () => ({ formats: listFormats() }));

  app.post('/api/imports/preview', async (req, reply) => {
    const { file, fields } = await readMultipart(req);
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    const preview = await previewImport(
      file.filename,
      file.buffer,
      fields['formatId'] || undefined,
      parseMapping(fields['mapping']),
    );
    return { preview };
  });

  app.post('/api/imports/commit', async (req, reply) => {
    const { file, fields } = await readMultipart(req);
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    const accountId = fields['accountId']?.trim();
    if (!accountId || !isUuid(accountId)) {
      return reply.code(400).send({ error: 'A valid accountId is required' });
    }
    const result = await commitImport(
      accountId,
      file.filename,
      file.buffer,
      fields['formatId'] || undefined,
      parseMapping(fields['mapping']),
    );
    return { result };
  });

  app.get<{ Querystring: { accountId?: string } }>(
    '/api/imports',
    async (req, reply) => {
      const accountId = req.query.accountId?.trim() || null;
      if (accountId && !isUuid(accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
      const rows = await query(
        `SELECT b.id, b.account_id, b.filename, b.format_id, b.row_count,
                b.imported_count, b.skipped_count, b.error_count, b.created_at,
                a.name AS account_name
         FROM import_batches b
         JOIN accounts a ON a.id = b.account_id
         WHERE ($1::uuid IS NULL OR b.account_id = $1)
         ORDER BY b.created_at DESC
         LIMIT 100`,
        [accountId],
      );
      return { batches: rows.rows };
    },
  );
}
