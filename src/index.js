const path = require('path');
const fs = require('fs');
if (process.argv.includes('--mock')) process.env.MOCK = '1';
const express = require('express');
const { loadEnv, ensureApiKey } = require('./env');

const root = path.join(__dirname, '..');

(async () => {
  loadEnv(root);
  await ensureApiKey(root);
  const Bot = require('./bot');
  const cfgPath = process.env.CONFIG ? path.resolve(process.env.CONFIG) : path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const bot = new Bot(cfg, root, cfgPath);

  process.on('uncaughtException', (e) => bot.logger.log('system', `uncaughtException: ${e.stack || e}`, 'error'));
  process.on('unhandledRejection', (e) => bot.logger.log('system', `unhandledRejection: ${(e && e.stack) || e}`, 'error'));
  const shutdown = () => { bot.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const app = express();
  app.use(express.static(path.join(root, 'public')));
  app.get('/api/state', (req, res) => res.json(bot.state()));
  app.post('/api/optimize', (req, res) => res.json({ started: bot.runOptimizer('manuell') }));
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const onLine = (l) => res.write(`data: ${JSON.stringify(l)}\n\n`);
    bot.logger.on('line', onLine);
    req.on('close', () => bot.logger.off('line', onLine));
  });
  app.listen(cfg.dashboardPort, () => bot.logger.log('system', `Dashboard: http://localhost:${cfg.dashboardPort}`));
  bot.start();
})();
