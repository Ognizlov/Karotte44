const path = require('path');
const fs = require('fs');
const express = require('express');
const Bot = require('./bot');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const bot = new Bot(cfg, root);

process.on('uncaughtException', (e) => bot.logger.log('system', `uncaughtException: ${e.stack || e}`, 'error'));
process.on('unhandledRejection', (e) => bot.logger.log('system', `unhandledRejection: ${e && e.stack || e}`, 'error'));

const app = express();
app.use(express.static(path.join(root, 'public')));
app.get('/api/state', (req, res) => res.json(bot.state()));
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const onLine = (l) => res.write(`data: ${JSON.stringify(l)}\n\n`);
  bot.logger.on('line', onLine);
  req.on('close', () => bot.logger.off('line', onLine));
});
app.listen(cfg.dashboardPort, () => bot.logger.log('system', `Dashboard: http://localhost:${cfg.dashboardPort}`));
bot.start();
