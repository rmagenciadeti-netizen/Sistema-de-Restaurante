import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'rm-restaurant-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1/modules', (_req, res) => {
  res.json({
    modules: [
      'master-admin',
      'companies',
      'employees',
      'pos',
      'menu',
      'production',
      'inventory',
      'financial',
      'delivery',
      'crm',
      'reports',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`RM Restaurant API running on http://localhost:${PORT}`);
});
