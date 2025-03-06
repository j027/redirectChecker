-- Table for storing the source redirect information
CREATE TABLE IF NOT EXISTS redirects
(
    id            SERIAL PRIMARY KEY,
    source_url    TEXT NOT NULL, -- The URL that triggers a redirect
    regex_pattern TEXT NOT NULL,          -- Required: a regex pattern to match or filter URLs, used to check for popup
    type          TEXT NOT NULL           -- The type of redirect, stored as a string.
);

-- Table for storing where the redirect actually goes,
-- along with timestamps to record when the destination was first and last seen.
CREATE TABLE IF NOT EXISTS redirect_destinations
(
    id              SERIAL PRIMARY KEY,
    redirect_id     INTEGER NOT NULL REFERENCES redirects (id) ON DELETE CASCADE,
    destination_url TEXT    NOT NULL,                      -- The target URL where the redirect sends the user
    first_seen      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When this destination was first recorded
    last_seen       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When this destination was most recently observed
    is_popup        BOOLEAN     DEFAULT FALSE              -- Indicates if the destination is a popup
);

-- Table for tracking security status of redirect destinations over time
CREATE TABLE IF NOT EXISTS security_status
(
    id                      SERIAL PRIMARY KEY,
    redirect_destination_id INTEGER NOT NULL REFERENCES redirect_destinations (id) ON DELETE CASCADE,
    
    -- Security service flags (NULL = not flagged, timestamp = when flagged)
    safebrowsing_flagged_at TIMESTAMPTZ,        -- When this URL was flagged by Google SafeBrowsing
    netcraft_flagged_at     TIMESTAMPTZ,        -- When this URL was flagged by Netcraft
    smartscreen_flagged_at  TIMESTAMPTZ,        -- When this URL was flagged by Microsoft SmartScreen
    
    -- DNS resolution status (NULL = still resolving, timestamp = when first found unresolvable)
    dns_unresolvable_at     TIMESTAMPTZ,        -- When the DNS record stopped resolving
    
    -- Tracking fields
    last_checked            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When security checks were last performed
    check_active            BOOLEAN DEFAULT TRUE,                  -- Whether this URL should be checked in future runs
    
    UNIQUE (redirect_destination_id)
);

-- Index for efficient lookup of active checks
CREATE INDEX idx_security_status_active ON security_status(check_active);

-- Table for storing and caching user agents
CREATE TABLE IF NOT EXISTS user_agents
(
    id           SERIAL PRIMARY KEY,
    user_agent   TEXT NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);