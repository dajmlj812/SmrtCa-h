import FormData from 'form-data';

/**
 * Build a multipart/form-data body for driving the import routes through
 * Fastify's `app.inject()`. Pass `file: null` to omit the file part.
 */
export function buildForm(
  file: { name: string; buffer: Buffer } | null,
  fields: Record<string, string> = {},
): FormData {
  const form = new FormData();
  if (file) {
    form.append('file', file.buffer, {
      filename: file.name,
      contentType: 'text/csv',
    });
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}
