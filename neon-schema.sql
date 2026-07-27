-- Run this once against your Neon database.
-- Stores the app's three data documents (shipments, rates, settings) as JSON,
-- matching the {key, value} contract the front-end expects.

CREATE TABLE IF NOT EXISTS app_data (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed sensible defaults so the app has something to load on first run.
INSERT INTO app_data (key, value) VALUES
  ('shipments', '[]'::jsonb),
  ('rates', '[
    {"id":"small-box","name":"Small Box","price":50},
    {"id":"big-bag","name":"Big Bag","price":120},
    {"id":"cement-bag","name":"Cement Bag","price":80},
    {"id":"steel-bar","name":"Steel Bar","price":20}
  ]'::jsonb),
  ('settings', '{"qrUrl":"","ownerPin":"1234","staffPin":"0000"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
