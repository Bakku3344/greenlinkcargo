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
    {"id":"steel-bar","name":"Steel Bar","price":20},
    {"id":"item-a4-paper-rim","name":"A4 Paper Rim (box)","price":20},
    {"id":"item-aggregate-50kg","name":"Aggregate - 50kg (bag)","price":75},
    {"id":"item-air-compressor","name":"Air Compressor (pcs)","price":400},
    {"id":"item-air-condition","name":"Air Condition (pcs)","price":200},
    {"id":"item-air-condition-1800-btu","name":"Air Condition 1800 BTU (pcs)","price":180},
    {"id":"item-air-condition-24-btu","name":"Air Condition 24 BTU (pcs)","price":200},
    {"id":"item-alifaan-nivaafulhi","name":"Alifaan Nivaafulhi (BLT)","price":200},
    {"id":"item-alifaan-nivaafulhi-small","name":"Alifaan Nivaafulhi (Small) (BLT)","price":20},
    {"id":"item-alifaan-nivaafulhi-kuda","name":"Alifaan Nivaafulhi Kuda (BLT)","price":30},
    {"id":"item-aluminium-cladding-dhorufayi","name":"Aluminium Cladding Dhorufayi (pcs)","price":100},
    {"id":"item-aluminium-dor-frame","name":"Aluminium Dor Frame (pcs)","price":100},
    {"id":"item-aluminium-dor-frame-big","name":"Aluminium Dor Frame Big (pcs)","price":250},
    {"id":"item-aluminium-dor-glass-big","name":"Aluminium Dor Glass Big (pcs)","price":350},
    {"id":"item-aluminium-dor-glass-small","name":"Aluminium Dor Glass Small (pcs)","price":250},
    {"id":"item-aluminium-fateh","name":"Aluminium Fateh (pcs)","price":10},
    {"id":"item-aluminium-fati","name":"Aluminium Fati (Nos)","price":20},
    {"id":"item-aluminium-glass-dhorufayi-medium","name":"Aluminium Glass Dhorufayi (Medium) (pcs)","price":250},
    {"id":"item-amplifier","name":"Amplifier","price":10},
    {"id":"item-ander-lear-flooring","name":"Ander Lear Flooring (Roll)","price":30},
    {"id":"item-angel","name":"Angel (pcs)","price":30},
    {"id":"item-angle-25-x25","name":"Angle 25\"x25\" (pcs)","price":20},
    {"id":"item-bag","name":"Bag (pcs)","price":10},
    {"id":"item-banana","name":"Banana (Gandu)","price":10},
    {"id":"item-bandhu-foshi","name":"Bandhu Foshi (box)","price":10},
    {"id":"item-baspar-fathi","name":"Baspar Fathi (pcs)","price":10}
  ]'::jsonb),
  ('settings', '{"qrUrl":"","ownerPin":"1234","staffPin":"0000","ownerEmail":""}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Owner PIN reset: one-time tokens emailed to the registered Owner Gmail.
-- A token is inserted by POST /api/reset-pin/request and consumed by
-- POST /api/reset-pin/confirm. Tokens expire and are single-use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_resets (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'owner',
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- MIGRATION: if your database was already seeded (the INSERT above was a
-- no-op because 'rates' already exists), run this block instead to merge the
-- imported item list into your existing rates without touching items you've
-- already added or edited via the Owner > Rates & Setup screen.
-- ---------------------------------------------------------------------------
-- UPDATE app_data
-- SET value = (
--   SELECT jsonb_agg(item) FROM (
--     SELECT DISTINCT ON (item->>'id') item
--     FROM jsonb_array_elements(value || '[
--       {"id":"item-a4-paper-rim","name":"A4 Paper Rim (box)","price":20},
--       {"id":"item-aggregate-50kg","name":"Aggregate - 50kg (bag)","price":75},
--       {"id":"item-air-compressor","name":"Air Compressor (pcs)","price":400},
--       {"id":"item-air-condition","name":"Air Condition (pcs)","price":200},
--       {"id":"item-air-condition-1800-btu","name":"Air Condition 1800 BTU (pcs)","price":180},
--       {"id":"item-air-condition-24-btu","name":"Air Condition 24 BTU (pcs)","price":200},
--       {"id":"item-alifaan-nivaafulhi","name":"Alifaan Nivaafulhi (BLT)","price":200},
--       {"id":"item-alifaan-nivaafulhi-small","name":"Alifaan Nivaafulhi (Small) (BLT)","price":20},
--       {"id":"item-alifaan-nivaafulhi-kuda","name":"Alifaan Nivaafulhi Kuda (BLT)","price":30},
--       {"id":"item-aluminium-cladding-dhorufayi","name":"Aluminium Cladding Dhorufayi (pcs)","price":100},
--       {"id":"item-aluminium-dor-frame","name":"Aluminium Dor Frame (pcs)","price":100},
--       {"id":"item-aluminium-dor-frame-big","name":"Aluminium Dor Frame Big (pcs)","price":250},
--       {"id":"item-aluminium-dor-glass-big","name":"Aluminium Dor Glass Big (pcs)","price":350},
--       {"id":"item-aluminium-dor-glass-small","name":"Aluminium Dor Glass Small (pcs)","price":250},
--       {"id":"item-aluminium-fateh","name":"Aluminium Fateh (pcs)","price":10},
--       {"id":"item-aluminium-fati","name":"Aluminium Fati (Nos)","price":20},
--       {"id":"item-aluminium-glass-dhorufayi-medium","name":"Aluminium Glass Dhorufayi (Medium) (pcs)","price":250},
--       {"id":"item-amplifier","name":"Amplifier","price":10},
--       {"id":"item-ander-lear-flooring","name":"Ander Lear Flooring (Roll)","price":30},
--       {"id":"item-angel","name":"Angel (pcs)","price":30},
--       {"id":"item-angle-25-x25","name":"Angle 25\"x25\" (pcs)","price":20},
--       {"id":"item-bag","name":"Bag (pcs)","price":10},
--       {"id":"item-banana","name":"Banana (Gandu)","price":10},
--       {"id":"item-bandhu-foshi","name":"Bandhu Foshi (box)","price":10},
--       {"id":"item-baspar-fathi","name":"Baspar Fathi (pcs)","price":10}
--     ]'::jsonb) AS item
--     ORDER BY item->>'id'
--   ) sub
-- )
-- WHERE key = 'rates';
