// Ship the licensed catalogue on the same origin, as the upstream web container does.
import { cpSync } from 'node:fs';
cpSync(new URL('../catalogue/media/', import.meta.url), new URL('../frontend/dist/exercise-media/', import.meta.url), { recursive: true });
