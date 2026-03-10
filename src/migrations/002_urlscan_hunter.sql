-- Migration: Add urlscan hunter tables
-- Run this on existing deployments that already have the base schema

CREATE TABLE IF NOT EXISTS urlscan_reports (
    id                      SERIAL PRIMARY KEY,
    urlscan_uuid            TEXT NOT NULL UNIQUE,
    url                     TEXT NOT NULL,
    classifier_confidence   FLOAT NOT NULL,
    signals                 JSONB,
    reported_to_netcraft    BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_urlscan_reports_created ON urlscan_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_urlscan_reports_url ON urlscan_reports (url);

CREATE TABLE IF NOT EXISTS urlscan_scan_stats (
    date                  DATE PRIMARY KEY DEFAULT CURRENT_DATE,
    urls_scanned          INTEGER NOT NULL DEFAULT 0,
    urls_classified_scam  INTEGER NOT NULL DEFAULT 0,
    urls_reported         INTEGER NOT NULL DEFAULT 0
);
