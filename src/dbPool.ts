import 'dotenv/config';

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool();

export async function closePool() {
    return pool.end();
}

export default pool;