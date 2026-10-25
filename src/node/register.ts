/**
 * The start-flag entry: `node --import @naijacloud/argus/register app.js`.
 * Reads ARGUS_DSN (then SENTRY_DSN), ARGUS_RELEASE and ARGUS_ENVIRONMENT and
 * starts Argus before the app's own imports load. Without a DSN it does nothing.
 */
import { init } from './index.js';

init({ debug: process.env.ARGUS_DEBUG === '1' || process.env.ARGUS_DEBUG === 'true' });
