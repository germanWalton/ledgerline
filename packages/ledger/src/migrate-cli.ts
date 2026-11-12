import { migrate } from './migrate.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const applied = await migrate(connectionString);
console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
