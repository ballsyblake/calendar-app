import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DB_FILE || 'data/teamcal.db';
const { app } = createApp({ dbFile });

app.listen(port, () => {
  console.log(`TeamCal running at http://localhost:${port} (database: ${dbFile})`);
});
