import { Pool } from 'pg';

const pool = new Pool();

export function closePool() {
    return pool.end();
}

export default pool;