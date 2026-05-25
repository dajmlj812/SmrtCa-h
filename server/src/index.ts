import { buildApp } from './app.js';
import { config } from './config.js';
import { getOcrProvider } from './ocr/factory.js';
import { sweepPendingOcr } from './ocr/extract-service.js';
import { startPerformanceScheduler } from './domain/performance-scheduler.js';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`SmrtCash API listening on http://localhost:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Retry any attachment that was uploaded but never finished OCR before the
// previous shutdown. Async so it never blocks accepting requests.
const ocrProvider = getOcrProvider();
if (ocrProvider) {
  void sweepPendingOcr(ocrProvider)
    .then((r) => {
      if (r.scanned > 0) app.log.info(r, 'OCR sweep complete');
    })
    .catch((err) => app.log.warn({ err }, 'OCR sweep failed'));
}

// 0.18.13 — fire up the performance analyzer scheduler. First run
// happens ~30s after boot; subsequent runs honor the
// PERFORMANCE_ANALYSIS_INTERVAL_HOURS setting.
startPerformanceScheduler();
