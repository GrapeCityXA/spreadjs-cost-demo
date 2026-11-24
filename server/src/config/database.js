const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { getDatabasePath, getCollaborationDatabasePath, getTemplateDirectory } = require('./storage');

const businessMigrations = [{
  version: 1,
  name: 'v1_business_schema',
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      name TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, organization_id INTEGER REFERENCES organizations(id),
      account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('active','disabled')),
      identity_provider TEXT NOT NULL DEFAULT 'local', identity_subject TEXT, email TEXT,
      CHECK(identity_provider = 'local' OR identity_subject IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      organization_type TEXT NOT NULL DEFAULT 'company', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS organization_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER NOT NULL REFERENCES organizations(id),
      alias TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
      CHECK(effective_to IS NULL OR effective_to >= effective_from), UNIQUE(organization_id, alias, effective_from)
    );
    CREATE TABLE IF NOT EXISTS organization_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, parent_organization_id INTEGER NOT NULL REFERENCES organizations(id),
      child_organization_id INTEGER NOT NULL REFERENCES organizations(id), effective_from TEXT NOT NULL,
      effective_to TEXT, CHECK(parent_organization_id <> child_organization_id),
      CHECK(effective_to IS NULL OR effective_to >= effective_from), UNIQUE(child_organization_id, effective_from)
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL REFERENCES users(id), role_code TEXT NOT NULL,
      organization_id INTEGER REFERENCES organizations(id), effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      effective_to TEXT, granted_by INTEGER REFERENCES users(id), PRIMARY KEY(user_id, role_code, organization_id)
    );
    CREATE TABLE IF NOT EXISTS datasources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, factory TEXT,
      status TEXT NOT NULL DEFAULT 'draft', created_by INTEGER NOT NULL REFERENCES users(id), template_file_path TEXT,
      datasource_type TEXT, datasource_id INTEGER REFERENCES datasources(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, period TEXT, factory TEXT, status TEXT DEFAULT 'draft',
      template_id INTEGER REFERENCES templates(id), template_file_path TEXT, datasource_id INTEGER REFERENCES datasources(id),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER REFERENCES reports(id), action TEXT NOT NULL,
      old_status TEXT, new_status TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      comment TEXT, actor_user_id INTEGER REFERENCES users(id), organization_id INTEGER REFERENCES organizations(id),
      entity_type TEXT, entity_id TEXT, request_id TEXT, details_json TEXT
    );
    CREATE TABLE IF NOT EXISTS template_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL REFERENCES templates(id), change_version TEXT NOT NULL,
      commands TEXT NOT NULL, template_data TEXT NOT NULL, datasource_data TEXT, description TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS template_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, change_id INTEGER NOT NULL REFERENCES template_changes(id),
      report_id INTEGER NOT NULL REFERENCES reports(id), status TEXT DEFAULT 'pending', executed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS field_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      data_type TEXT NOT NULL CHECK(data_type IN ('text','decimal','integer','boolean','date','json')),
      unit TEXT, precision INTEGER NOT NULL DEFAULT 0 CHECK(precision BETWEEN 0 AND 12), editable INTEGER NOT NULL DEFAULT 1 CHECK(editable IN (0,1)),
      applicability_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
      version INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS field_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, proposed_code TEXT NOT NULL, proposal_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id), review_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rule_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, rule_type TEXT NOT NULL CHECK(rule_type IN ('validation','anomaly','formula')),
      display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
      created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER NOT NULL REFERENCES rule_definitions(id), version INTEGER NOT NULL,
      expression_json TEXT NOT NULL, parameters_json TEXT NOT NULL DEFAULT '{}', severity TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_review','published','rejected','retired')),
      created_by INTEGER NOT NULL REFERENCES users(id), reviewed_by INTEGER REFERENCES users(id), published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(rule_id, version), CHECK(reviewed_by IS NULL OR reviewed_by <> created_by)
    );
    CREATE TABLE IF NOT EXISTS template_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, component_type TEXT NOT NULL CHECK(component_type IN ('header','body','footer')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS template_component_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, component_id INTEGER NOT NULL REFERENCES template_components(id), version INTEGER NOT NULL,
      workbook_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','retired')),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(component_id, version)
    );
    CREATE TABLE IF NOT EXISTS template_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL REFERENCES templates(id), version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','published','superseded','rejected')),
      manifest_json TEXT NOT NULL DEFAULT '{}', workbook_json TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
      reviewed_by INTEGER REFERENCES users(id), published_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(template_id, version)
    );
    CREATE TABLE IF NOT EXISTS template_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_version_id INTEGER NOT NULL REFERENCES template_versions(id),
      sheet_code TEXT NOT NULL, display_name TEXT NOT NULL, sheet_order INTEGER NOT NULL, sheet_type TEXT NOT NULL DEFAULT 'business',
      header_component_version_id INTEGER REFERENCES template_component_versions(id), body_component_version_id INTEGER REFERENCES template_component_versions(id),
      footer_component_version_id INTEGER REFERENCES template_component_versions(id), UNIQUE(template_version_id, sheet_code), UNIQUE(template_version_id, sheet_order)
    );
    CREATE TABLE IF NOT EXISTS template_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, template_version_id INTEGER NOT NULL REFERENCES template_versions(id),
      field_definition_id INTEGER NOT NULL REFERENCES field_definitions(id), sheet_code TEXT NOT NULL, named_area TEXT NOT NULL,
      tag_code TEXT, source_kind TEXT NOT NULL CHECK(source_kind IN ('input','table','calculated','reference')),
      mapping_json TEXT NOT NULL DEFAULT '{}', primary_source INTEGER NOT NULL DEFAULT 0 CHECK(primary_source IN (0,1)),
      UNIQUE(template_version_id, sheet_code, named_area)
    );
    CREATE TABLE IF NOT EXISTS report_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      cadence TEXT NOT NULL CHECK(cadence IN ('monthly','quarterly')), workflow_profile TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS period_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type_id INTEGER NOT NULL REFERENCES report_types(id), period_code TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, template_version_id INTEGER NOT NULL REFERENCES template_versions(id), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validated','active','closed')),
      configuration_json TEXT NOT NULL DEFAULT '{}', created_by INTEGER NOT NULL REFERENCES users(id), activated_by INTEGER REFERENCES users(id), activated_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(report_type_id, period_code, version)
    );
    CREATE TABLE IF NOT EXISTS package_organizations (
      package_id INTEGER NOT NULL REFERENCES period_packages(id), organization_id INTEGER NOT NULL REFERENCES organizations(id),
      included INTEGER NOT NULL DEFAULT 1 CHECK(included IN (0,1)), deadline_at TEXT NOT NULL, extension_deadline_at TEXT,
      targets_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(package_id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS package_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES period_packages(id),
      organization_id INTEGER NOT NULL REFERENCES organizations(id), responsibility TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id), assigned_by INTEGER NOT NULL REFERENCES users(id), reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS report_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES period_packages(id),
      report_type_id INTEGER NOT NULL REFERENCES report_types(id), organization_id INTEGER NOT NULL REFERENCES organizations(id),
      period_code TEXT NOT NULL, task_status TEXT NOT NULL DEFAULT 'draft', deadline_at TEXT NOT NULL,
      configuration_snapshot_json TEXT NOT NULL, template_version_id INTEGER NOT NULL REFERENCES template_versions(id),
      current_revision_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(package_id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS task_indicators (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), indicator_code TEXT NOT NULL,
      parent_id INTEGER REFERENCES task_indicators(id), field_definition_id INTEGER REFERENCES field_definitions(id), display_name TEXT NOT NULL,
      indicator_type TEXT NOT NULL, weight REAL, sort_order INTEGER NOT NULL DEFAULT 0, configuration_json TEXT NOT NULL DEFAULT '{}', UNIQUE(task_id, indicator_code)
    );
    CREATE TABLE IF NOT EXISTS collaboration_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), revision_number INTEGER NOT NULL,
      collaboration_room_key TEXT NOT NULL UNIQUE, collaboration_db TEXT NOT NULL, latest_version INTEGER NOT NULL DEFAULT 0,
      room_status TEXT NOT NULL DEFAULT 'open' CHECK(room_status IN ('open','frozen','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS business_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), revision_number INTEGER NOT NULL,
      revision_status TEXT NOT NULL, submitted_by INTEGER REFERENCES users(id), submitted_at TEXT,
      collaboration_room_id INTEGER REFERENCES collaboration_rooms(id), collaboration_version INTEGER,
      workbook_artifact_id INTEGER, source_revision_id INTEGER REFERENCES business_revisions(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS business_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      task_id INTEGER NOT NULL REFERENCES report_tasks(id), record_key TEXT NOT NULL DEFAULT '', field_definition_id INTEGER NOT NULL REFERENCES field_definitions(id),
      value_type TEXT NOT NULL CHECK(value_type IN ('text','decimal','integer','boolean','date','json')),
      text_value TEXT, decimal_value TEXT, integer_value INTEGER, boolean_value INTEGER CHECK(boolean_value IN (0,1)), date_value TEXT, json_value TEXT,
      source_formula TEXT, entered_by INTEGER REFERENCES users(id), UNIQUE(revision_id, record_key, field_definition_id),
      CHECK((value_type='text' AND text_value IS NOT NULL AND decimal_value IS NULL AND integer_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND json_value IS NULL)
        OR (value_type='decimal' AND decimal_value IS NOT NULL AND text_value IS NULL AND integer_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND json_value IS NULL)
        OR (value_type='integer' AND integer_value IS NOT NULL AND text_value IS NULL AND decimal_value IS NULL AND boolean_value IS NULL AND date_value IS NULL AND json_value IS NULL)
        OR (value_type='boolean' AND boolean_value IS NOT NULL AND text_value IS NULL AND decimal_value IS NULL AND integer_value IS NULL AND date_value IS NULL AND json_value IS NULL)
        OR (value_type='date' AND date_value IS NOT NULL AND text_value IS NULL AND decimal_value IS NULL AND integer_value IS NULL AND boolean_value IS NULL AND json_value IS NULL)
        OR (value_type='json' AND json_value IS NOT NULL AND text_value IS NULL AND decimal_value IS NULL AND integer_value IS NULL AND boolean_value IS NULL AND date_value IS NULL))
    );
    CREATE TABLE IF NOT EXISTS review_opinions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id), reviewer_id INTEGER NOT NULL REFERENCES users(id),
      department_code TEXT, opinion TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('accept','return','comment')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(revision_id, reviewer_id, department_code)
    );
    CREATE TABLE IF NOT EXISTS indicator_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id), indicator_id INTEGER NOT NULL REFERENCES task_indicators(id),
      scorer_id INTEGER NOT NULL REFERENCES users(id), score REAL NOT NULL, comment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(revision_id, indicator_id, scorer_id)
    );
    CREATE TABLE IF NOT EXISTS score_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id), adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('reward','penalty')),
      amount REAL NOT NULL, reason TEXT NOT NULL, approved_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS anomaly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id), rule_version_id INTEGER REFERENCES rule_versions(id),
      field_definition_id INTEGER REFERENCES field_definitions(id), severity TEXT NOT NULL, message TEXT NOT NULL,
      explanation TEXT, disposition TEXT CHECK(disposition IN ('accepted','correction_requested')), reviewer_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS adjustment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), source_revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      proposed_revision_id INTEGER REFERENCES business_revisions(id), status TEXT NOT NULL DEFAULT 'draft', reason TEXT NOT NULL,
      requested_by INTEGER NOT NULL REFERENCES users(id), approved_by INTEGER REFERENCES users(id), impact_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), revision_id INTEGER REFERENCES business_revisions(id),
      indicator_code TEXT, original_name TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      sha256 TEXT NOT NULL, uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS official_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, revision_id INTEGER NOT NULL REFERENCES business_revisions(id), artifact_type TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS export_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES period_packages(id), requested_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','complete','failed','expired')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), storage_key TEXT, expires_at TEXT, error_text TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), task_id INTEGER REFERENCES report_tasks(id),
      notification_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', scheduled_at TEXT, sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','read')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id), responsibility TEXT NOT NULL,
      previous_user_id INTEGER REFERENCES users(id), new_user_id INTEGER NOT NULL REFERENCES users(id),
      changed_by INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS task_deadline_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id),
      previous_deadline_at TEXT NOT NULL, new_deadline_at TEXT NOT NULL, changed_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS package_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES period_packages(id),
      organization_id INTEGER NOT NULL REFERENCES organizations(id), field_definition_id INTEGER NOT NULL REFERENCES field_definitions(id),
      target_phase TEXT NOT NULL CHECK(target_phase IN ('annual','monthly','cumulative','quarterly')),
      phase_period TEXT NOT NULL, amount_decimal TEXT NOT NULL, generated_from_annual INTEGER NOT NULL DEFAULT 0 CHECK(generated_from_annual IN (0,1)),
      UNIQUE(package_id, organization_id, field_definition_id, target_phase, phase_period)
    );
    CREATE TABLE IF NOT EXISTS report_rankings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES period_packages(id),
      organization_id INTEGER NOT NULL REFERENCES organizations(id), revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      ranking_type TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank > 0), score_decimal TEXT, calculation_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(package_id, ranking_type, organization_id)
    );
    CREATE TABLE IF NOT EXISTS historical_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type_id INTEGER NOT NULL REFERENCES report_types(id), period_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','validated','imported','rejected')),
      source_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, requested_by INTEGER NOT NULL REFERENCES users(id),
      result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, imported_at TEXT
    );
    CREATE TABLE IF NOT EXISTS historical_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES historical_import_batches(id),
      row_number INTEGER NOT NULL, organization_id INTEGER REFERENCES organizations(id), row_status TEXT NOT NULL,
      values_json TEXT NOT NULL, errors_json TEXT NOT NULL DEFAULT '[]', UNIQUE(batch_id, row_number)
    );
    CREATE TABLE IF NOT EXISTS backup_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, backup_key TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','complete','failed')), created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS restore_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, backup_id INTEGER NOT NULL REFERENCES backup_records(id),
      restored_by INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, status TEXT NOT NULL,
      restored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(actor_user_id, operation, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
    CREATE INDEX IF NOT EXISTS idx_org_relationship_child_dates ON organization_relationships(child_organization_id, effective_from, effective_to);
    CREATE INDEX IF NOT EXISTS idx_roles_user_scope ON user_roles(user_id, role_code, organization_id);
    CREATE INDEX IF NOT EXISTS idx_fields_status_code ON field_definitions(status, code);
    CREATE INDEX IF NOT EXISTS idx_rules_type_status ON rule_definitions(rule_type, status);
    CREATE INDEX IF NOT EXISTS idx_template_versions_status ON template_versions(template_id, status, version);
    CREATE INDEX IF NOT EXISTS idx_package_status_period ON period_packages(status, period_code);
    CREATE INDEX IF NOT EXISTS idx_tasks_org_period_status ON report_tasks(organization_id, period_code, task_status);
    CREATE INDEX IF NOT EXISTS idx_revisions_task_status ON business_revisions(task_id, revision_status, revision_number);
    CREATE INDEX IF NOT EXISTS idx_values_task_field ON business_values(task_id, field_definition_id, revision_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_revision ON review_opinions(revision_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_anomalies_revision_severity ON anomaly_snapshots(revision_id, severity);
    CREATE INDEX IF NOT EXISTS idx_attachments_revision ON attachments(revision_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_revision_type ON official_artifacts(revision_id, artifact_type);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_status ON notifications(user_id, status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity_time ON audit_logs(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs(actor_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_assignment_current ON task_assignment_history(task_id, responsibility, changed_at);
    CREATE INDEX IF NOT EXISTS idx_targets_package_org_phase ON package_targets(package_id, organization_id, target_phase, phase_period);
    CREATE INDEX IF NOT EXISTS idx_rankings_package_type_rank ON report_rankings(package_id, ranking_type, rank);
    CREATE INDEX IF NOT EXISTS idx_import_batches_period_status ON historical_import_batches(period_code, status);
    CREATE INDEX IF NOT EXISTS idx_import_rows_batch_status ON historical_import_rows(batch_id, row_status);
  `
}, {
  version: 2,
  name: 'organization_effective_dates_and_admin_indexes',
  sql: `
    ALTER TABLE organizations ADD COLUMN effective_from TEXT NOT NULL DEFAULT '1970-01-01';
    ALTER TABLE organizations ADD COLUMN effective_to TEXT;
    CREATE INDEX IF NOT EXISTS idx_org_status_code ON organizations(status, code);
    CREATE INDEX IF NOT EXISTS idx_alias_org_effective ON organization_aliases(organization_id, effective_from, effective_to);
    CREATE INDEX IF NOT EXISTS idx_user_roles_effective ON user_roles(user_id, effective_from, effective_to);
  `
}, {
  version: 3,
  name: 'role_assignment_history',
  sql: `
    ALTER TABLE user_roles RENAME TO user_roles_v1;
    CREATE TABLE user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role_code TEXT NOT NULL,
      organization_id INTEGER REFERENCES organizations(id),
      effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      effective_to TEXT,
      granted_by INTEGER REFERENCES users(id),
      CHECK(effective_to IS NULL OR effective_to >= effective_from)
    );
    INSERT INTO user_roles (user_id, role_code, organization_id, effective_from, effective_to, granted_by)
      SELECT user_id, role_code, organization_id, effective_from, effective_to, granted_by FROM user_roles_v1;
    DROP TABLE user_roles_v1;
    CREATE INDEX idx_roles_user_scope ON user_roles(user_id, role_code, organization_id);
    CREATE INDEX idx_user_roles_effective ON user_roles(user_id, effective_from, effective_to);
    CREATE UNIQUE INDEX idx_user_role_current ON user_roles(user_id, role_code, COALESCE(organization_id, -1)) WHERE effective_to IS NULL;
  `
}, {
  version: 4,
  name: 'structured_business_audit_events',
  sql: `
    CREATE TABLE IF NOT EXISTS business_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id),
      actor_organization_id INTEGER REFERENCES organizations(id),
      organization_id INTEGER REFERENCES organizations(id),
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      action TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      business_version TEXT,
      before_summary_json TEXT,
      after_summary_json TEXT,
      reason TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','failed')),
      request_id TEXT
    );
    CREATE INDEX idx_business_audit_time ON business_audit_events(occurred_at);
    CREATE INDEX idx_business_audit_actor_time ON business_audit_events(actor_user_id, occurred_at);
    CREATE INDEX idx_business_audit_org_time ON business_audit_events(organization_id, occurred_at);
    CREATE INDEX idx_business_audit_object_time ON business_audit_events(object_type, object_id, occurred_at);
    CREATE INDEX idx_business_audit_action_time ON business_audit_events(action, occurred_at);
  `
}, {
  version: 5,
  name: 'field_catalog_lifecycle_and_types',
  sql: `
    ALTER TABLE field_definitions ADD COLUMN semantic_type TEXT NOT NULL DEFAULT 'short_text'
      CHECK(semantic_type IN ('decimal','integer','short_text','long_text','date','datetime','boolean','enum','organization_reference','user_reference'));
    UPDATE field_definitions SET semantic_type = CASE data_type
      WHEN 'decimal' THEN 'decimal' WHEN 'integer' THEN 'integer' WHEN 'boolean' THEN 'boolean'
      WHEN 'date' THEN 'date' WHEN 'json' THEN 'enum' ELSE 'short_text' END;
    ALTER TABLE field_drafts ADD COLUMN supersedes_field_id INTEGER REFERENCES field_definitions(id);
    ALTER TABLE field_drafts ADD COLUMN base_field_version INTEGER;
    CREATE TABLE field_draft_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL REFERENCES field_drafts(id),
      revision INTEGER NOT NULL,
      proposal_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(draft_id, revision)
    );
    CREATE TABLE field_definition_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_definition_id INTEGER NOT NULL REFERENCES field_definitions(id),
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      source_draft_id INTEGER REFERENCES field_drafts(id),
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(field_definition_id, version),
      CHECK(created_by IS NULL OR approved_by IS NULL OR created_by <> approved_by)
    );
    INSERT INTO field_definition_versions (field_definition_id, version, snapshot_json, created_by, approved_by, approved_at)
      SELECT id, version, json_object('id', id, 'version', version, 'code', code, 'displayName', display_name,
        'type', semantic_type, 'unit', unit, 'precision', precision, 'editable', editable,
        'applicability', CASE WHEN json_valid(applicability_json) THEN json(applicability_json) ELSE json('{}') END, 'status', status),
        CASE WHEN created_by = approved_by THEN NULL ELSE created_by END,
        CASE WHEN created_by = approved_by THEN NULL ELSE approved_by END,
        COALESCE(approved_at, created_at)
      FROM field_definitions WHERE status = 'approved';
    ALTER TABLE template_mappings ADD COLUMN field_definition_version_id INTEGER REFERENCES field_definition_versions(id);
    UPDATE template_mappings SET field_definition_version_id = (
      SELECT v.id FROM field_definition_versions v WHERE v.field_definition_id = template_mappings.field_definition_id
      ORDER BY v.version DESC LIMIT 1
    ) WHERE EXISTS (SELECT 1 FROM field_definition_versions v WHERE v.field_definition_id = template_mappings.field_definition_id);
    CREATE INDEX idx_template_mappings_field_version ON template_mappings(field_definition_version_id);
    CREATE TRIGGER validate_template_mapping_field_version_insert
      BEFORE INSERT ON template_mappings WHEN NEW.field_definition_version_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM field_definition_versions v WHERE v.id = NEW.field_definition_version_id AND v.field_definition_id = NEW.field_definition_id
      ) BEGIN SELECT RAISE(ABORT, 'template mapping must pin a matching field definition version'); END;
    CREATE TRIGGER validate_template_mapping_field_version_update
      BEFORE UPDATE OF field_definition_id, field_definition_version_id ON template_mappings
      WHEN NEW.field_definition_version_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM field_definition_versions v WHERE v.id = NEW.field_definition_version_id AND v.field_definition_id = NEW.field_definition_id
      ) BEGIN SELECT RAISE(ABORT, 'template mapping must pin a matching field definition version'); END;
    CREATE INDEX idx_field_drafts_status_created ON field_drafts(status, created_at);
    CREATE INDEX idx_field_draft_revisions_draft ON field_draft_revisions(draft_id, revision);
    CREATE INDEX idx_field_definition_versions_history ON field_definition_versions(field_definition_id, version);
  `
}, {
  version: 6,
  name: 'governed_rule_formula_catalog',
  sql: `
    ALTER TABLE rule_versions ADD COLUMN rule_scope TEXT NOT NULL DEFAULT 'field'
      CHECK(rule_scope IN ('field','cross_field','cross_period','aggregate','anomaly','business_formula'));
    ALTER TABLE rule_versions ADD COLUMN expression_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(expression_schema_version = 1);
    ALTER TABLE rule_versions ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE rule_versions ADD COLUMN test_cases_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE rule_versions ADD COLUMN supersedes_version_id INTEGER REFERENCES rule_versions(id);
    ALTER TABLE rule_versions ADD COLUMN tested_at TEXT;
    ALTER TABLE rule_versions ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN (0,1));
    ALTER TABLE rule_versions ADD COLUMN review_note TEXT;
    CREATE INDEX idx_rule_versions_rule_status ON rule_versions(rule_id, status, version);
    CREATE TRIGGER immutable_published_rule_version_update
      BEFORE UPDATE ON rule_versions WHEN OLD.status = 'published'
      BEGIN SELECT RAISE(ABORT, 'published rule versions are immutable'); END;
    CREATE TRIGGER immutable_published_rule_version_delete
      BEFORE DELETE ON rule_versions WHEN OLD.status = 'published'
      BEGIN SELECT RAISE(ABORT, 'published rule versions are immutable'); END;
  `
}, {
  version: 7,
  name: 'governed_template_component_lifecycle',
  sql: `
    ALTER TABLE template_component_versions ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'draft'
      CHECK(workflow_status IN ('draft','in_review','published','superseded','rejected'));
    ALTER TABLE template_component_versions ADD COLUMN submitted_by INTEGER REFERENCES users(id);
    ALTER TABLE template_component_versions ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
    ALTER TABLE template_component_versions ADD COLUMN review_note TEXT;
    ALTER TABLE template_component_versions ADD COLUMN published_at TEXT;
    ALTER TABLE template_component_versions ADD COLUMN supersedes_version_id INTEGER REFERENCES template_component_versions(id);
    UPDATE template_component_versions SET workflow_status = CASE status
      WHEN 'published' THEN 'published' WHEN 'retired' THEN 'superseded' ELSE 'draft' END;
    UPDATE template_component_versions SET published_at = created_at WHERE workflow_status = 'published';
    CREATE INDEX idx_component_versions_lifecycle ON template_component_versions(component_id, workflow_status, version);
    CREATE INDEX idx_template_versions_lifecycle ON template_versions(template_id, status, version);
    CREATE TRIGGER immutable_published_component_version_update
      BEFORE UPDATE ON template_component_versions WHEN OLD.workflow_status = 'published'
        AND NOT (NEW.workflow_status = 'superseded'
          AND NEW.id = OLD.id AND NEW.component_id = OLD.component_id AND NEW.version = OLD.version
          AND NEW.workbook_json = OLD.workbook_json AND NEW.metadata_json = OLD.metadata_json
          AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at
          AND NEW.submitted_by IS OLD.submitted_by AND NEW.reviewed_by IS OLD.reviewed_by
          AND NEW.review_note IS OLD.review_note AND NEW.published_at IS OLD.published_at
          AND NEW.supersedes_version_id IS OLD.supersedes_version_id)
      BEGIN SELECT RAISE(ABORT, 'published component versions are immutable'); END;
    CREATE TRIGGER immutable_published_component_version_delete
      BEFORE DELETE ON template_component_versions WHEN OLD.workflow_status IN ('published','superseded')
      BEGIN SELECT RAISE(ABORT, 'published component versions are immutable'); END;
    CREATE TRIGGER immutable_published_template_version_update
      BEFORE UPDATE ON template_versions WHEN OLD.status IN ('published','superseded')
        AND NOT (OLD.status = 'published' AND NEW.status = 'superseded'
          AND NEW.id = OLD.id AND NEW.template_id = OLD.template_id AND NEW.version = OLD.version
          AND NEW.manifest_json = OLD.manifest_json AND NEW.workbook_json IS OLD.workbook_json
          AND NEW.created_by = OLD.created_by AND NEW.reviewed_by IS OLD.reviewed_by
          AND NEW.published_at IS OLD.published_at AND NEW.created_at = OLD.created_at)
      BEGIN SELECT RAISE(ABORT, 'published template versions are immutable'); END;
    CREATE TRIGGER immutable_published_template_version_delete
      BEFORE DELETE ON template_versions WHEN OLD.status IN ('published','superseded')
      BEGIN SELECT RAISE(ABORT, 'published template versions are immutable'); END;
    CREATE TRIGGER editable_sheets_only_for_draft_insert
      BEFORE INSERT ON template_sheets WHEN (SELECT status FROM template_versions WHERE id = NEW.template_version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'only draft templates may be edited'); END;
    CREATE TRIGGER editable_sheets_only_for_draft_update
      BEFORE UPDATE ON template_sheets WHEN (SELECT status FROM template_versions WHERE id = OLD.template_version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'only draft templates may be edited'); END;
    CREATE TRIGGER editable_sheets_only_for_draft_delete
      BEFORE DELETE ON template_sheets WHEN (SELECT status FROM template_versions WHERE id = OLD.template_version_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'only draft templates may be edited'); END;
  `
}, {
  version: 8,
  name: 'read_only_auxiliary_template_sheet_content',
  sql: `
    ALTER TABLE template_sheets ADD COLUMN auxiliary_json TEXT NOT NULL DEFAULT '{}';
  `
}, {
  version: 9,
  name: 'collaboration_room_lifecycle_and_snapshot_reference',
  sql: `
    ALTER TABLE collaboration_rooms ADD COLUMN snapshot_reference TEXT;
    ALTER TABLE collaboration_rooms ADD COLUMN frozen_at TEXT;
    ALTER TABLE collaboration_rooms ADD COLUMN closed_at TEXT;
    UPDATE collaboration_rooms
      SET snapshot_reference = collaboration_room_key || '@0'
      WHERE snapshot_reference IS NULL;
    `
}, {
  version: 10,
  name: 'business_submission_value_provenance',
  sql: `
    ALTER TABLE business_values ADD COLUMN unit_snapshot TEXT;
    ALTER TABLE business_values ADD COLUMN precision_snapshot INTEGER NOT NULL DEFAULT 0 CHECK(precision_snapshot BETWEEN 0 AND 12);
    ALTER TABLE business_values ADD COLUMN source_sheet TEXT;
    ALTER TABLE business_values ADD COLUMN source_named_area TEXT;
    ALTER TABLE business_values ADD COLUMN source_row INTEGER;
    ALTER TABLE business_values ADD COLUMN source_column INTEGER;
    ALTER TABLE business_values ADD COLUMN source_collaboration_version INTEGER;
    CREATE INDEX idx_values_revision_source ON business_values(revision_id, source_sheet, source_named_area);
  `
}, {
  version: 11,
  name: 'revision_withdrawal_return_and_timeline',
  sql: `
    ALTER TABLE review_opinions ADD COLUMN remediation_deadline TEXT;
    CREATE TABLE report_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id),
      revision_id INTEGER REFERENCES business_revisions(id), event_type TEXT NOT NULL CHECK(event_type IN
        ('submitted','reviewing','withdrawn','returned','draft_created','resubmitted')),
      actor_user_id INTEGER NOT NULL REFERENCES users(id), reason TEXT, remediation_deadline TEXT,
      from_status TEXT, to_status TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_report_task_events_task ON report_task_events(task_id, created_at, id);
  `
}, {
  version: 12,
  name: 'anomaly_evidence_and_dispositions',
  sql: `
    ALTER TABLE anomaly_snapshots ADD COLUMN record_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE anomaly_snapshots ADD COLUMN triggering_value_json TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN comparison_value_json TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN threshold_json TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN color_classification TEXT NOT NULL DEFAULT 'warning';
    ALTER TABLE anomaly_snapshots ADD COLUMN warning_key TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN rule_code TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN field_code TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN sheet_code TEXT;
    ALTER TABLE anomaly_snapshots ADD COLUMN row_index INTEGER;
    ALTER TABLE anomaly_snapshots ADD COLUMN column_index INTEGER;
    CREATE UNIQUE INDEX idx_anomaly_snapshots_revision_warning_key
      ON anomaly_snapshots(revision_id, warning_key) WHERE warning_key IS NOT NULL;
  `
}, {
  version: 13,
  name: 'revision_scoped_evidence_attachment_metadata',
  sql: `
    ALTER TABLE attachments ADD COLUMN extension TEXT NOT NULL DEFAULT '';
    ALTER TABLE attachments ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(scan_status IN ('pending','clean','rejected','error'));
    ALTER TABLE attachments ADD COLUMN scan_details TEXT;
    CREATE INDEX idx_attachments_task_revision_indicator ON attachments(task_id, revision_id, indicator_code);
    CREATE TRIGGER attachments_indicator_limit_before_insert
      BEFORE INSERT ON attachments
      WHEN NEW.indicator_code IS NOT NULL AND (
        SELECT COUNT(*) FROM attachments WHERE revision_id = NEW.revision_id AND indicator_code = NEW.indicator_code
      ) >= 10
      BEGIN SELECT RAISE(ABORT, 'indicator_attachment_limit'); END;
    CREATE TRIGGER attachments_current_revision_before_insert
      BEFORE INSERT ON attachments
      WHEN (SELECT task_status FROM report_tasks WHERE id = NEW.task_id) != 'draft'
        OR (SELECT current_revision_id FROM report_tasks WHERE id = NEW.task_id) IS NOT NEW.revision_id
        OR (SELECT revision_status FROM business_revisions WHERE id = NEW.revision_id) IS NOT 'draft'
      BEGIN SELECT RAISE(ABORT, 'attachment_revision_locked'); END;
    `
}, {
  version: 14,
  name: 'monthly_review_finalization',
  sql: `
    ALTER TABLE business_revisions ADD COLUMN is_current_effective INTEGER NOT NULL DEFAULT 0 CHECK(is_current_effective IN (0,1));
    ALTER TABLE business_revisions ADD COLUMN finalized_at TEXT;
    CREATE TABLE review_opinion_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      review_item_key TEXT NOT NULL,
      department_code TEXT NOT NULL,
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      opinion TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK(disposition IN ('accept','return','comment')),
      version INTEGER NOT NULL CHECK(version >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(revision_id, review_item_key, department_code)
    );
    CREATE INDEX idx_review_items_revision ON review_opinion_items(revision_id, department_code);
    CREATE UNIQUE INDEX idx_one_current_effective_revision_per_task
      ON business_revisions(task_id) WHERE is_current_effective = 1;
    CREATE INDEX idx_revisions_finalized_history ON business_revisions(task_id, finalized_at, revision_number);
  `
}, {
  version: 15,
  name: 'quarterly_review_scoring',
  sql: `
    CREATE TABLE quarterly_review_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      indicator_id INTEGER NOT NULL REFERENCES task_indicators(id),
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_review','approved','returned')),
      opinion TEXT,
      remediation_deadline TEXT,
      version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(revision_id, indicator_id)
    );
    CREATE INDEX idx_quarterly_review_revision_status ON quarterly_review_items(revision_id, status);
    CREATE TABLE quarterly_adjustment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('reward','penalty')),
      amount_decimal TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      decided_by INTEGER REFERENCES users(id),
      decision_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_at TEXT
    );
    CREATE INDEX idx_quarterly_adjustments_revision_status ON quarterly_adjustment_requests(revision_id, status);
    CREATE TABLE quarterly_indicator_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL REFERENCES business_revisions(id),
      indicator_id INTEGER NOT NULL REFERENCES task_indicators(id),
      scorer_id INTEGER NOT NULL REFERENCES users(id),
      score_decimal TEXT NOT NULL,
      score_source TEXT NOT NULL CHECK(score_source IN ('manual','formula','exempt')),
      formula_version_id INTEGER REFERENCES rule_versions(id),
      comment TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(revision_id, indicator_id)
    );
    CREATE INDEX idx_quarterly_scores_revision ON quarterly_indicator_scores(revision_id);
    ALTER TABLE report_rankings ADD COLUMN redemption_coefficient_decimal TEXT;
  `
}, {
  version: 16,
  name: 'monthly_adjustment_workflow_and_quarterly_impacts',
  sql: `
    ALTER TABLE adjustment_requests ADD COLUMN changed_fields_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE adjustment_requests ADD COLUMN required_departments_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE adjustment_requests ADD COLUMN submitted_at TEXT;
    ALTER TABLE adjustment_requests ADD COLUMN applied_at TEXT;
    ALTER TABLE adjustment_requests ADD COLUMN rejected_at TEXT;
    CREATE TABLE monthly_adjustment_impacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_request_id INTEGER NOT NULL REFERENCES adjustment_requests(id),
      monthly_task_id INTEGER NOT NULL REFERENCES report_tasks(id),
      quarterly_task_id INTEGER NOT NULL REFERENCES report_tasks(id),
      quarterly_revision_id INTEGER REFERENCES business_revisions(id),
      status TEXT NOT NULL CHECK(status IN ('pending_confirmation','confirmed','requires_adjustment')),
      before_json TEXT NOT NULL DEFAULT '{}', after_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT,
      UNIQUE(adjustment_request_id, quarterly_task_id)
    );
    CREATE INDEX idx_monthly_adjustment_impacts_quarterly ON monthly_adjustment_impacts(quarterly_task_id, status);
  `
}, {
  version: 17,
  name: 'task_operations_and_reminder_governance',
  sql: `
    CREATE TABLE report_type_reminder_schedules (
      report_type_id INTEGER PRIMARY KEY REFERENCES report_types(id),
      schedule_json TEXT NOT NULL DEFAULT '{"daysBefore":[3,1],"deadlineMorning":true,"dailyAfterExpiry":true}',
      updated_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE task_reminder_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES report_tasks(id),
      user_id INTEGER NOT NULL REFERENCES users(id), reminder_key TEXT NOT NULL,
      notification_id INTEGER NOT NULL REFERENCES notifications(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, user_id, reminder_key)
    );
    CREATE TABLE task_cancellations (
      task_id INTEGER PRIMARY KEY REFERENCES report_tasks(id), cancelled_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL, cancelled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_task_reminder_deliveries_task ON task_reminder_deliveries(task_id, reminder_key);
  `
}, {
  version: 18,
  name: 'export_job_business_version_snapshot',
  sql: `
    ALTER TABLE export_jobs ADD COLUMN snapshot_manifest_json TEXT NOT NULL DEFAULT '{}';
  `
}, {
  version: 19,
  name: 'retention_and_referenced_object_delete_guards',
  sql: `
    CREATE TRIGGER protect_business_audit_events_from_delete
      BEFORE DELETE ON business_audit_events
      BEGIN SELECT RAISE(ABORT, 'business audit events are retained'); END;
    CREATE TRIGGER protect_legacy_audit_logs_from_delete
      BEFORE DELETE ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'audit logs are retained'); END;
    CREATE TRIGGER protect_official_artifacts_from_delete
      BEFORE DELETE ON official_artifacts
      BEGIN SELECT RAISE(ABORT, 'official artifacts are retained'); END;
    CREATE TRIGGER protect_attachments_from_delete
      BEFORE DELETE ON attachments
      BEGIN SELECT RAISE(ABORT, 'evidence attachments are retained'); END;
    CREATE TRIGGER protect_submitted_business_values_from_delete
      BEFORE DELETE ON business_values
      WHEN (SELECT revision_status FROM business_revisions WHERE id = OLD.revision_id) <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'submitted business values are retained'); END;
    CREATE TRIGGER protect_submitted_or_referenced_revisions_from_delete
      BEFORE DELETE ON business_revisions
      WHEN OLD.revision_status <> 'draft'
        OR EXISTS (SELECT 1 FROM report_tasks WHERE current_revision_id = OLD.id)
        OR EXISTS (SELECT 1 FROM business_revisions WHERE source_revision_id = OLD.id)
        OR EXISTS (SELECT 1 FROM official_artifacts WHERE revision_id = OLD.id)
        OR EXISTS (SELECT 1 FROM attachments WHERE revision_id = OLD.id)
        OR EXISTS (SELECT 1 FROM business_values WHERE revision_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'submitted or referenced business revisions are retained'); END;
    CREATE TRIGGER protect_active_or_referenced_tasks_from_delete
      BEFORE DELETE ON report_tasks
      WHEN OLD.task_status <> 'draft'
        OR EXISTS (SELECT 1 FROM business_revisions WHERE task_id = OLD.id)
        OR EXISTS (SELECT 1 FROM collaboration_rooms WHERE task_id = OLD.id)
        OR EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'active or referenced report tasks are retained'); END;
    CREATE TRIGGER protect_active_or_referenced_packages_from_delete
      BEFORE DELETE ON period_packages
      WHEN OLD.status <> 'draft' OR EXISTS (SELECT 1 FROM report_tasks WHERE package_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'activated or referenced packages are retained'); END;
    CREATE TRIGGER protect_referenced_template_versions_from_delete
      BEFORE DELETE ON template_versions
      WHEN OLD.status <> 'draft'
        OR EXISTS (SELECT 1 FROM period_packages WHERE template_version_id = OLD.id)
        OR EXISTS (SELECT 1 FROM report_tasks WHERE template_version_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'published or referenced template versions are retained'); END;
    CREATE TRIGGER protect_published_or_referenced_templates_from_delete
      BEFORE DELETE ON templates
      WHEN OLD.status <> 'draft'
        OR EXISTS (SELECT 1 FROM template_versions WHERE template_id = OLD.id)
        OR EXISTS (SELECT 1 FROM reports WHERE template_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'published or referenced templates are retained'); END;
    CREATE TRIGGER protect_non_draft_legacy_reports_from_delete
      BEFORE DELETE ON reports
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'only unsubmitted report drafts may be deleted'); END;
    CREATE TRIGGER protect_referenced_datasources_from_delete
      BEFORE DELETE ON datasources
      WHEN EXISTS (SELECT 1 FROM reports WHERE datasource_id = OLD.id)
        OR EXISTS (SELECT 1 FROM templates WHERE datasource_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'referenced data sources are retained'); END;
    CREATE TRIGGER protect_nonempty_collaboration_rooms_from_delete
      BEFORE DELETE ON collaboration_rooms
      WHEN OLD.latest_version > 0 OR EXISTS (
        SELECT 1 FROM business_revisions r WHERE r.collaboration_room_id = OLD.id AND r.revision_status <> 'draft')
      BEGIN SELECT RAISE(ABORT, 'nonempty or submitted collaboration rooms are retained'); END;
  `
}];

// Incomplete editor input is kept separately from task-generating packages.
businessMigrations.push({
  version: 20,
  name: 'period_package_editor_drafts',
  sql: `CREATE TABLE period_package_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER UNIQUE REFERENCES period_packages(id),
    input_json TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`
});

businessMigrations.push({
  version: 21,
  name: 'custom_roles_and_effective_capabilities',
  sql: `
    CREATE TABLE custom_roles (
      code TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      scope_type TEXT NOT NULL CHECK(scope_type IN ('global','organization')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE custom_role_capabilities (
      role_code TEXT NOT NULL REFERENCES custom_roles(code), capability_code TEXT NOT NULL,
      PRIMARY KEY(role_code, capability_code)
    );
    CREATE VIEW effective_user_roles AS
      SELECT ur.* FROM user_roles ur LEFT JOIN custom_roles cr ON cr.code = ur.role_code
        WHERE cr.code IS NULL OR cr.status = 'active'
      UNION ALL
      SELECT ur.id, ur.user_id, cp.capability_code AS role_code, ur.organization_id,
        ur.effective_from, ur.effective_to, ur.granted_by
      FROM user_roles ur JOIN custom_roles cr ON cr.code = ur.role_code AND cr.status = 'active'
        JOIN custom_role_capabilities cp ON cp.role_code = cr.code;
  `
});

businessMigrations.push({
  version: 22,
  name: 'workflow_notification_delivery_cursor',
  sql: `
    CREATE TABLE workflow_notification_cursor (id INTEGER PRIMARY KEY CHECK(id=1), audit_id INTEGER NOT NULL DEFAULT 0);
    INSERT INTO workflow_notification_cursor(id,audit_id) VALUES(1,0);
    CREATE TABLE workflow_notification_deliveries (
      audit_id INTEGER NOT NULL REFERENCES business_audit_events(id), user_id INTEGER NOT NULL REFERENCES users(id),
      notification_id INTEGER NOT NULL REFERENCES notifications(id), task_key INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(audit_id,user_id,task_key)
    );
  `
});

businessMigrations.push({
  version: 23,
  name: 'revision_frontend_validation_snapshot',
  sql: `CREATE TABLE revision_validation_snapshots (
    revision_id INTEGER PRIMARY KEY REFERENCES business_revisions(id),
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    collaboration_version INTEGER NOT NULL,
    report_json TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`
});

businessMigrations.push({
  version: 24,
  name: 'retire_unused_template_sync_and_scoring_tables',
  // These tables have no remaining runtime consumers. Back up existing databases
  // before upgrading; template_syncs must be dropped before its parent table.
  sql: `
    DROP TABLE IF EXISTS template_syncs;
    DROP TABLE IF EXISTS template_changes;
    DROP TABLE IF EXISTS indicator_scores;
    DROP TABLE IF EXISTS score_adjustments;
  `
});

const collaborationMigrations = [{
  version: 1,
  name: 'v1_collaboration_storage',
  sql: `
    CREATE TABLE IF NOT EXISTS collaboration_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_key TEXT NOT NULL UNIQUE, task_id INTEGER NOT NULL,
      revision_number INTEGER NOT NULL, room_status TEXT NOT NULL DEFAULT 'open', current_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id, revision_number)
    );
    CREATE TABLE IF NOT EXISTS collaboration_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES collaboration_rooms(id), version INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL, operation_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, version)
    );
    CREATE TABLE IF NOT EXISTS collaboration_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES collaboration_rooms(id), version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id, version)
    );
    CREATE TABLE IF NOT EXISTS collaboration_presence (
      room_id INTEGER NOT NULL REFERENCES collaboration_rooms(id), actor_user_id INTEGER NOT NULL, presence_json TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(room_id, actor_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collab_operations_room_version ON collaboration_operations(room_id, version);
    CREATE INDEX IF NOT EXISTS idx_collab_snapshots_room_version ON collaboration_snapshots(room_id, version);
  `
}, {
  version: 2,
  name: 'spreadjs_ot_and_persistent_milestone_storage',
  sql: `
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, version INTEGER NOT NULL, snapshot_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      doc_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL,
      PRIMARY KEY (doc_id, version), FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS snapshot_fragments (
      doc_id TEXT NOT NULL, fragment_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (doc_id, fragment_id), FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS collaboration_milestones (
      doc_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (doc_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_collab_milestones_version ON collaboration_milestones(doc_id, version);
  `
}, {
  version: 3,
  name: 'collaboration_operation_retention_summaries',
  sql: `
    CREATE TABLE IF NOT EXISTS collaboration_operation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES collaboration_rooms(id),
      from_version INTEGER NOT NULL, through_version INTEGER NOT NULL, operation_count INTEGER NOT NULL,
      versions_json TEXT NOT NULL, actor_counts_json TEXT NOT NULL, compacted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(from_version > 0 AND through_version >= from_version AND operation_count > 0),
      UNIQUE(room_id, from_version, through_version)
    );
    CREATE INDEX IF NOT EXISTS idx_collab_operation_summaries_room_version
      ON collaboration_operation_summaries(room_id, from_version, through_version);
  `
}];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) {
    if (error) reject(error); else resolve(this);
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

async function addLegacyCompatibilityColumns(db) {
  const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table'");
  const existingTables = new Set(tables.map(row => row.name));
  const legacyColumns = {
    users: [
      ['organization_id', 'INTEGER'], ['account_status', "TEXT NOT NULL DEFAULT 'active'"],
      ['identity_provider', "TEXT NOT NULL DEFAULT 'local'"], ['identity_subject', 'TEXT'], ['email', 'TEXT']
    ],
    reports: [['factory', 'TEXT']],
    audit_logs: [
      ['actor_user_id', 'INTEGER'], ['organization_id', 'INTEGER'], ['entity_type', 'TEXT'],
      ['entity_id', 'TEXT'], ['request_id', 'TEXT'], ['details_json', 'TEXT']
    ]
  };
  for (const [table, columns] of Object.entries(legacyColumns)) {
    if (!existingTables.has(table)) continue;
    const present = new Set((await all(db, `PRAGMA table_info(${table})`)).map(column => column.name));
    for (const [column, definition] of columns) {
      if (!present.has(column)) await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

async function migrate(db, migrations) {
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = await all(db, 'SELECT version FROM schema_migrations');
  const versions = new Set(applied.map(row => row.version));
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    await run(db, 'BEGIN IMMEDIATE');
    try {
      if (migration.version === 1 && migrations === businessMigrations) await addLegacyCompatibilityColumns(db);
      await new Promise((resolve, reject) => db.exec(migration.sql, error => error ? reject(error) : resolve()));
      await run(db, 'INSERT INTO schema_migrations(version, name) VALUES (?, ?)', [migration.version, migration.name]);
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => {});
      throw error;
    }
  }
  const installed = await get(db, 'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  return installed.version;
}

function openDatabase(filePath, migrations) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const connection = new sqlite3.Database(filePath);
  const ready = new Promise((resolve, reject) => {
    connection.once('open', async () => {
      try { resolve(await migrate(connection, migrations)); }
      catch (error) { reject(error); }
    });
    connection.once('error', reject);
  });
  ready.catch(error => console.error(`SQLite migration failed (${filePath}):`, error));
  return { connection, ready };
}

const templateDir = getTemplateDirectory();
if (path.resolve(getDatabasePath()) === path.resolve(getCollaborationDatabasePath())) {
  throw new Error('Business and collaboration databases must use separate SQLite files.');
}
fs.mkdirSync(templateDir, { recursive: true });
const business = openDatabase(getDatabasePath(), businessMigrations);
const collaboration = openDatabase(getCollaborationDatabasePath(), collaborationMigrations);

module.exports = business.connection;
module.exports.ready = Promise.all([business.ready, collaboration.ready]);
module.exports.collaborationDb = collaboration.connection;
module.exports.getSchemaVersion = async () => {
  await module.exports.ready;
  const row = await get(business.connection, 'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  return row.version;
};
module.exports.openDatabase = openDatabase;
module.exports.migrations = { businessMigrations, collaborationMigrations };
module.exports._helpers = { run, get, all, migrate };
