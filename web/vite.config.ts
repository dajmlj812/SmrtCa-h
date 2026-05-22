import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API proxy target and dev-server port are env-driven so that the
// end-to-end test harness can run an isolated stack on different ports
// without colliding with a normal `npm run dev` session.
const apiProxyTarget = process.env.VITE_API_PROXY ?? 'http://localhost:4000';
const port = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
});
