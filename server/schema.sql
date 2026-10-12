-- Astra Insights for Kearney: Postgres schema (demo build)
-- All value-bearing tables are seeded by connector stubs; reference tables hold real, sourced data.

CREATE TABLE IF NOT EXISTS seed_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, users INT NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL REFERENCES regions(id)
);
CREATE TABLE IF NOT EXISTS offices (
  id TEXT PRIMARY KEY, city TEXT NOT NULL, country TEXT NOT NULL,
  unit TEXT NOT NULL REFERENCES units(id), region TEXT NOT NULL REFERENCES regions(id),
  users INT NOT NULL, contractors INT NOT NULL, employees INT NOT NULL,
  lat DOUBLE PRECISION, lon DOUBLE PRECISION, lang TEXT
);
CREATE TABLE IF NOT EXISTS kearney_companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, focus TEXT, office TEXT, acquired INT
);
CREATE TABLE IF NOT EXISTS practices (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS industries (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS levels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rank INT NOT NULL,
  client_service BOOLEAN NOT NULL, util_target NUMERIC, standard_rate NUMERIC, cost_rate NUMERIC,
  typical_months_in_level INT
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  office TEXT REFERENCES offices(id), unit TEXT REFERENCES units(id), region TEXT REFERENCES regions(id),
  level TEXT REFERENCES levels(id), type TEXT NOT NULL, client_service BOOLEAN NOT NULL,
  practice TEXT, industry TEXT, hire_date DATE, months_in_level INT, last_promotion DATE,
  counsellor_id TEXT, counsellor_changed BOOLEAN DEFAULT FALSE,
  skills TEXT[], languages TEXT[],
  travel_weeks INT DEFAULT 0, sustained_weeks INT DEFAULT 0, weekend_days INT DEFAULT 0,
  flight_risk NUMERIC, flight_drivers JSONB, burnout_flag BOOLEAN DEFAULT FALSE,
  engagement_score NUMERIC, learning_hours NUMERIC, roll_off_date DATE,
  status TEXT DEFAULT 'active', left_date DATE, regretted BOOLEAN DEFAULT FALSE,
  kearney_company TEXT, source TEXT DEFAULT 'stub:peoplesoft'
);
CREATE INDEX IF NOT EXISTS idx_people_unit_level ON people(unit, level);
CREATE INDEX IF NOT EXISTS idx_people_office ON people(office);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_public BOOLEAN NOT NULL DEFAULT FALSE,
  industry TEXT REFERENCES industries(id), region TEXT, unit TEXT, fortune_g500 BOOLEAN DEFAULT FALSE,
  public_work TEXT, public_year INT, public_source TEXT,
  relationship_partner TEXT, first_engaged DATE, satisfaction NUMERIC, satisfaction_prev NUMERIC,
  sentiment_themes JSONB, payment_behaviour NUMERIC, source TEXT DEFAULT 'stub:sap'
);

CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY, client_id TEXT REFERENCES clients(id),
  practice TEXT, industry TEXT, unit TEXT, office TEXT, region TEXT,
  partner_id TEXT, principal_id TEXT, fee_model TEXT,
  budget_fees NUMERIC, budget_hours NUMERIC, standard_rate NUMERIC,
  start_date DATE, end_date DATE, status TEXT,
  health_score NUMERIC, overrun_prob NUMERIC, predicted_overrun_date DATE,
  eac NUMERIC, margin_at_completion NUMERIC, write_off_risk NUMERIC, realisation_forecast NUMERIC,
  kearney_company TEXT, scope_changes INT DEFAULT 0, reuses_asset BOOLEAN DEFAULT FALSE,
  expert_calls INT DEFAULT 0, workstreams JSONB, team_size INT, planted TEXT,
  source TEXT DEFAULT 'stub:sap'
);
CREATE INDEX IF NOT EXISTS idx_eng_unit ON engagements(unit);
CREATE INDEX IF NOT EXISTS idx_eng_client ON engagements(client_id);

CREATE TABLE IF NOT EXISTS engagement_months (
  engagement_id TEXT REFERENCES engagements(id), month DATE NOT NULL,
  hours NUMERIC, standard_value NUMERIC, discount NUMERIC, write_off NUMERIC,
  overrun_unbilled NUMERIC, delayed NUMERIC, billed NUMERIC,
  staff_cost NUMERIC, expenses NUMERIC, unrecovered_expense NUMERIC, collected NUMERIC,
  unbilled_wip NUMERIC, PRIMARY KEY (engagement_id, month)
);
CREATE INDEX IF NOT EXISTS idx_em_month ON engagement_months(month);

CREATE TABLE IF NOT EXISTS person_months (
  person_id TEXT REFERENCES people(id), month DATE NOT NULL,
  chargeable_hours NUMERIC, available_hours NUMERIC, recorded_hours NUMERIC,
  timesheets_due INT, timesheets_late INT, PRIMARY KEY (person_id, month)
);
CREATE INDEX IF NOT EXISTS idx_pm_month ON person_months(month);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, engagement_id TEXT, client_id TEXT, unit TEXT, region TEXT,
  issue_date DATE, due_date DATE, amount NUMERIC, paid_date DATE, status TEXT,
  late_prob NUMERIC, late_drivers JSONB, disputed BOOLEAN DEFAULT FALSE, source TEXT DEFAULT 'stub:sap'
);
CREATE INDEX IF NOT EXISTS idx_inv_client ON invoices(client_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY, client_id TEXT, practice TEXT, industry TEXT, unit TEXT, region TEXT,
  partner_id TEXT, stage TEXT, value NUMERIC, created_date DATE, expected_close DATE, decided_date DATE,
  outcome TEXT, win_prob NUMERIC, win_drivers JSONB, last_activity DATE, fee_model TEXT,
  is_new_client BOOLEAN DEFAULT FALSE, expected_start DATE, source TEXT DEFAULT 'stub:salesforce'
);
CREATE INDEX IF NOT EXISTS idx_opp_unit ON opportunities(unit);

CREATE TABLE IF NOT EXISTS plan (
  unit TEXT REFERENCES units(id), month DATE NOT NULL,
  revenue_plan NUMERIC, margin_plan NUMERIC, util_target NUMERIC, headcount_plan INT,
  collections_plan NUMERIC, PRIMARY KEY (unit, month)
);
CREATE TABLE IF NOT EXISTS fx_rates (
  month DATE NOT NULL, currency TEXT NOT NULL, plan_rate NUMERIC, actual_rate NUMERIC,
  revenue_share NUMERIC, source TEXT DEFAULT 'market', PRIMARY KEY (month, currency)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, client_id TEXT REFERENCES clients(id), title TEXT,
  kearney_person_id TEXT, last_contact DATE, strength INT, source TEXT DEFAULT 'stub:salesforce'
);

CREATE TABLE IF NOT EXISTS knowledge_assets (
  id TEXT PRIMARY KEY, title TEXT, type TEXT, practice TEXT, is_public BOOLEAN DEFAULT FALSE,
  downloads INT, citations INT, reuse_count INT, attributed_leads INT, attributed_pipeline NUMERIC,
  source TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_search_topics (
  topic TEXT PRIMARY KEY, searches INT, opened INT, source TEXT DEFAULT 'stub:glean'
);

CREATE TABLE IF NOT EXISTS servicenow_tickets (
  month DATE NOT NULL, application TEXT NOT NULL, incidents INT, requests INT,
  source TEXT NOT NULL, PRIMARY KEY (month, application)
);
CREATE TABLE IF NOT EXISTS app_adoption (
  application TEXT PRIMARY KEY, licensed INT, active_30d INT, source TEXT
);

CREATE TABLE IF NOT EXISTS staffing_roles (
  id TEXT PRIMARY KEY, engagement_id TEXT, client_id TEXT, level TEXT, skills TEXT[], location TEXT,
  unit TEXT, start_date DATE, weeks INT, requested_date DATE, filled_date DATE, status TEXT,
  language TEXT, source TEXT DEFAULT 'stub:staffing'
);

CREATE TABLE IF NOT EXISTS actions (
  id SERIAL PRIMARY KEY, persona TEXT, trigger_insight TEXT, action_type TEXT, title TEXT, body TEXT,
  owner TEXT, due_date DATE, status TEXT DEFAULT 'pending', connector TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), decided_at TIMESTAMPTZ, decided_by TEXT, payload JSONB
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), persona TEXT, question TEXT, intent TEXT,
  agents JSONB, duration_ms INT, cost_usd NUMERIC, guardian JSONB, blocked BOOLEAN DEFAULT FALSE,
  feedback INT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT now(), persona TEXT, event TEXT, detail JSONB
);
CREATE TABLE IF NOT EXISTS boards (
  id SERIAL PRIMARY KEY, persona TEXT, title TEXT, question TEXT, visual JSONB, schedule TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id SERIAL PRIMARY KEY, persona TEXT, start_ts TIMESTAMPTZ, end_ts TIMESTAMPTZ, title TEXT,
  client_id TEXT, is_client_meeting BOOLEAN DEFAULT FALSE, attachments JSONB, source TEXT DEFAULT 'stub:graph'
);
CREATE TABLE IF NOT EXISTS model_registry (
  id INT PRIMARY KEY, name TEXT, predicts TEXT, grain TEXT, method TEXT, version TEXT,
  accuracy JSONB, trained_at DATE, status TEXT, retrain TEXT, uses_llm BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS metric_anomalies (
  id SERIAL PRIMARY KEY, metric_id TEXT, dimension TEXT, member TEXT, month DATE,
  value NUMERIC, expected NUMERIC, lower NUMERIC, upper NUMERIC, severity TEXT, direction TEXT
);
CREATE TABLE IF NOT EXISTS conversation_memory (
  session TEXT PRIMARY KEY, memory JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), updated_by TEXT
);
