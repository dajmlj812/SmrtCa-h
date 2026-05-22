import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`SmrtCash API listening on http://localhost:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
