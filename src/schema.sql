-- Table for storing the source redirect information
CREATE TABLE IF NOT EXISTS redirects
(
    id            SERIAL PRIMARY KEY,
    source_url    TEXT NOT NULL, -- The URL that triggers a redirect
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

-- Table for tracking takendown status of redirect destinations over time
CREATE TABLE IF NOT EXISTS takedown_status
(
    id                      SERIAL PRIMARY KEY,
    redirect_destination_id INTEGER NOT NULL REFERENCES redirect_destinations (id) ON DELETE CASCADE,
    
    -- Security service flags (NULL = not flagged, timestamp = when flagged)
    safebrowsing_flagged_at TIMESTAMPTZ DEFAULT NULL,        -- When this URL was flagged by Google SafeBrowsing
    netcraft_flagged_at     TIMESTAMPTZ DEFAULT NULL,        -- When this URL was flagged by Netcraft
    smartscreen_flagged_at  TIMESTAMPTZ DEFAULT NULL,        -- When this URL was flagged by Microsoft SmartScreen
    
    -- DNS resolution status (NULL = still resolving, timestamp = when first found unresolvable)
    dns_unresolvable_at     TIMESTAMPTZ DEFAULT NULL,        -- When the DNS record stopped resolving
    
    -- Tracking fields
    last_checked            TIMESTAMPTZ DEFAULT NULL, -- When security checks were last performed
    check_active            BOOLEAN DEFAULT TRUE,     -- Whether this URL should be checked in future runs
    
    UNIQUE (redirect_destination_id)
);

-- Index for efficient lookup of active checks
CREATE INDEX idx_takedown_status_active ON takedown_status(check_active);

-- Table for storing and caching user agents
CREATE TABLE IF NOT EXISTS user_agents
(
    id           SERIAL PRIMARY KEY,
    user_agent   TEXT NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS url_training_dataset (
    uuid UUID PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    is_scam BOOLEAN,
    confidence_score FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Main ads table - generic for all ad types
CREATE TABLE IF NOT EXISTS ads (
    id UUID PRIMARY KEY,
    ad_type VARCHAR(50) NOT NULL,
    initial_url TEXT NOT NULL,     -- Original ad URL
    final_url TEXT NOT NULL,       -- Where it ultimately leads
    redirect_path TEXT[] NOT NULL, -- PostgreSQL array of URLs in redirect chain
    is_scam BOOLEAN NOT NULL,
    confidence_score FLOAT,        -- Optional confidence in classification
    first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CHECK (ad_type IN ('search', 'typosquat', 'pornsite', 'pornhub'))
);

-- Search ad specific attributes
CREATE TABLE IF NOT EXISTS search_ads (
    ad_id UUID PRIMARY KEY REFERENCES ads(id) ON DELETE CASCADE,
    ad_url TEXT NOT NULL,          -- The actual clickable URL in the ad
    ad_text TEXT,                  -- The displayed ad text
    search_url TEXT                -- Optional: the URL used to find this ad
);

-- History table to track status changes
CREATE TABLE IF NOT EXISTS ad_status_history (
    id SERIAL PRIMARY KEY,
    ad_id UUID REFERENCES ads(id) ON DELETE CASCADE,
    previous_status BOOLEAN,
    new_status BOOLEAN,
    change_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    reason TEXT                   -- Reason for status change
);

-- Indexes
CREATE INDEX idx_ads_type ON ads(ad_type);
CREATE INDEX idx_ads_scam ON ads(is_scam);
CREATE INDEX idx_ads_last_seen ON ads(last_seen);
CREATE INDEX idx_search_ads_search_url ON search_ads(search_url);