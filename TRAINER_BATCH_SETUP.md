# Trainer, Batch & Demo Enrollment Setup

This release adds three account experiences:

- **Admin** — full platform administration plus batch oversight.
- **Trainer** — can manage only batches assigned to that trainer: create a batch, add/remove students, share its invite code, and view progress. Trainers cannot open Admin Panel, edit courses, create users, upload files, or access analytics outside their batches.
- **Student demo** — a public signup creates a `student` account with a single demo course and only its first two subtopics. A trainer can enroll the learner in a batch, or the learner can use a valid batch code, to move from demo access to that batch's course access.

## Before deploying

1. In Hostinger phpMyAdmin, run the complete `MYSQL_MIGRATION.sql` from this package. The v31 section creates `student_access`, `batches`, and `batch_enrollments`; the v32 section adds the student-support profile fields (`country_code`, `country`, `state_region`, and `learning_goal`).
2. Upload/extract the website files and restart the Node.js application.
3. In **Admin Panel → Users**, create trainer accounts by choosing **Trainer** as the role.
4. Sign in as each trainer and open **Trainer Hub** to create batches and select the course for each batch.

## Operational notes

- Existing students are treated as `full` access so this release does not suddenly lock current learners out.
- A new signup starts as `demo` access. The server selects the first active course (by display order) and exposes only the first two subtopics.
- Batch enrollment is server-enforced. The student cannot unlock another course merely by editing a browser URL.
- Admins can open **Batch Oversight** to see all trainers, batches, enrolments and progress. This is oversight, not password sharing or trainer impersonation.
- Invite codes are generated per batch. Trainers may add a student directly by their email or give that learner the code to use from the student dashboard.
