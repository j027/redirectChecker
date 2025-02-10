import pool from "../dbPool";
import { getLatestWindowsChromeUserAgent } from "./chromeUserAgent";

export class UserAgentService {
  async getUserAgent(): Promise<string> {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT user_agent, last_updated 
        FROM user_agents 
        ORDER BY last_updated DESC 
        LIMIT 1
      `);

      // if user agent was last updated within a day
      if (
        result.rows.length > 0 &&
        Date.now() - result.rows[0].last_updated.getTime() < 24 * 60 * 60 * 1000
      ) {
        return result.rows[0].user_agent;
      }

      const userAgent = await getLatestWindowsChromeUserAgent();

      // Use a transaction to ensure atomic operations
      await client.query('BEGIN');
      
      // Remove old user agents and insert new one
      await client.query(`DELETE FROM user_agents`);
      await client.query(`
        INSERT INTO user_agents (user_agent) 
        VALUES ($1)
      `, [userAgent]);
      
      await client.query('COMMIT');

      return userAgent;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error("Error managing user agent:", error);
      return "";
    } finally {
      client.release();
    }
  }
}

// Export a singleton instance
export const userAgentService = new UserAgentService();
