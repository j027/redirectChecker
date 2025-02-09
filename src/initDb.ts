// initDb.ts
import { Client } from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function initializeDatabase() {
    const client = new Client();

    try {
        await client.connect();
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        await client.query(schema);
        console.log('Database initialized successfully.');
    } catch (error) {
        console.error('Error initializing the database:', error);
    } finally {
        await client.end();
    }
}

void initializeDatabase();