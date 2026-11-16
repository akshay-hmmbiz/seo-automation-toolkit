// Imported first by every test file. It points the Watcher at the committed example
// config, so the suite gives the same answer on every machine: it never reads your own
// watcher.config.json, and it does not need one to exist.
import { fileURLToPath } from 'node:url';

process.env.WATCHER_CONFIG = fileURLToPath(new URL('../../watcher.config.example.json', import.meta.url));
