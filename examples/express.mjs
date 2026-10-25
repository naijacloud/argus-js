// Run with: ARGUS_DSN=… node --import @naijacloud/argus/register examples/express.mjs
import express from 'express';
import { argusErrorHandler, log, metrics } from '@naijacloud/argus';

const app = express();

app.get('/pay', (req, res) => {
  log.info('payment started', { orderId: 'ord_81' });
  metrics.count('payments.started');
  res.send('ok');
});

app.get('/boom', () => {
  throw new Error('Card declined');
});

app.use(argusErrorHandler());
app.listen(3000);
