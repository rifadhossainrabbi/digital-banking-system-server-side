import 'dotenv/config';
import app from './app';
import { connectDB } from './lib/db';

const PORT = parseInt(process.env.PORT || '5000', 10);

async function bootstrap() {
  try {
    await connectDB();
    console.log('✅  MongoDB connected');

    app.listen(PORT, () => {
      console.log(`🚀  Digital Banking Server running on http://localhost:${PORT}`);
      console.log(`📋  API Docs: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error('❌  Failed to start server:', err);
    process.exit(1);
  }
}

bootstrap();
