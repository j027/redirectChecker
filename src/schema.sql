-- Table for storing the source redirect information
CREATE TABLE IF NOT EXISTS redirects
(
    id         SERIAL PRIMARY KEY,
    source_url TEXT NOT NULL, -- The URL that triggers a redirect
    type       TEXT NOT NULL  -- The type of redirect, stored as a string.
);

-- Table for storing where the redirect actually goes,
-- along with timestamps to record when the destination was first and last seen.
CREATE TABLE IF NOT EXISTS redirect_destinations
(
    id                 SERIAL PRIMARY KEY,
    redirect_id        INTEGER     NOT NULL REFERENCES redirects (id) ON DELETE CASCADE,
    destination_url    TEXT UNIQUE NOT NULL,                  -- The target URL where the redirect sends the user
    first_seen         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When this destination was first recorded
    last_seen          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When this destination was most recently observed
    is_scam            BOOLEAN     DEFAULT FALSE,             -- Whether the destination is classified as a scam
    hostname           TEXT UNIQUE NOT NULL,                  -- hostname for deduplication purposes
    classifier_is_scam BOOLEAN     DEFAULT NULL,              -- Raw classifier output
    confidence_score   FLOAT       DEFAULT NULL,              -- Classifier confidence in its prediction
    -- Signal detection columns
    signal_fullscreen          BOOLEAN DEFAULT FALSE,         -- Fullscreen API was requested
    signal_keyboard_lock       BOOLEAN DEFAULT FALSE,         -- Keyboard lock API was requested
    signal_pointer_lock        BOOLEAN DEFAULT FALSE,         -- Pointer lock API was requested
    signal_third_party_hosting BOOLEAN DEFAULT FALSE,         -- Hosted on third-party platform
    signal_ip_address          BOOLEAN DEFAULT FALSE,         -- Hosted on IP address instead of domain
    signal_page_frozen         BOOLEAN DEFAULT FALSE,         -- Page load was frozen/slow (advisory)
    signal_worker_bomb         BOOLEAN DEFAULT FALSE          -- Many web workers spawned (scam tactic)
);

-- Table for tracking takendown status of redirect destinations over time
CREATE TABLE IF NOT EXISTS takedown_status
(
    id                      SERIAL PRIMARY KEY,
    redirect_destination_id INTEGER NOT NULL REFERENCES redirect_destinations (id) ON DELETE CASCADE,

    -- Security service flags (NULL = not flagged, timestamp = when flagged)
    safebrowsing_flagged_at TIMESTAMPTZ DEFAULT NULL, -- When this URL was flagged by Google SafeBrowsing
    netcraft_flagged_at     TIMESTAMPTZ DEFAULT NULL, -- When this URL was flagged by Netcraft
    smartscreen_flagged_at  TIMESTAMPTZ DEFAULT NULL, -- When this URL was flagged by Microsoft SmartScreen

    -- DNS resolution status (NULL = still resolving, timestamp = when first found unresolvable)
    dns_unresolvable_at     TIMESTAMPTZ DEFAULT NULL, -- When the DNS record stopped resolving

    -- Tracking fields
    last_checked            TIMESTAMPTZ DEFAULT NULL, -- When security checks were last performed
    check_active            BOOLEAN     DEFAULT TRUE, -- Whether this URL should be checked in future runs

    UNIQUE (redirect_destination_id)
);

-- Index for efficient lookup of active checks
CREATE INDEX idx_takedown_status_active ON takedown_status (check_active);

-- Table for storing and caching user agents
CREATE TABLE IF NOT EXISTS user_agents
(
    id           SERIAL PRIMARY KEY,
    user_agent   TEXT NOT NULL,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS url_training_dataset
(
    uuid             UUID PRIMARY KEY,
    url              TEXT UNIQUE NOT NULL,
    is_scam          BOOLEAN,
    confidence_score FLOAT,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Main ads table - generic for all ad types
CREATE TABLE IF NOT EXISTS ads
(
    id                 UUID PRIMARY KEY,
    ad_type            VARCHAR(50) NOT NULL,
    initial_url        TEXT        NOT NULL, -- Original ad URL
    final_url          TEXT        NOT NULL, -- Where it ultimately leads
    redirect_path      TEXT[]      NOT NULL, -- PostgreSQL array of URLs in redirect chain
    classifier_is_scam BOOLEAN,              -- Raw classifier output
    confidence_score   FLOAT,                -- Classifier confidence in its prediction
    is_scam            BOOLEAN     NOT NULL, -- Effective decision (classifier_is_scam AND confidence >= threshold AND has signal)
    first_seen         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_updated       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    -- Signal detection columns
    signal_fullscreen          BOOLEAN DEFAULT FALSE,         -- Fullscreen API was requested
    signal_keyboard_lock       BOOLEAN DEFAULT FALSE,         -- Keyboard lock API was requested
    signal_pointer_lock        BOOLEAN DEFAULT FALSE,         -- Pointer lock API was requested
    signal_third_party_hosting BOOLEAN DEFAULT FALSE,         -- Hosted on third-party platform
    signal_ip_address          BOOLEAN DEFAULT FALSE,         -- Hosted on IP address instead of domain
    signal_page_frozen         BOOLEAN DEFAULT FALSE,         -- Page load was frozen/slow (advisory)
    signal_worker_bomb         BOOLEAN DEFAULT FALSE          -- Many web workers spawned (scam tactic)
);

-- Search ad specific attributes
CREATE TABLE IF NOT EXISTS search_ads
(
    ad_id      UUID PRIMARY KEY REFERENCES ads (id) ON DELETE CASCADE,
    ad_url     TEXT NOT NULL, -- The actual clickable URL in the ad
    ad_text    TEXT,          -- The displayed ad text
    search_url TEXT           -- Optional: the URL used to find this ad
);

-- History table to track status changes
CREATE TABLE IF NOT EXISTS ad_status_history
(
    id                   SERIAL PRIMARY KEY,
    ad_id                UUID REFERENCES ads (id) ON DELETE CASCADE,
    previous_status      BOOLEAN,
    new_status           BOOLEAN,
    classifier_is_scam   BOOLEAN,  -- Raw classifier output at time of change
    confidence_score     FLOAT,    -- Classifier confidence at time of change
    change_date          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    reason               TEXT      -- Reason for status change
);

CREATE TABLE IF NOT EXISTS webrisk_monthly_reports
(
    month        DATE PRIMARY KEY,
    report_count INT NOT NULL DEFAULT 0
        CHECK (report_count >= 0)
);

-- Hunter event logs - tracks what each hunter does during its lifecycle
CREATE TABLE IF NOT EXISTS hunter_events (
    id          SERIAL PRIMARY KEY,
    hunter_type VARCHAR(50)  NOT NULL,  -- 'search', 'typosquat', 'pornhub', 'adspyglass', 'scheduler'
    event_type  VARCHAR(50)  NOT NULL,  -- 'cycle_start', 'cycle_end', 'ads_found', 'ad_processed', 'scam_detected', 'error', 'skipped', 'timeout', etc.
    message     TEXT         NOT NULL,  -- Human-readable log message
    details     JSONB        DEFAULT NULL, -- Structured data (URLs, counts, errors, classification results, etc.)
    created_at  TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

-- Redirect checker event logs - tracks redirect monitoring activity
CREATE TABLE IF NOT EXISTS redirect_events (
    id          SERIAL PRIMARY KEY,
    event_type  VARCHAR(50)  NOT NULL,  -- 'check_start', 'check_end', 'new_destination', 'classification', 'scam_found', 'no_redirect', 'error'
    source_url  TEXT         DEFAULT NULL, -- The redirect source URL being checked
    message     TEXT         NOT NULL,  -- Human-readable log message
    details     JSONB        DEFAULT NULL, -- Structured data
    created_at  TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

-- Persistent append-only log of every scam detection (never pruned)
CREATE TABLE IF NOT EXISTS scam_reports (
    id          SERIAL PRIMARY KEY,
    url         TEXT NOT NULL,
    source_type VARCHAR(50) NOT NULL,  -- 'redirect', 'search', 'pornhub', 'typosquat', 'adspyglass'
    detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scam_reports_detected ON scam_reports (detected_at);
CREATE INDEX idx_ads_type ON ads (ad_type);
CREATE INDEX idx_ads_scam ON ads (is_scam);
CREATE INDEX idx_ads_last_seen ON ads (last_seen);
CREATE INDEX idx_search_ads_search_url ON search_ads (search_url);
CREATE INDEX idx_redirect_destinations_hostname ON redirect_destinations (hostname);
CREATE INDEX idx_hunter_events_type ON hunter_events (hunter_type);
CREATE INDEX idx_hunter_events_event ON hunter_events (event_type);
CREATE INDEX idx_hunter_events_created ON hunter_events (created_at DESC);
CREATE INDEX idx_redirect_events_type ON redirect_events (event_type);
CREATE INDEX idx_redirect_events_created ON redirect_events (created_at DESC);

-- Safe Browsing v5: tracks metadata/version state for each hash list
CREATE TABLE IF NOT EXISTS safebrowsing_hash_lists (
    name         TEXT PRIMARY KEY,
    version      BYTEA DEFAULT NULL,
    last_updated TIMESTAMPTZ DEFAULT NULL,
    next_update_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe Browsing v5: stores hash prefixes from downloaded threat/global-cache lists
CREATE TABLE IF NOT EXISTS safebrowsing_hash_prefixes (
    list_name    TEXT NOT NULL REFERENCES safebrowsing_hash_lists(name) ON DELETE CASCADE,
    hash_prefix  BYTEA NOT NULL,
    PRIMARY KEY (list_name, hash_prefix)
);

CREATE INDEX idx_safebrowsing_hash_prefixes_prefix ON safebrowsing_hash_prefixes (hash_prefix);

-- Safe Browsing v5: local cache for hashes.search API responses
CREATE TABLE IF NOT EXISTS safebrowsing_hash_cache (
    hash_prefix  BYTEA NOT NULL,
    full_hash    BYTEA NOT NULL,
    threat_types TEXT[] NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (hash_prefix, full_hash)
);

CREATE INDEX idx_safebrowsing_hash_cache_prefix ON safebrowsing_hash_cache (hash_prefix);
CREATE INDEX idx_safebrowsing_hash_cache_expires ON safebrowsing_hash_cache (expires_at);

-- URLScan hunter: individual report log
CREATE TABLE IF NOT EXISTS urlscan_reports (
    id                      SERIAL PRIMARY KEY,
    urlscan_uuid            TEXT NOT NULL UNIQUE,              -- urlscan result UUID (dedup key)
    url                     TEXT NOT NULL,                     -- the scam URL
    classifier_confidence   FLOAT NOT NULL,                   -- classifier score from browser verification
    reported_to_netcraft    BOOLEAN DEFAULT FALSE,            -- did netcraft report succeed?
    classifier_is_scam      BOOLEAN,                          -- did classifier flag as scam?
    has_weighted_signal     BOOLEAN,                          -- did any weighted signal fire?
    signal_fullscreen       BOOLEAN DEFAULT FALSE,
    signal_keyboard_lock    BOOLEAN DEFAULT FALSE,
    signal_pointer_lock     BOOLEAN DEFAULT FALSE,
    signal_third_party_hosting BOOLEAN DEFAULT FALSE,
    signal_ip_address       BOOLEAN DEFAULT FALSE,
    signal_page_frozen      BOOLEAN DEFAULT FALSE,
    signal_worker_bomb      BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_urlscan_reports_created ON urlscan_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_urlscan_reports_url ON urlscan_reports (url);

-- URLScan hunter: daily scan statistics (one row per day, upserted)
CREATE TABLE IF NOT EXISTS urlscan_scan_stats (
    date                  DATE PRIMARY KEY DEFAULT CURRENT_DATE,
    urls_scanned          INTEGER NOT NULL DEFAULT 0,         -- total results processed from feed
    urls_classified_scam  INTEGER NOT NULL DEFAULT 0,         -- classifier >= 0.90 (before signal check)
    urls_reported         INTEGER NOT NULL DEFAULT 0          -- successfully reported to Netcraft
);

-- Abuse reports audit log - tracks MSRC and XARF reports sent to hosting providers (never pruned)
CREATE TABLE IF NOT EXISTS abuse_reports (
    id              SERIAL PRIMARY KEY,
    provider        TEXT NOT NULL,              -- 'msrc', 'laravel-forge', etc.
    report_type     TEXT NOT NULL,              -- 'msrc_api', 'xarf_email'
    scam_url        TEXT NOT NULL,              -- the reported scam URL
    source_url      TEXT,                       -- the ad/redirect source URL (if available)
    report_payload  JSONB,                      -- full report body sent (MSRC JSON or XARF JSON)
    response_status TEXT,                       -- HTTP status or email send status
    response_body   TEXT,                       -- API response or SMTP response
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_provider ON abuse_reports(provider);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_reported_at ON abuse_reports(reported_at);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_dedup ON abuse_reports(provider, scam_url);