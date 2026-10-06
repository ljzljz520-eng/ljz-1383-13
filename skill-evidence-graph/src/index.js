'use strict';
const { openDb } = require('./db');
const { createApp } = require('./server');
const { processDueJobs } = require('./jobs');

openDb();
const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`skill-evidence-graph listening on http://localhost:${port}`);
  console.log('periodic job tick every 5s');
});
setInterval(() => { try { processDueJobs(); } catch (e) { console.error('job tick error', e); } }, 5000);
