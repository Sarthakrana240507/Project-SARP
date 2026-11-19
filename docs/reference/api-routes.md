# HTTP API reference (generated)

Generated from the route files by `backend/scripts/gen-reference.js`. Access is the guard the code applies; the database role is always the source of truth.

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/health` | Public | Liveness check (no secrets, no database access). |
| `PUT` | `/auth/profile/photo` | Signed in | (multipart, field "photo") - upload or replace. |
| `DELETE` | `/auth/profile/photo` | Signed in | back to the initials avatar. |
| `GET` | `/auth/profile/photo` | Signed in | the signed-in user's own photo (404 when there is none). |
| `POST` | `/auth/register` | Public | CLOSED. |
| `POST` | `/auth/login` | Public |  |
| `GET` | `/auth/me` | Signed in |  |
| `PUT` | `/auth/profile` | Signed in |  |
| `PUT` | `/auth/preferences` | Signed in |  |
| `PUT` | `/auth/change-password` | Signed in |  |
| `GET` | `/auth/config` | Public | public, non-sensitive capability flags used to tailor UI messages. |
| `POST` | `/auth/token-info` | Public | lets the activation/reset page show who the link is for. |
| `POST` | `/auth/activate` | Public | verifies the invitation token, sets the password, activates the account. |
| `POST` | `/auth/request-activation` | Public | (Method B: verified self-registration) |
| `POST` | `/auth/forgot-password` | Public | never reveals whether an account exists. |
| `POST` | `/auth/reset-password` | Public | consumes a reset token and revokes all existing sessions. |
| `GET` | `/activities/options` | Signed in | everything the submission form needs, from the database (no hard-coded lists). |
| `POST` | `/activities` | Student | submit a new activity straight for review (proof required). |
| `POST` | `/activities/draft` | Student | save an incomplete activity. Everything is optional, but what is filled in must be valid. |
| `PUT` | `/activities/:id/draft` | Student | change a draft. Only drafts can be edited; submitted activities change through resubmission. |
| `DELETE` | `/activities/:id` | Student | discard a draft (and its file). Submitted activities are never deleted. |
| `POST` | `/activities/:id/submit-draft` | Student | send a draft for review. Details and proof may be completed in the same request. |
| `PUT` | `/activities/:id/resubmit` | Student | answer a correction request. Creates a NEW version; the earlier version, |
| `GET` | `/activities/mine` | Student |  |
| `GET` | `/activities/pending` | Faculty / Admin |  |
| `GET` | `/activities/history` | Faculty / Admin |  |
| `GET` | `/activities/review/summary` | Faculty / Admin | the faculty dashboard numbers, limited to this reviewer's scope. |
| `GET` | `/activities/:id/audit` | Signed in |  |
| `GET` | `/activities/:id/versions` | Signed in | every submission of this activity (details, proof info, student's note). |
| `GET` | `/activities/:id/proof` | Signed in |  |
| `GET` | `/activities/:id` | Signed in |  |
| `PATCH` | `/activities/:id/approve` | Faculty / Admin |  |
| `PATCH` | `/activities/:id/reject` | Faculty / Admin |  |
| `PATCH` | `/activities/:id/request-correction` | Faculty / Admin |  |
| `GET` | `/analytics/options` | Faculty / Admin | the values the filter controls offer, from the database (never a fixed list). |
| `GET` | `/analytics` | Faculty / Admin |  |
| `GET` | `/analytics/export/csv` | Faculty / Admin | (same filters as the dashboard) |
| `GET` | `/analytics/export/pdf` | Faculty / Admin |  |
| `GET` | `/portfolio/:studentId/data` | Signed in |  |
| `GET` | `/portfolio/:studentId` | Signed in |  |
| `POST` | `/support/tickets` | Signed in | { name, email, category, subject, message } -> 201 ticket |
| `GET` | `/support/tickets` | Signed in | > the caller's own tickets |
| `GET` | `/support/tickets/:ref` | Signed in | (own tickets only; someone else's ticket looks like it does not exist) |
| `GET` | `/admin/support/tickets` | Admin |  |
| `GET` | `/admin/support/tickets/:ref` | Admin |  |
| `PATCH` | `/admin/support/tickets/:ref` | Admin | { status?, admin_notes? } |
| `POST` | `/admin/students/import/preview` | Admin | CSV import step (students) |
| `POST` | `/admin/faculty/import/preview` | Admin | CSV import step (faculty) |
| `POST` | `/admin/students/import/:id/confirm` | Admin | CSV import step (students) |
| `POST` | `/admin/faculty/import/:id/confirm` | Admin | CSV import step (faculty) |
| `POST` | `/admin/students/import/:id/cancel` | Admin | CSV import step (students) |
| `POST` | `/admin/faculty/import/:id/cancel` | Admin | CSV import step (faculty) |
| `GET` | `/admin/imports` | Admin | import history (newest first). |
| `GET` | `/admin/imports/:id` | Admin | one import with its row-level errors. |
| `POST` | `/admin/imports/:id/activation-links` | Admin |  |
| `POST` | `/admin/users/:id/activation-link` | Admin | body: { delivery?: 'EMAIL' \| 'HANDOFF' } |
| `GET` | `/admin/faculty` | Admin |  |
| `GET` | `/admin/faculty/:id` | Admin |  |
| `POST` | `/admin/faculty` | Admin | creates an INVITED faculty account (no password is ever set by an admin). |
| `PUT` | `/admin/faculty/:id` | Admin | name, department, designation, faculty ID. Email is the login identity and is not editable here. |
| `PUT` | `/admin/faculty/:id/scope` | Admin | body: { all: true } \| { departments: [code\|name, ...] } (empty = no access) |
| `GET` | `/admin/administrators` | Admin |  |
| `POST` | `/admin/administrators` | Admin | { name, email, super? } creates an INVITED administrator (activation link via the usual route). |
| `PATCH` | `/admin/administrators/:id/super` | Admin | { super: boolean } |
| `GET` | `/admin/departments` | Admin |  |
| `POST` | `/admin/departments` | Admin |  |
| `PUT` | `/admin/departments/:id` | Admin |  |
| `PATCH` | `/admin/departments/:id/status` | Admin |  |
| `GET` | `/admin/programmes` | Admin |  |
| `POST` | `/admin/programmes` | Admin |  |
| `PUT` | `/admin/programmes/:id` | Admin |  |
| `PATCH` | `/admin/programmes/:id/status` | Admin |  |
| `GET` | `/admin/sessions` | Admin |  |
| `POST` | `/admin/sessions` | Admin |  |
| `PUT` | `/admin/sessions/:id` | Admin |  |
| `PATCH` | `/admin/sessions/:id/set-current` | Admin |  |
| `PATCH` | `/admin/sessions/:id/archive` | Admin | { archived: true\|false } - closes (or reopens) a year for NEW submissions. Records stay. |
| `GET` | `/admin/categories` | Admin |  |
| `POST` | `/admin/categories` | Admin |  |
| `PUT` | `/admin/categories/:id` | Admin |  |
| `PATCH` | `/admin/categories/:id/status` | Admin |  |
| `PATCH` | `/admin/users/:id/academic` | Admin |  |
| `GET` | `/admin/audit` | Admin |  |
| `GET` | `/admin/overview` | Admin |  |
| `GET` | `/admin/users` | Admin |  |
| `PATCH` | `/admin/users/:id/status` | Admin |  |
| `PATCH` | `/admin/users/:id/role` | Admin |  |
| `GET` | `/notifications` | Signed in | > { notifications, unread_count, total, page, limit, pages } |
| `GET` | `/notifications/unread-count` | Signed in | > { unread_count }  (cheap; the bell polls this) |
| `PATCH` | `/notifications/read-all` | Signed in |  |
| `PATCH` | `/notifications/:id/read` | Signed in | (idempotent: marking an already-read notification keeps its first read time) |

91 endpoints.
