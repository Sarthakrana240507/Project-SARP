# Database schema (generated)

Generated from the live database by `backend/scripts/gen-reference.js`. Do not edit by hand.

Applied migrations: `001_baseline`, `002_user_status`, `003_onboarding`, `004_faculty_scope`, `005_activity_lifecycle`, `006_academic_management`, `007_notifications`, `008_profile_photo`, `009_theme_preference`, `010_support_tickets`

## `academic_sessions`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('academic_sessions_id_seq'::regclass)` |
| `name` | text | no |  |
| `current_semester` | text | no |  |
| `is_current` | boolean | no | `false` |
| `created_at` | timestamp without time zone | yes | `now()` |
| `is_archived` | boolean | no | `false` |

Constraints:
- `academic_sessions_pkey`: PRIMARY KEY (id)
- `academic_sessions_name_key`: UNIQUE (name)

Indexes: `academic_sessions_name_key`, `academic_sessions_one_current`, `academic_sessions_pkey`

## `activities`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('activities_id_seq'::regclass)` |
| `student_id` | integer | yes |  |
| `title` | text | no |  |
| `category` | text | yes |  |
| `description` | text | yes |  |
| `proof_file_path` | text | yes |  |
| `proof_original_name` | text | yes |  |
| `proof_mime_type` | text | yes |  |
| `proof_size` | integer | yes |  |
| `file_hash` | text | yes |  |
| `is_duplicate` | boolean | no | `false` |
| `status` | text | no | `'pending'::text` |
| `reviewer_id` | integer | yes |  |
| `review_remarks` | text | yes |  |
| `correction_notes` | text | yes |  |
| `academic_session` | text | yes |  |
| `semester` | text | yes |  |
| `created_at` | timestamp without time zone | yes | `now()` |
| `reviewed_at` | timestamp without time zone | yes |  |
| `resubmitted_at` | timestamp without time zone | yes |  |
| `activity_date` | date | yes |  |
| `version` | integer | no | `1` |
| `duplicate_of` | integer | yes |  |

Constraints:
- `activities_category_required`: CHECK (((status = 'draft'::text) OR (category IS NOT NULL))) NOT VALID
- `activities_status_valid`: CHECK ((status = ANY (ARRAY['draft'::text, 'pending'::text, 'resubmitted'::text, 'approved'::text, 'rejected'::text, 'correction_requested'::text]))) NOT VALID
- `activities_reviewer_id_fkey`: FOREIGN KEY (reviewer_id) REFERENCES users(id)
- `activities_student_id_fkey`: FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
- `activities_pkey`: PRIMARY KEY (id)

Indexes: `activities_pkey`, `idx_activities_created`, `idx_activities_file_hash`, `idx_activities_hash`, `idx_activities_session`, `idx_activities_status`, `idx_activities_student`, `idx_activities_student_created`, `idx_activities_student_status`

## `activity_versions`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('activity_versions_id_seq'::regclass)` |
| `activity_id` | integer | no |  |
| `version` | integer | no |  |
| `title` | text | no |  |
| `category` | text | yes |  |
| `description` | text | yes |  |
| `activity_date` | date | yes |  |
| `academic_session` | text | yes |  |
| `semester` | text | yes |  |
| `proof_file_path` | text | yes |  |
| `proof_original_name` | text | yes |  |
| `proof_mime_type` | text | yes |  |
| `proof_size` | integer | yes |  |
| `file_hash` | text | yes |  |
| `is_duplicate` | boolean | no | `false` |
| `duplicate_of` | integer | yes |  |
| `note` | text | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |

Constraints:
- `activity_versions_activity_id_fkey`: FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
- `activity_versions_pkey`: PRIMARY KEY (id)
- `activity_versions_activity_id_version_key`: UNIQUE (activity_id, version)

Indexes: `activity_versions_activity_id_version_key`, `activity_versions_pkey`

## `admin_audit_log`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('admin_audit_log_id_seq'::regclass)` |
| `actor_id` | integer | yes |  |
| `actor_label` | text | yes |  |
| `action` | text | no |  |
| `target_type` | text | yes |  |
| `target_id` | text | yes |  |
| `details` | jsonb | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |

Constraints:
- `admin_audit_log_pkey`: PRIMARY KEY (id)

Indexes: `admin_audit_log_pkey`, `idx_admin_audit_action`, `idx_admin_audit_created`

Triggers: `admin_audit_log_no_change`

## `audit_log`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('audit_log_id_seq'::regclass)` |
| `activity_id` | integer | yes |  |
| `student_id` | integer | yes |  |
| `reviewer_id` | integer | yes |  |
| `old_status` | text | no |  |
| `new_status` | text | no |  |
| `remarks` | text | yes |  |
| `created_at` | timestamp without time zone | yes | `now()` |
| `version` | integer | yes |  |

Constraints:
- `audit_log_activity_id_fkey`: FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
- `audit_log_reviewer_id_fkey`: FOREIGN KEY (reviewer_id) REFERENCES users(id)
- `audit_log_student_id_fkey`: FOREIGN KEY (student_id) REFERENCES users(id)
- `audit_log_pkey`: PRIMARY KEY (id)

Indexes: `audit_log_pkey`, `idx_audit_activity`

Triggers: `audit_log_no_change`

## `auth_tokens`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('auth_tokens_id_seq'::regclass)` |
| `user_id` | integer | no |  |
| `purpose` | text | no |  |
| `token_hash` | text | no |  |
| `delivery` | text | no |  |
| `expires_at` | timestamp without time zone | no |  |
| `used_at` | timestamp without time zone | yes |  |
| `revoked_at` | timestamp without time zone | yes |  |
| `created_by` | integer | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |

Constraints:
- `auth_tokens_delivery_check`: CHECK ((delivery = ANY (ARRAY['EMAIL'::text, 'ADMIN_HANDOFF'::text])))
- `auth_tokens_purpose_check`: CHECK ((purpose = ANY (ARRAY['ACTIVATION'::text, 'PASSWORD_RESET'::text])))
- `auth_tokens_created_by_fkey`: FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
- `auth_tokens_user_id_fkey`: FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
- `auth_tokens_pkey`: PRIMARY KEY (id)
- `auth_tokens_token_hash_key`: UNIQUE (token_hash)

Indexes: `auth_tokens_pkey`, `auth_tokens_token_hash_key`, `idx_auth_tokens_user`

## `categories`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('categories_id_seq'::regclass)` |
| `name` | text | no |  |
| `display_name` | text | no |  |
| `is_active` | boolean | no | `true` |
| `created_at` | timestamp without time zone | yes | `now()` |

Constraints:
- `categories_pkey`: PRIMARY KEY (id)
- `categories_name_key`: UNIQUE (name)

Indexes: `categories_name_key`, `categories_pkey`

## `departments`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('departments_id_seq'::regclass)` |
| `code` | text | no |  |
| `name` | text | no |  |
| `is_active` | boolean | no | `true` |
| `created_at` | timestamp without time zone | yes | `now()` |

Constraints:
- `departments_pkey`: PRIMARY KEY (id)
- `departments_code_key`: UNIQUE (code)

Indexes: `departments_code_key`, `departments_pkey`

## `faculty_scopes`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('faculty_scopes_id_seq'::regclass)` |
| `faculty_id` | integer | no |  |
| `department` | text | yes |  |
| `created_by` | integer | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |

Constraints:
- `faculty_scopes_created_by_fkey`: FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
- `faculty_scopes_faculty_id_fkey`: FOREIGN KEY (faculty_id) REFERENCES users(id) ON DELETE CASCADE
- `faculty_scopes_pkey`: PRIMARY KEY (id)

Indexes: `faculty_scopes_pkey`, `faculty_scopes_uq`

## `import_batches`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('import_batches_id_seq'::regclass)` |
| `kind` | text | no | `'STUDENT'::text` |
| `filename` | text | yes |  |
| `uploaded_by` | integer | yes |  |
| `status` | text | no | `'PREVIEW'::text` |
| `total_rows` | integer | no | `0` |
| `valid_rows` | integer | no | `0` |
| `error_rows` | integer | no | `0` |
| `imported_count` | integer | yes |  |
| `failed_count` | integer | yes |  |
| `invites_sent` | integer | no | `0` |
| `invites_failed` | integer | no | `0` |
| `payload` | jsonb | yes |  |
| `errors` | jsonb | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |
| `committed_at` | timestamp without time zone | yes |  |

Constraints:
- `import_batches_status_check`: CHECK ((status = ANY (ARRAY['PREVIEW'::text, 'COMMITTED'::text, 'CANCELLED'::text])))
- `import_batches_uploaded_by_fkey`: FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
- `import_batches_pkey`: PRIMARY KEY (id)

Indexes: `idx_import_batches_created`, `import_batches_pkey`

## `notifications`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('notifications_id_seq'::regclass)` |
| `user_id` | integer | yes |  |
| `title` | text | no |  |
| `message` | text | no |  |
| `type` | text | no | `'info'::text` |
| `link` | text | yes |  |
| `is_read` | boolean | no | `false` |
| `created_at` | timestamp without time zone | yes | `now()` |
| `read_at` | timestamp without time zone | yes |  |

Constraints:
- `notifications_link_chk`: CHECK (((link IS NULL) OR ((link ~~ '/%'::text) AND (link !~~ '//%'::text) AND (link !~~ '%://%'::text)))) NOT VALID
- `notifications_type_chk`: CHECK ((type = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'error'::text]))) NOT VALID
- `notifications_user_id_fkey`: FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
- `notifications_pkey`: PRIMARY KEY (id)

Indexes: `idx_notifications_user`, `idx_notifications_user_created`, `notifications_pkey`

## `programmes`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('programmes_id_seq'::regclass)` |
| `code` | text | no |  |
| `name` | text | no |  |
| `is_active` | boolean | no | `true` |
| `created_at` | timestamp without time zone | no | `now()` |

Constraints:
- `programmes_pkey`: PRIMARY KEY (id)

Indexes: `programmes_code_uq`, `programmes_name_uq`, `programmes_pkey`

## `schema_migrations`

| Column | Type | Null | Default |
|---|---|---|---|
| `name` | text | no |  |
| `applied_at` | timestamp without time zone | no | `now()` |

Constraints:
- `schema_migrations_pkey`: PRIMARY KEY (name)

Indexes: `schema_migrations_pkey`

## `support_tickets`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('support_tickets_id_seq'::regclass)` |
| `ticket_ref` | text | yes |  |
| `user_id` | integer | yes |  |
| `name` | text | no |  |
| `email` | text | no |  |
| `category` | text | no |  |
| `subject` | text | no |  |
| `message` | text | no |  |
| `status` | text | no | `'OPEN'::text` |
| `admin_notes` | text | yes |  |
| `resolved_at` | timestamp without time zone | yes |  |
| `updated_by` | integer | yes |  |
| `created_at` | timestamp without time zone | no | `now()` |
| `updated_at` | timestamp without time zone | no | `now()` |

Constraints:
- `support_tickets_category_chk`: CHECK ((category = ANY (ARRAY['LOGIN'::text, 'ACCOUNT'::text, 'ACTIVITY_SUBMISSION'::text, 'DOCUMENT_UPLOAD'::text, 'VERIFICATION'::text, 'TECHNICAL'::text, 'OTHER'::text])))
- `support_tickets_status_chk`: CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text, 'RESOLVED'::text])))
- `support_tickets_updated_by_fkey`: FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
- `support_tickets_user_id_fkey`: FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
- `support_tickets_pkey`: PRIMARY KEY (id)
- `support_tickets_ticket_ref_key`: UNIQUE (ticket_ref)

Indexes: `idx_support_tickets_status`, `idx_support_tickets_user`, `support_tickets_pkey`, `support_tickets_ticket_ref_key`

## `users`

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | integer | no | `nextval('users_id_seq'::regclass)` |
| `name` | text | no |  |
| `email` | text | no |  |
| `password_hash` | text | yes |  |
| `role` | text | no | `'student'::text` |
| `department` | text | yes |  |
| `enrollment_no` | text | yes |  |
| `academic_year` | text | yes |  |
| `semester` | text | yes |  |
| `is_active` | boolean | no | `true` |
| `created_at` | timestamp without time zone | yes | `now()` |
| `status` | text | no | `'ACTIVE'::text` |
| `password_changed_at` | timestamp without time zone | yes |  |
| `last_login_at` | timestamp without time zone | yes |  |
| `programme` | text | yes |  |
| `invited_at` | timestamp without time zone | yes |  |
| `activated_at` | timestamp without time zone | yes |  |
| `email_verified_at` | timestamp without time zone | yes |  |
| `import_batch_id` | integer | yes |  |
| `employee_id` | text | yes |  |
| `designation` | text | yes |  |
| `is_super_admin` | boolean | no | `false` |
| `profile_image_path` | text | yes |  |
| `profile_image_mime` | text | yes |  |
| `profile_image_updated_at` | timestamp without time zone | yes |  |
| `theme_preference` | text | yes |  |

Constraints:
- `users_active_has_password`: CHECK (((status <> 'ACTIVE'::text) OR (password_hash IS NOT NULL)))
- `users_status_check`: CHECK ((status = ANY (ARRAY['INVITED'::text, 'ACTIVE'::text, 'SUSPENDED'::text])))
- `users_super_admin_is_admin`: CHECK (((NOT is_super_admin) OR (role = 'admin'::text)))
- `users_theme_preference_chk`: CHECK ((theme_preference = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text]))) NOT VALID
- `users_pkey`: PRIMARY KEY (id)
- `users_email_key`: UNIQUE (email)

Indexes: `idx_users_status`, `users_email_key`, `users_email_lower_uq`, `users_employee_id_uq`, `users_pkey`, `users_student_id_uq`

