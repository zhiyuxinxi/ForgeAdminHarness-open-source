-- Delivery Center owns these tables in its dedicated control-plane database.
-- Existing conversation/account state and customer business schemas are unchanged.
CREATE TABLE IF NOT EXISTS delivery_center_projects (
  slug VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  observed_at VARCHAR(32) NOT NULL,
  snapshot_digest CHAR(64) NOT NULL,
  coverage JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_batches (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  name VARCHAR(512) NULL,
  created_at VARCHAR(32) NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id),
  INDEX batches_current (project_slug, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_menus (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  parent_id VARCHAR(191) NULL,
  name VARCHAR(512) NOT NULL,
  sort_order INT UNSIGNED NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id),
  INDEX menus_parent (project_slug, parent_id, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_requirements (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  menu_id VARCHAR(191) NULL,
  page_name VARCHAR(512) NULL,
  name VARCHAR(512) NOT NULL,
  status VARCHAR(64) NOT NULL,
  search_text MEDIUMTEXT NOT NULL,
  content_digest CHAR(64) NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id),
  INDEX requirements_menu (project_slug, is_current, menu_id),
  INDEX requirements_status (project_slug, is_current, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_requirement_versions (
  project_slug VARCHAR(32) NOT NULL,
  requirement_id VARCHAR(191) NOT NULL,
  content_digest CHAR(64) NOT NULL,
  observed_at VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, requirement_id, content_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_requirement_batches (
  project_slug VARCHAR(32) NOT NULL,
  requirement_id VARCHAR(191) NOT NULL,
  batch_id VARCHAR(191) NOT NULL,
  PRIMARY KEY (project_slug, requirement_id, batch_id),
  INDEX requirement_batch_lookup (project_slug, batch_id, requirement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_requirement_sources (
  project_slug VARCHAR(32) NOT NULL,
  requirement_id VARCHAR(191) NOT NULL,
  source_key CHAR(64) NOT NULL,
  batch_id VARCHAR(191) NULL,
  stage_id VARCHAR(191) NULL,
  digest VARCHAR(128) NULL,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, requirement_id, source_key),
  INDEX requirement_source_batch (project_slug, batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_stages (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  content_digest CHAR(64) NOT NULL,
  phase_id VARCHAR(64) NULL,
  batch_id VARCHAR(191) NULL,
  status VARCHAR(64) NOT NULL,
  is_current BOOLEAN NOT NULL,
  created_at VARCHAR(32) NULL,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id, content_digest),
  INDEX stages_phase (project_slug, phase_id, is_current),
  INDEX stages_batch (project_slug, batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_releases (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  version VARCHAR(255) NULL,
  commit_sha VARCHAR(64) NULL,
  environment VARCHAR(128) NULL,
  status VARCHAR(64) NOT NULL,
  released_at VARCHAR(32) NULL,
  content_digest CHAR(64) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id),
  INDEX releases_date (project_slug, released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_release_requirements (
  project_slug VARCHAR(32) NOT NULL,
  release_id VARCHAR(191) NOT NULL,
  requirement_id VARCHAR(191) NOT NULL,
  menu_id VARCHAR(191) NULL,
  search_text MEDIUMTEXT NOT NULL,
  snapshot JSON NOT NULL,
  PRIMARY KEY (project_slug, release_id, requirement_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE IF NOT EXISTS delivery_center_artifacts (
  project_slug VARCHAR(32) NOT NULL,
  id VARCHAR(191) NOT NULL,
  release_id VARCHAR(191) NULL,
  stage_id VARCHAR(191) NULL,
  content_digest CHAR(64) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (project_slug, id),
  INDEX artifacts_release (project_slug, release_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
