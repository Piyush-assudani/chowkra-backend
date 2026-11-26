try { process.loadEnvFile?.(); } catch {}

import { createServer } from './index.js';

const port = Number(process.env.PORT ?? 3000);
const { server } = createServer();
server.listen(port, () => console.log(`Chowkra server listening on :${port}`));
