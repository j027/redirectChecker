import 'dotenv/config';

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool();

export function closePool() {
    return pool.end();
}

export default pool;