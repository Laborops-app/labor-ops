-- Keep the student's name as the academy printed it, so a PDF of the certificate can be made (and re-made).
-- The certificate's verify link is kept in academy_certs.url (added in 027_academy_courses).
ALTER TABLE academy_certs
  ADD COLUMN IF NOT EXISTS student_name text;
