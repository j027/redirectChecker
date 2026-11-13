-- Lightweight outbound report ledger. One row per report channel attempt.
-- abuse_reports remains the full payload store for MSRC/XARF; this table links
-- to it through abuse_report_id. redirect_destination_id and ad_id are soft
-- references because reportSite() currently runs inside the destination/ad
-- transaction, so hard FKs would block on uncommitted rows.
CREATE TABLE IF NOT EXISTS report_submissions (
    id                       BIGSERIAL PRIMARY KEY,
    channel                  TEXT NOT NULL,
    category                 TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'queued',
    url                      TEXT NOT NULL,
    source_url               TEXT,
    provider                 TEXT,
    redirect_destination_id  BIGINT,
    ad_id                    UUID,
    submitted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at               TIMESTAMPTZ,
    completed_at             TIMESTAMPTZ,
    http_status              INTEGER,
    external_id              TEXT,
    external_url             TEXT,
    response_snippet         TEXT,
    error_message            TEXT,
    abuse_report_id          INTEGER REFERENCES abuse_reports(id) ON DELETE SET NULL,
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT report_submissions_category_check
        CHECK (category IN ('scan', 'threat_intel', 'abuse_report', 'notification')),
    CONSTRAINT report_submissions_status_check
        CHECK (status IN (
            'queued', 'success', 'submitted', 'error',
            'captcha', 'blocked', 'rejected', 'skipped', 'abandoned'
        ))
);

CREATE INDEX IF NOT EXISTS idx_report_submissions_channel_time
    ON report_submissions (channel, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_submissions_url_time
    ON report_submissions (url, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_submissions_destination
    ON report_submissions (redirect_destination_id, channel, submitted_at DESC)
    WHERE redirect_destination_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_report_submissions_followup
    ON report_submissions (channel, external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_report_submissions_pending
    ON report_submissions (channel, submitted_at)
    WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_report_submissions_submitted_at
    ON report_submissions (submitted_at DESC);

-- First successful report per destination/channel, mapped to the flag or
-- provider suspension it is expected to influence. Time-to-action should be
-- measured from first_success_at; first_requested_at includes queue/retry time.
CREATE OR REPLACE VIEW report_action_times AS
WITH first_report AS (
    SELECT
        redirect_destination_id,
        channel,
        MIN(submitted_at) AS first_requested_at,
        MIN(started_at) AS first_started_at,
        MIN(completed_at) FILTER (
            WHERE status IN ('success', 'submitted')
        ) AS first_success_at
    FROM report_submissions
    WHERE redirect_destination_id IS NOT NULL
    GROUP BY redirect_destination_id, channel
)
SELECT
    fr.redirect_destination_id,
    rd.destination_url,
    fr.channel,
    CASE
        WHEN fr.channel IN ('safe_browsing_crx', 'safe_browsing_web_form', 'web_risk')
            THEN 'safe_browsing'
        ELSE fr.channel
    END AS channel_group,
    fr.first_requested_at,
    fr.first_started_at,
    fr.first_success_at,
    CASE fr.channel
        WHEN 'safe_browsing_crx' THEN ts.safebrowsing_flagged_at
        WHEN 'safe_browsing_web_form' THEN ts.safebrowsing_flagged_at
        WHEN 'web_risk' THEN ts.safebrowsing_flagged_at
        WHEN 'netcraft' THEN ts.netcraft_flagged_at
        WHEN 'smartscreen' THEN ts.smartscreen_flagged_at
        WHEN 'xarf' THEN
            CASE WHEN ts.host_status_provider = 'forge' THEN ts.host_status_at END
    END AS action_at,
    CASE
        WHEN fr.channel IN ('safe_browsing_crx', 'safe_browsing_web_form', 'web_risk')
            THEN 'safebrowsing_flag'
        WHEN fr.channel = 'netcraft' THEN 'netcraft_flag'
        WHEN fr.channel = 'smartscreen' THEN 'smartscreen_flag'
        WHEN fr.channel = 'xarf' THEN 'host_suspension'
    END AS action_kind,
    ts.host_status_provider
FROM first_report fr
JOIN redirect_destinations rd ON rd.id = fr.redirect_destination_id
JOIN takedown_status ts ON ts.redirect_destination_id = fr.redirect_destination_id;
