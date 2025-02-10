-- Table for storing the source redirect information
CREATE TABLE IF NOT EXISTS redirects
(
    id            SERIAL PRIMARY KEY,
    source_url    TEXT NOT NULL, -- The URL that triggers a redirect
    regex_pattern TEXT,          -- Required: a regex pattern to match or filter URLs, used to check for popup
    type          TEXT           -- The type of redirect, stored as a string.
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